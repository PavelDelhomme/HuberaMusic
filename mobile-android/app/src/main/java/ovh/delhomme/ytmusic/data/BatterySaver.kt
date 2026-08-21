package ovh.delhomme.ytmusic.data

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import ovh.delhomme.ytmusic.debug.AppLog
import ovh.delhomme.ytmusic.player.StreamPrefetcher

/**
 * Suit le mode Économiseur d’énergie système et allège l’app **sans couper la lecture** :
 * - pas de prefetch pochettes / stream agressif
 * - OfflineKeeper en pause
 * - UI : pochettes réduites / placeholders hors lecteur
 */
object BatterySaver {
    private val _active = MutableStateFlow(false)
    val active: StateFlow<Boolean> = _active.asStateFlow()

    @Volatile private var started = false
    @Volatile private var lastChangeElapsed = 0L

    fun isActive(): Boolean = _active.value

    fun start(context: Context) {
        if (started) return
        started = true
        val app = context.applicationContext
        refresh(app, reason = "boot")
        val filter = IntentFilter(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                refresh(app, reason = "system")
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
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val next = pm?.isPowerSaveMode == true
        val prev = _active.value
        if (prev == next && SystemClock.elapsedRealtime() - lastChangeElapsed < 800L) return
        lastChangeElapsed = SystemClock.elapsedRealtime()
        _active.value = next
        if (next) {
            AppLog.i("BatterySaver", "ON ($reason) — prefetch/covers/offlineKeeper allégés")
            runCatching { StreamPrefetcher.cancelIdle() }
        } else if (prev) {
            AppLog.i("BatterySaver", "OFF ($reason)")
        }
    }

    /** Taille max de couverture demandée à Coil / API thumbs. */
    fun coverSizeHint(requested: Int): Int {
        if (!isActive()) return requested
        return requested.coerceAtMost(120).coerceAtLeast(48)
    }

    /** Prefetch pochettes autorisé ? */
    fun allowCoverPrefetch(): Boolean = !isActive()

    /** Prefetch stream / OfflineKeeper tick autorisé ? */
    fun allowBackgroundDownloads(): Boolean = !isActive()

    /** Nombre de titres à prefetch en avant (stream). */
    fun streamPrefetchAhead(normal: Int): Int {
        if (!isActive()) return normal
        return 1.coerceAtMost(normal)
    }
}
