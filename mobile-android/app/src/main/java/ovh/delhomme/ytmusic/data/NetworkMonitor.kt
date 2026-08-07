package ovh.delhomme.ytmusic.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
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
    @Volatile
    private var pausedForNetwork = false
    private val main = Handler(Looper.getMainLooper())
    private var offlineConfirm: Runnable? = null

    /** Délai avant de confirmer « vraiment hors ligne » (handover 4G/Wi‑Fi). */
    private const val OFFLINE_DEBOUNCE_MS = 1_800L

    fun isOnline(): Boolean = online

    fun markPausedForNetwork() {
        pausedForNetwork = true
    }

    fun start(context: Context) {
        if (!started.compareAndSet(false, true)) return
        val app = context.applicationContext
        val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return
        online = hasUsableInternet(cm)

        val req = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        runCatching {
            cm.registerNetworkCallback(
                req,
                object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) {
                        cancelOfflineConfirm()
                        val wasOffline = !online
                        online = true
                        if (wasOffline) onBackOnline()
                    }

                    override fun onCapabilitiesChanged(
                        network: Network,
                        networkCapabilities: NetworkCapabilities,
                    ) {
                        val ok = networkCapabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        if (ok) {
                            cancelOfflineConfirm()
                            val wasOffline = !online
                            online = true
                            if (wasOffline) onBackOnline()
                        }
                    }

                    override fun onLost(network: Network) {
                        // Handover : un autre réseau peut arriver dans la seconde
                        scheduleOfflineConfirm(cm)
                    }
                },
            )
        }
    }

    private fun hasUsableInternet(cm: ConnectivityManager): Boolean {
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun scheduleOfflineConfirm(cm: ConnectivityManager) {
        cancelOfflineConfirm()
        val r = Runnable {
            val still = hasUsableInternet(cm)
            if (!still) {
                online = false
                onGoneOffline()
            } else {
                online = true
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
    }

    private fun onBackOnline() {
        StreamPrefetcher.markStreamOk()
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
