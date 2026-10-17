package ovh.delhomme.ytmusic.player

import androidx.media3.common.Player

/**
 * Décide si un retour au premier plan (activité, écran, process) a le droit
 * de faire sortir du son.
 *
 * Lecture effective = READY + isPlaying. Un buffering sans son, une pause
 * (même posée pendant un lag ou un chargement) et un échec de chargement
 * ne comptent pas.
 */
enum class PlaybackPhase {
    Idle,
    Buffering,
    Ready,
    Ended,
    Failed,
}

data class PlaybackObserve(
    val isPlaying: Boolean,
    val playWhenReady: Boolean,
    val phase: PlaybackPhase,
)

object PlaybackResumePolicy {
    fun isEffectivePlay(now: PlaybackObserve): Boolean =
        now.phase == PlaybackPhase.Ready && now.isPlaying && now.playWhenReady

    /**
     * @return true → forcer le silence. false → laisser continuer une lecture
     * déjà effective (y compris un simple rebuffer d’un titre qui jouait).
     */
    fun holdSilenceOnForeground(
        wasEffectivePlay: Boolean,
        userPaused: Boolean,
        now: PlaybackObserve,
    ): Boolean {
        if (userPaused) return true
        if (now.phase == PlaybackPhase.Failed) return true
        if (isEffectivePlay(now)) return false
        if (!wasEffectivePlay) return true
        return false
    }
}

/**
 * Verrou partagé service / focus / UI.
 * Une reprise automatique (rebind, focus, fin de chargement) ne passe que si
 * [mayAutoPlay] est vrai.
 */
object PlaybackResume {
    @Volatile var userPaused: Boolean = false
        private set

    @Volatile var foregroundHeld: Boolean = false
        private set

    @Volatile var wasEffectiveOnBackground: Boolean = false
        private set

    /** Du son est déjà sorti depuis la dernière pause. Un rebuffer peut continuer. */
    @Volatile var heardSincePause: Boolean = false
        private set

    /** Branchement service : annule une reprise focus déjà armée. */
    @Volatile var onUserPause: (() -> Unit)? = null

    fun noteUserPlay() {
        userPaused = false
        foregroundHeld = false
    }

    fun noteAudible() {
        if (!userPaused) heardSincePause = true
    }

    fun noteUserPause() {
        userPaused = true
        foregroundHeld = true
        heardSincePause = false
        onUserPause?.invoke()
    }

    fun mayAutoPlay(): Boolean = !userPaused && !foregroundHeld

    /** L’app quitte le premier plan. Si rien ne jouait vraiment, on bloque la suite. */
    fun onLeaveForeground(effective: Boolean) {
        wasEffectiveOnBackground = effective && !userPaused
        if (userPaused || !effective) foregroundHeld = true
    }

    /**
     * Retour activité / écran / process.
     * @return true si le lecteur doit être remis en pause.
     */
    fun onEnterForeground(now: PlaybackObserve): Boolean {
        val hold = PlaybackResumePolicy.holdSilenceOnForeground(
            wasEffectiveOnBackground,
            userPaused,
            now,
        )
        if (hold || userPaused) foregroundHeld = true
        else if (PlaybackResumePolicy.isEffectivePlay(now)) foregroundHeld = false
        return hold || foregroundHeld
    }
}

internal fun Player.toPlaybackObserve(): PlaybackObserve {
    val phase = when {
        playerError != null -> PlaybackPhase.Failed
        playbackState == Player.STATE_BUFFERING -> PlaybackPhase.Buffering
        playbackState == Player.STATE_READY -> PlaybackPhase.Ready
        playbackState == Player.STATE_ENDED -> PlaybackPhase.Ended
        else -> PlaybackPhase.Idle
    }
    return PlaybackObserve(
        isPlaying = isPlaying,
        playWhenReady = playWhenReady,
        phase = phase,
    )
}

internal fun Player.isEffectivePlayback(): Boolean =
    PlaybackResumePolicy.isEffectivePlay(toPlaybackObserve())
