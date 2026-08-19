package ovh.delhomme.ytmusic.player

import android.media.audiofx.Equalizer
import ovh.delhomme.ytmusic.YtMusicApp
import ovh.delhomme.ytmusic.debug.AppLog

/**
 * Égaliseur système (5 bandes UI → bandes matériel).
 * Préférences : SharedPreferences `plm_eq_v1`.
 */
object AudioEqualizer {
    private const val PREFS = "plm_eq_v1"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_GAINS = "gains" // "0,0,0,0,0" millibels UI

    private var fx: Equalizer? = null
    private var sessionId: Int = 0

    /** Indices matériel choisis pour les 5 sliders UI. */
    private var bandMap: IntArray = intArrayOf(0, 0, 0, 0, 0)

    fun isEnabled(): Boolean =
        YtMusicApp.instance.getSharedPreferences(PREFS, 0).getBoolean(KEY_ENABLED, false)

    fun setEnabled(on: Boolean) {
        YtMusicApp.instance.getSharedPreferences(PREFS, 0).edit().putBoolean(KEY_ENABLED, on).apply()
        fx?.enabled = on
    }

    fun uiGains(): IntArray {
        val raw = YtMusicApp.instance.getSharedPreferences(PREFS, 0)
            .getString(KEY_GAINS, "0,0,0,0,0").orEmpty()
        val parts = raw.split(',').mapNotNull { it.trim().toIntOrNull() }
        return IntArray(5) { i -> parts.getOrElse(i) { 0 }.coerceIn(-1200, 1200) }
    }

    fun setUiGain(index: Int, gainMb: Int) {
        val gains = uiGains()
        if (index !in gains.indices) return
        gains[index] = gainMb.coerceIn(-1200, 1200)
        YtMusicApp.instance.getSharedPreferences(PREFS, 0).edit()
            .putString(KEY_GAINS, gains.joinToString(","))
            .apply()
        applyGains(gains)
    }

    fun attach(audioSessionId: Int) {
        if (audioSessionId <= 0) return
        if (sessionId == audioSessionId && fx != null) return
        release()
        sessionId = audioSessionId
        runCatching {
            val eq = Equalizer(0, audioSessionId)
            eq.enabled = isEnabled()
            fx = eq
            val bands = eq.numberOfBands.toInt().coerceAtLeast(1)
            bandMap = IntArray(5) { ui ->
                ((ui.toFloat() / 4f) * (bands - 1)).toInt().coerceIn(0, bands - 1)
            }
            applyGains(uiGains())
            AppLog.i("AudioEqualizer", "attach session=$audioSessionId bands=$bands enabled=${eq.enabled}")
        }.onFailure {
            AppLog.w("AudioEqualizer", "attach failed: ${it.message}")
            release()
        }
    }

    private fun applyGains(gains: IntArray) {
        val eq = fx ?: return
        for (i in gains.indices) {
            val b = bandMap.getOrNull(i) ?: continue
            val range = eq.bandLevelRange
            val min = range[0]
            val max = range[1]
            val level = gains[i].coerceIn(min.toInt(), max.toInt()).toShort()
            runCatching { eq.setBandLevel(b.toShort(), level) }
        }
    }

    fun release() {
        runCatching { fx?.release() }
        fx = null
        sessionId = 0
    }

    fun minMaxMb(): Pair<Int, Int> {
        val eq = fx ?: return -1200 to 1200
        val r = eq.bandLevelRange
        return r[0].toInt() to r[1].toInt()
    }
}
