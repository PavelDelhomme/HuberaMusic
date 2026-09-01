package ovh.delhomme.ytmusic.player

import android.content.Context
import android.media.AudioAttributes as PlatformAudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import androidx.media3.common.Player
import ovh.delhomme.ytmusic.debug.AppLog

/**
 * Focus audio **uniquement** quand PLM lit vraiment.
 * - Appel / interruption courte : pause puis **reprise auto** au GAIN.
 * - Notif système (CAN_DUCK) : baisse le volume puis remonte.
 *
 * Important : ne pas [abandon] pendant une LOSS_TRANSIENT, sinon le GAIN
 * n’arrive jamais et la musique reste coupée après un appel.
 */
class PlayerAudioFocus(
    context: Context,
    private val player: () -> Player?,
) {
    private val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var request: AudioFocusRequest? = null
    private var held = false
    /** Reprendre automatiquement après LOSS_TRANSIENT (appel, GPS, etc.). */
    private var resumeOnGain = false
    /** Focus encore « à nous » en attente du GAIN — ne pas abandonner. */
    private var waitingTransientGain = false
    private var ducked = false
    private var volumeBeforeDuck = 1f

    /** Focus accordé ou en attente (DELAYED) — pas un refus. */
    private var pendingDelayedGain = false

    private val listener = AudioManager.OnAudioFocusChangeListener { change ->
        val p = player() ?: return@OnAudioFocusChangeListener
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                AppLog.i("audio-focus", "LOSS permanent → pause")
                resumeOnGain = false
                waitingTransientGain = false
                unduck(p)
                runCatching { p.pause() }
                held = false
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                val wasPlaying = p.playWhenReady || p.isPlaying
                AppLog.i("audio-focus", "LOSS_TRANSIENT → pause (resumeOnGain=$wasPlaying)")
                resumeOnGain = wasPlaying
                waitingTransientGain = true
                unduck(p)
                runCatching { p.pause() }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                AppLog.i("audio-focus", "CAN_DUCK → volume bas")
                duck(p)
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                AppLog.i("audio-focus", "GAIN resumeOnGain=$resumeOnGain ducked=$ducked delayed=$pendingDelayedGain")
                unduck(p)
                held = true
                waitingTransientGain = false
                pendingDelayedGain = false
                if (resumeOnGain) {
                    resumeOnGain = false
                    runCatching {
                        p.playWhenReady = true
                        p.play()
                    }
                }
            }
        }
    }

    private fun duck(p: Player) {
        if (ducked) return
        volumeBeforeDuck = p.volume.coerceIn(0.05f, 1f)
        ducked = true
        runCatching { p.volume = (volumeBeforeDuck * 0.22f).coerceAtLeast(0.05f) }
    }

    private fun unduck(p: Player) {
        if (!ducked) return
        ducked = false
        runCatching { p.volume = volumeBeforeDuck.coerceIn(0.05f, 1f) }
    }

    fun requestIfNeeded(): Boolean {
        if (held || waitingTransientGain || pendingDelayedGain) return true
        val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val attrs = PlatformAudioAttributes.Builder()
                .setUsage(PlatformAudioAttributes.USAGE_MEDIA)
                .setContentType(PlatformAudioAttributes.CONTENT_TYPE_MUSIC)
                .build()
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener(listener)
                .setAcceptsDelayedFocusGain(true)
                .setWillPauseWhenDucked(false)
                .build()
            request = req
            when (val result = am.requestAudioFocus(req)) {
                AudioManager.AUDIOFOCUS_REQUEST_GRANTED -> {
                    held = true
                    true
                }
                AudioManager.AUDIOFOCUS_REQUEST_DELAYED -> {
                    // Blackview / API 28 : DELAY_OK → ne pas traiter comme refus (sinon pause immédiate).
                    pendingDelayedGain = true
                    resumeOnGain = true
                    AppLog.i("audio-focus", "request DELAYED — attente GAIN")
                    true
                }
                else -> {
                    AppLog.w("audio-focus", "request refused code=$result")
                    false
                }
            }
        } else {
            @Suppress("DEPRECATION")
            (am.requestAudioFocus(
                listener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN,
            ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED).also { granted ->
                held = granted
            }
        }
        if (!ok) AppLog.w("audio-focus", "request refused")
        return ok
    }

    /**
     * Abandonne le focus sauf si on attend un GAIN après interruption système
     * (appel). [force] = destroy / idle.
     */
    fun abandon(force: Boolean = false) {
        if (!force && waitingTransientGain) {
            AppLog.i("audio-focus", "abandon ignoré (attente GAIN après appel)")
            return
        }
        if (!force && pendingDelayedGain) {
            AppLog.i("audio-focus", "abandon ignoré (attente GAIN delayed)")
            return
        }
        if (!held && request == null) return
        resumeOnGain = false
        waitingTransientGain = false
        pendingDelayedGain = false
        player()?.let { unduck(it) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            request?.let { runCatching { am.abandonAudioFocusRequest(it) } }
        } else {
            @Suppress("DEPRECATION")
            runCatching { am.abandonAudioFocus(listener) }
        }
        request = null
        held = false
    }
}
