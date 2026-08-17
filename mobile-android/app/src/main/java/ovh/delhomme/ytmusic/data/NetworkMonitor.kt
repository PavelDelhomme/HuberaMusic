package ovh.delhomme.ytmusic.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import ovh.delhomme.ytmusic.player.PlaybackService
import ovh.delhomme.ytmusic.player.StreamPrefetcher
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Surveille la connectivité :
 * - hors ligne (debounce) → coupe le prefetch
 * - retour en ligne → clear circuit-breaker + reprend si pause réseau
 *
 * Important Wi‑Fi ↔ mobile : `onLost` ne doit pas déclarer offline immédiatement
 * (fenêtre sans réseau valide pendant le handover).
 */
object NetworkMonitor {
    private val started = AtomicBoolean(false)
    @Volatile
    private var online = true
    private val _onlineFlow = MutableStateFlow(true)
    /** UI : collectAsState pour griser la file hors-ligne. */
    val onlineFlow: StateFlow<Boolean> = _onlineFlow.asStateFlow()
    @Volatile
    private var pausedForNetwork = false
    private val main = Handler(Looper.getMainLooper())
    private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var offlineConfirm: Runnable? = null
    private var appContext: Context? = null

    /** Délai avant de confirmer « vraiment hors ligne » (handover 4G/Wi‑Fi). */
    private const val OFFLINE_DEBOUNCE_MS = 3_500L

    fun isOnline(): Boolean = online

    fun markPausedForNetwork() {
        pausedForNetwork = true
    }

    fun start(context: Context) {
        if (!started.compareAndSet(false, true)) return
        val app = context.applicationContext
        appContext = app
        val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return
        online = hasUsableInternet(cm)
        _onlineFlow.value = online

        val req = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (hasUsableInternet(cm)) markOnline()
            }

            override fun onCapabilitiesChanged(
                network: Network,
                networkCapabilities: NetworkCapabilities,
            ) {
                if (isUsableCaps(networkCapabilities) || hasUsableInternet(cm)) markOnline()
            }

