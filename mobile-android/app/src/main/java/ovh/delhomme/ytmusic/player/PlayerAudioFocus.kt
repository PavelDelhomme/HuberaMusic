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
 * Évite de couper Netflix / YouTube lors d’un seek, d’une ouverture d’app ou d’une MAJ.
 */
class PlayerAudioFocus(
    context: Context,
    private val player: () -> Player?,
) {
    private val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var request: AudioFocusRequest? = null
    private var held = false

    private val listener = AudioManager.OnAudioFocusChangeListener { change ->
        val p = player() ?: return@OnAudioFocusChangeListener
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            -> {
                AppLog.i("audio-focus", "loss → pause PLM (autre app média)")
                runCatching { p.pause() }
                held = false
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                // On ne duck pas : on laisse l’autre app ; PLM reste en pause si besoin.
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                /* pas d’auto-resume — l’utilisateur décide */
            }
        }
    }

    fun requestIfNeeded(): Boolean {
        if (held) return true
        val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val attrs = PlatformAudioAttributes.Builder()
                .setUsage(PlatformAudioAttributes.USAGE_MEDIA)
                .setContentType(PlatformAudioAttributes.CONTENT_TYPE_MUSIC)
                .build()
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener(listener)
                .setAcceptsDelayedFocusGain(false)
                .setWillPauseWhenDucked(true)
                .build()
            request = req
            am.requestAudioFocus(req) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(
                listener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN,
            ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
        held = ok
        if (!ok) AppLog.w("audio-focus", "request refused")
        return ok
    }

    fun abandon() {
        if (!held && request == null) return
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
