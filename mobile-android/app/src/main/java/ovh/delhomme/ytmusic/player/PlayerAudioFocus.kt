package ovh.delhomme.ytmusic.player

import android.content.Context
import android.media.AudioAttributes as PlatformAudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.media3.common.Player
import ovh.delhomme.ytmusic.debug.AppLog

/**
 * Focus audio **uniquement** quand PLM lit vraiment.
 *
 * - Notification, bip système : on baisse le volume puis on le remonte. La lecture
 *   n'est mise en pause que si l'interruption s'éternise.
 * - Appel : pause, puis reprise à la fin. Certains systèmes signalent l'appel comme
 *   une perte *définitive* du focus, ce qui nous sort de la pile audio et fait que
 *   le signal de reprise n'arrive jamais ; on surveille alors la fin de l'appel via
 *   le mode audio du système, qui ne demande aucune autorisation.
 */
class PlayerAudioFocus(
    context: Context,
    private val player: () -> Player?,
) {
    private companion object {
        /** Au-delà, l'interruption n'est plus un simple bip : on met vraiment en pause. */
        const val DUCK_GRACE_MS = 5_000L
        const val CALL_POLL_MS = 1_000L
        /** Fenêtre de revérification du mode audio juste après une perte de focus. */
        const val CALL_PROBE_MS = 2_500L
        const val CALL_PROBE_STEP_MS = 250L
        /** Garde-fou : on n'attend pas la fin d'un appel indéfiniment. */
        const val CALL_WATCH_MAX_MS = 2 * 60 * 60_000L
    }

    private val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val handler = Handler(Looper.getMainLooper())
    private var request: AudioFocusRequest? = null
    private var held = false

    /** Reprendre automatiquement quand le focus revient (appel, GPS, etc.). */
    private var resumeOnGain = false

    /** Focus encore « à nous » en attente du GAIN — ne pas abandonner. */
    private var waitingTransientGain = false
    private var ducked = false
    private var volumeBeforeDuck = 1f

    /** Focus accordé ou en attente (DELAYED) — pas un refus. */
    private var pendingDelayedGain = false

    private var duckTimeout: Runnable? = null
    private var callProbe: Runnable? = null
    private var callWatch: Runnable? = null
    private var callWatchUntilMs = 0L
    /** Horodate nos propres pauses, pour distinguer l'abandon qu'elles déclenchent d'une pause volontaire. */
    private var focusPauseAtMs = 0L

    /** Builds debug uniquement : force la réponse de [inCall] pour rejouer un appel. */
    @Volatile var forcedInCall: Boolean? = null

    private fun inCall(): Boolean {
        forcedInCall?.let { return it }
        val mode = runCatching { am.mode }.getOrDefault(AudioManager.MODE_NORMAL)
        return mode == AudioManager.MODE_IN_CALL ||
            mode == AudioManager.MODE_IN_COMMUNICATION ||
            mode == AudioManager.MODE_RINGTONE
    }

    /** Builds debug uniquement : rejoue une interruption système sans en provoquer une vraie. */
    fun debugDispatch(change: Int) {
        handler.post { listener.onAudioFocusChange(change) }
    }

    private val listener = AudioManager.OnAudioFocusChangeListener { change ->
        val p = player() ?: return@OnAudioFocusChangeListener
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                val call = inCall()
                AppLog.i("audio-focus", "LOSS permanent → pause (appel=$call)")
                cancelDuckTimeout()
                unduck(p)
                val wasPlaying = p.playWhenReady || p.isPlaying
                focusPauseAtMs = android.os.SystemClock.elapsedRealtime()
                runCatching { p.pause() }
                held = false
                if (call) {
                    // Retirés de la pile audio : aucun GAIN ne viendra, il faut guetter
                    // la fin de l'appel nous-mêmes.
                    resumeOnGain = false
                    waitingTransientGain = false
                    if (wasPlaying) watchCallEnd()
                } else {
                    resumeOnGain = false
                    waitingTransientGain = false
                    if (wasPlaying) probeCallAfterLoss(pauseIfCall = false)
                }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                val wasPlaying = p.playWhenReady || p.isPlaying
                waitingTransientGain = true
                if (inCall()) {
                    AppLog.i("audio-focus", "LOSS_TRANSIENT appel → pause")
                    cancelDuckTimeout()
                    unduck(p)
                    resumeOnGain = wasPlaying
                    focusPauseAtMs = android.os.SystemClock.elapsedRealtime()
                    runCatching { p.pause() }
                    if (wasPlaying) watchCallEnd()
                } else {
                    // Bip de notification : baisser plutôt que couper.
                    AppLog.i("audio-focus", "LOSS_TRANSIENT court → volume bas")
                    duck(p)
                    scheduleDuckTimeout(wasPlaying)
                    probeCallAfterLoss(pauseIfCall = wasPlaying)
                }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                AppLog.i("audio-focus", "CAN_DUCK → volume bas")
                duck(p)
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                AppLog.i(
                    "audio-focus",
                    "GAIN resumeOnGain=$resumeOnGain ducked=$ducked delayed=$pendingDelayedGain",
                )
                cancelDuckTimeout()
                cancelCallProbe()
                cancelCallWatch()
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

    /**
     * Le mode audio bascule parfois quelques centaines de millisecondes **après** la perte
     * de focus d'un appel entrant. Sans cette revérification on jouerait par-dessus la
     * sonnerie, ou on manquerait la veille de fin d'appel.
     */
    private fun probeCallAfterLoss(pauseIfCall: Boolean) {
        cancelCallProbe()
        val until = android.os.SystemClock.elapsedRealtime() + CALL_PROBE_MS
        val task = object : Runnable {
            override fun run() {
                if (!inCall()) {
                    if (android.os.SystemClock.elapsedRealtime() < until) {
                        handler.postDelayed(this, CALL_PROBE_STEP_MS)
                    } else {
                        callProbe = null
                    }
                    return
                }
                callProbe = null
                AppLog.i("audio-focus", "appel détecté après la perte de focus")
                cancelDuckTimeout()
                val p = player() ?: return
                if (pauseIfCall) {
                    unduck(p)
                    resumeOnGain = waitingTransientGain
                    focusPauseAtMs = android.os.SystemClock.elapsedRealtime()
                    runCatching { p.pause() }
                }
                watchCallEnd()
            }
        }
        callProbe = task
        handler.postDelayed(task, CALL_PROBE_STEP_MS)
    }

    private fun cancelCallProbe() {
        callProbe?.let { handler.removeCallbacks(it) }
        callProbe = null
    }

    /** L'interruption dure : on passe du volume baissé à une vraie pause. */
    private fun scheduleDuckTimeout(wasPlaying: Boolean) {
        cancelDuckTimeout()
        val task = Runnable {
            duckTimeout = null
            val p = player() ?: return@Runnable
            if (!ducked) return@Runnable
            AppLog.i("audio-focus", "interruption prolongée → pause")
            unduck(p)
            resumeOnGain = wasPlaying
            focusPauseAtMs = android.os.SystemClock.elapsedRealtime()
            runCatching { p.pause() }
            if (wasPlaying && inCall()) watchCallEnd()
        }
        duckTimeout = task
        handler.postDelayed(task, DUCK_GRACE_MS)
    }

    private fun cancelDuckTimeout() {
        duckTimeout?.let { handler.removeCallbacks(it) }
        duckTimeout = null
    }

    /**
     * Guette le retour du mode audio normal, puis redemande le focus et relance.
     * Le mode audio est lisible sans autorisation, contrairement à l'état d'appel.
     */
    private fun watchCallEnd() {
        if (callWatch != null) return
        callWatchUntilMs = System.currentTimeMillis() + CALL_WATCH_MAX_MS
        val task = object : Runnable {
            override fun run() {
                if (System.currentTimeMillis() > callWatchUntilMs) {
                    AppLog.i("audio-focus", "fin d'appel non détectée — abandon de la veille")
                    callWatch = null
                    return
                }
                if (inCall()) {
                    handler.postDelayed(this, CALL_POLL_MS)
                    return
                }
                callWatch = null
                val p = player() ?: return
                AppLog.i("audio-focus", "appel terminé → reprise")
                held = false
                request = null
                if (requestIfNeeded()) {
                    runCatching {
                        p.playWhenReady = true
                        p.play()
                    }
                }
            }
        }
        callWatch = task
        handler.postDelayed(task, CALL_POLL_MS)
    }

    private fun cancelCallWatch() {
        callWatch?.let { handler.removeCallbacks(it) }
        callWatch = null
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
        // Une pause qui n'est pas la nôtre pendant un appel est volontaire : ne pas
        // relancer la musique à la fin de la communication.
        if (!force && (callWatch != null || callProbe != null)) {
            if (android.os.SystemClock.elapsedRealtime() - focusPauseAtMs < 1_500L) {
                AppLog.i("audio-focus", "abandon ignoré (attente fin d'appel)")
                return
            }
            AppLog.i("audio-focus", "pause volontaire pendant l'appel — veille annulée")
        }
        cancelDuckTimeout()
        cancelCallProbe()
        cancelCallWatch()
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