            override fun onLost(network: Network) {
                // Handover Wi‑Fi → 4G : le défaut met 1–3 s à basculer, et
                // le cellulaire déjà « available » ne renvoie pas onAvailable.
                scheduleOfflineConfirm(cm)
            }
        }
        runCatching { cm.registerNetworkCallback(req, cb) }
        runCatching { cm.registerDefaultNetworkCallback(cb) }
        // Re-scan périodique : rattrape un 4G déjà là après coupure Wi‑Fi.
        main.post(object : Runnable {
            override fun run() {
                refreshFromSystem(app)
                main.postDelayed(this, 8_000L)
            }
        })
    }

    /** Recalcule depuis ConnectivityManager (DL / lecture ne doivent pas se fier à un flag périmé). */
    fun refreshFromSystem(context: Context? = null): Boolean {
        val app = (context ?: appContext)?.applicationContext ?: return online
        val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return online
        val ok = hasUsableInternet(cm)
        if (ok) markOnline() else if (online) scheduleOfflineConfirm(cm)
        return ok
    }

    /** Wi‑Fi / Ethernet : gros DL OK. 4G/5G : DL manuel oui, mais 1 flux à la fois. */
    fun isUnmeteredPreferred(context: Context): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return false
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    }

    private fun markOnline() {
        cancelOfflineConfirm()
        val wasOffline = !online
        online = true
        _onlineFlow.value = true
        if (wasOffline) onBackOnline()
    }

    private fun isUsableCaps(caps: NetworkCapabilities?): Boolean {
        if (caps == null) return false
        if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return false
        // IMS / MMS : pas de navigation générale
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_IMS)
        ) {
            return false
        }
        if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_MMS) &&
            !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)
        ) {
            return false
        }
        return true
    }

    private fun hasUsableInternet(cm: ConnectivityManager): Boolean {
        val active = cm.activeNetwork
        if (active != null && isUsableCaps(cm.getNetworkCapabilities(active))) return true
        return cm.allNetworks.any { n -> isUsableCaps(cm.getNetworkCapabilities(n)) }
    }

    private fun scheduleOfflineConfirm(cm: ConnectivityManager) {
        cancelOfflineConfirm()
        val r = Runnable {
            val still = hasUsableInternet(cm)
            if (!still) {
                online = false
                _onlineFlow.value = false
                onGoneOffline()
            } else {
                online = true
                _onlineFlow.value = true
            }
        }
        offlineConfirm = r
        main.postDelayed(r, OFFLINE_DEBOUNCE_MS)
    }

    private fun cancelOfflineConfirm() {
        offlineConfirm?.let { main.removeCallbacks(it) }
        offlineConfirm = null
    }

    private fun onGoneOffline() {
        StreamPrefetcher.cancelIdle()
        StreamPrefetcher.markStreamDown(pauseMs = 120_000L)
        // Si le titre courant (ou un suivant) est déjà téléchargé → bascule file:// sans couper
        main.post {
            val exo = PlaybackService.Holder.player ?: return@post
            val container = runCatching { ovh.delhomme.ytmusic.YtMusicApp.instance.container }.getOrNull()
                ?: return@post
            val store = container.offlineStore
            val queue = PlaybackService.Holder.queue
            val curIdx = exo.currentMediaItemIndex.coerceAtLeast(0)
            val curId = exo.currentMediaItem?.mediaId

            fun jumpToOffline(idx: Int) {
                val track = queue.getOrNull(idx) ?: return
                runCatching {
                    // Remplace toute la file : URI locaux prioritaires via streamUrl()
                    val items = queue.map { t ->
                        ovh.delhomme.ytmusic.player.mediaItemFor(
                            t,
                            { id -> container.streamUrl(id) },
                            PlaybackService.Holder.queueTitle,
                        )
                    }
                    val pos = if (idx == curIdx) exo.currentPosition.coerceAtLeast(0L) else 0L
                    exo.setMediaItems(items, idx, pos)
                    exo.prepare()
                    exo.playWhenReady = true
                    exo.play()
                    PlaybackService.Holder.index = idx
                }
            }

            if (!curId.isNullOrBlank() && store.has(curId)) {
                jumpToOffline(curIdx)
                return@post
            }
            val next = (curIdx until queue.size).firstOrNull { store.has(queue[it].id) }
                ?: queue.indices.firstOrNull { store.has(queue[it].id) }
            if (next != null) {
                jumpToOffline(next)
                android.widget.Toast.makeText(
                    ovh.delhomme.ytmusic.YtMusicApp.instance,
                    "Hors ligne — titres non téléchargés ignorés",
                    android.widget.Toast.LENGTH_SHORT,
                ).show()
            } else {
                exo.playWhenReady = false
                runCatching { exo.pause() }
                markPausedForNetwork()
                android.widget.Toast.makeText(
                    ovh.delhomme.ytmusic.YtMusicApp.instance,
                    "Hors ligne — aucun titre téléchargé dans la file",
                    android.widget.Toast.LENGTH_LONG,
                ).show()
            }
            // Relance sync quand le réseau reviendra
            runCatching { container.offlineKeeper.requestSoon("back-soon") }
        }
    }

    private fun onBackOnline() {
        StreamPrefetcher.markStreamOk()
        ovh.delhomme.ytmusic.debug.TelemetryReporter.flushPending()
        runCatching {
            val app = ovh.delhomme.ytmusic.YtMusicApp.instance
            ioScope.launch {
                runCatching { app.container.ensureReachableApiOrFallbackToProd() }
            }
            app.container.offlineKeeper.requestSoon("online")
        }
        main.post {
            val exo = PlaybackService.Holder.player ?: return@post
            if (!pausedForNetwork) return@post
            pausedForNetwork = false
            runCatching {
                if (exo.mediaItemCount > 0 && !exo.isPlaying) {
                    exo.prepare()
                    exo.playWhenReady = true
                    exo.play()
                }
            }
        }
    }
}
