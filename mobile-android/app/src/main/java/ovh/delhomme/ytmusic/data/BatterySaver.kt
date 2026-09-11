package ovh.delhomme.ytmusic.data

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import ovh.delhomme.ytmusic.debug.AppLog
import ovh.delhomme.ytmusic.player.StreamPrefetcher

/**
 * Suit économiseur d’énergie + niveau batterie et allège l’app **sans couper la lecture**
 * ni supprimer les téléchargements offline :
 * - prefetch stream / clips / pochettes réduit
 * - OfflineKeeper ralenti
 * - ticks UI / sync multi-appareils espacés
 */
object BatterySaver {
    private val _active = MutableStateFlow(false)
    val active: StateFlow<Boolean> = _active.asStateFlow()

    @Volatile private var started = false
    @Volatile private var lastChangeElapsed = 0L
    @Volatile private var batteryPct = 100
    @Volatile private var charging = false
    @Volatile private var powerSave = false

    fun isActive(): Boolean = _active.value

    /** Allègement léger dès ~35 % (ou économiseur) — sans toast. */
    fun isSoft(): Boolean = powerSave || (!charging && batteryPct <= 35)

    fun batteryPercent(): Int = batteryPct

    fun start(context: Context) {
        if (started) return
        started = true
        val app = context.applicationContext
        refresh(app, reason = "boot")
        val filter = IntentFilter().apply {
            addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
            addAction(Intent.ACTION_BATTERY_CHANGED)
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
            addAction(Intent.ACTION_BATTERY_LOW)
            addAction(Intent.ACTION_BATTERY_OKAY)
        }
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                refresh(app, reason = intent?.action ?: "system")
            }
        }
        if (Build.VERSION.SDK_INT >= 33) {
            app.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            app.registerReceiver(receiver, filter)
        }
    }

    fun refresh(context: Context, reason: String = "manual") {
        val app = context.applicationContext
        val pm = app.getSystemService(Context.POWER_SERVICE) as? PowerManager
        powerSave = pm?.isPowerSaveMode == true

        val sticky = app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        if (sticky != null) {
            val level = sticky.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = sticky.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1)
            if (level >= 0) batteryPct = ((level * 100f) / scale).toInt().coerceIn(0, 100)
            val status = sticky.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
            charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL ||
                sticky.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
        }

        // Actif = économiseur système OU batterie faible (hors charge)
        val next = powerSave || (!charging && batteryPct <= 20)
        val prev = _active.value
        if (prev == next && SystemClock.elapsedRealtime() - lastChangeElapsed < 800L) return
        lastChangeElapsed = SystemClock.elapsedRealtime()
        _active.value = next
        if (next) {
            AppLog.i(
                "BatterySaver",
                "ON ($reason) pct=$batteryPct charge=$charging powerSave=$powerSave — prefetch allégé",
            )
            runCatching { StreamPrefetcher.cancelIdle() }
            if (prev != next && reason != "boot") {
                android.os.Handler(android.os.Looper.getMainLooper()).post {
                    android.widget.Toast.makeText(
                        app,
                        "Économie d’énergie — prefetch allégé (données conservées)",
                        android.widget.Toast.LENGTH_SHORT,
                    ).show()
                }
            }
        } else if (prev) {
            AppLog.i("BatterySaver", "OFF ($reason) pct=$batteryPct")
        }
    }

    /** Taille max de couverture demandée à Coil / API thumbs. */
    fun coverSizeHint(requested: Int): Int {
        if (!isActive()) return requested
        return requested.coerceAtMost(120).coerceAtLeast(48)
    }

    fun allowCoverPrefetch(): Boolean = !isActive()

    fun allowBackgroundDownloads(): Boolean = !isActive()

    /** Nombre de titres à prefetch en avant (stream). */
    fun streamPrefetchAhead(normal: Int): Int {
        if (isActive()) return 1.coerceAtMost(normal)
        if (isSoft()) return (normal / 2).coerceAtLeast(1).coerceAtMost(normal)
        return normal
    }

    /** Prefetch clips vidéo : combien d’avance. */
    fun videoPrefetchAhead(normal: Int = 5): Int {
        if (isActive()) return 1
        if (isSoft()) return 2.coerceAtMost(normal)
        return normal
    }

    fun videoPrefetchHeadBytes(normal: Long): Long {
        if (isActive()) return (normal * 0.35).toLong().coerceAtLeast(700L * 1024L)
        if (isSoft()) return (normal * 0.55).toLong().coerceAtLeast(1_200L * 1024L)
        return normal
    }

    fun videoPrefetchParallel(normal: Int = 2): Int {
        if (isActive()) return 1
        if (isSoft()) return 1
        return normal
    }

    /** Intervalle tick UI Now Playing (ms). */
    fun nowPlayingTickMs(lyrics: Boolean, playing: Boolean): Long = when {
        lyrics && playing -> if (isActive()) 90L else if (isSoft()) 64L else 48L
        playing -> if (isActive()) 1_000L else if (isSoft()) 650L else 400L
        else -> if (isActive()) 2_500L else if (isSoft()) 1_600L else 1_200L
    }

    /** Sync position clip ↔ titre (ms). */
    fun videoSyncPollMs(playing: Boolean): Long = when {
        !playing -> if (isActive()) 900L else if (isSoft()) 700L else 450L
        isActive() -> 480L
        isSoft() -> 360L
        else -> 280L
    }

    /** Heartbeat session multi-appareils pendant lecture. */
    fun sessionHeartbeatMs(): Long = when {
        isActive() -> 12_000L
        isSoft() -> 7_000L
        else -> 4_000L
    }

    /** Miroir timeline remote en pause. */
    fun remoteMirrorPollMs(): Long = when {
        isActive() -> 6_000L
        isSoft() -> 3_500L
        else -> 2_000L
    }

    /** Mini-bar tick hors Now Playing. */
    fun miniBarTickMs(expanded: Boolean): Long = when {
        isActive() -> if (expanded) 900L else 750L
        isSoft() -> if (expanded) 650L else 550L
        else -> if (expanded) 500L else 400L
    }

    /** Coupe prefetch réseau plus tôt en pause BG. */
    fun idleNetworkCutMs(): Long = when {
        isActive() -> 8 * 60_000L
        isSoft() -> 12 * 60_000L
        else -> 20 * 60_000L
    }
}
