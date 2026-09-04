package ovh.delhomme.ytmusic.update

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import ovh.delhomme.ytmusic.debug.AppLog

object UpdateRelaunch {
    private const val PREFS = "ytm_updates"
    const val KEY_RELAUNCH = "relaunch_after_update"

    fun markPending(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_RELAUNCH, true)
            .apply()
    }

    fun consumePending(ctx: Context): Boolean {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_RELAUNCH, false)) return false
        prefs.edit().remove(KEY_RELAUNCH).apply()
        return true
    }

    fun startConfirmIntent(ctx: Context, intent: Intent) {
        val confirm = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_INTENT)
        } ?: return
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { ctx.startActivity(confirm) }
            .onFailure { AppLog.w("apk-update", "confirm install KO: ${it.message}") }
    }

    /** Relance PLM après remplacement du paquet (plusieurs tentatives : OEM tuent vite). */
    fun relaunch(ctx: Context) {
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return
        launch.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED,
        )
        val main = Handler(Looper.getMainLooper())
        fun go(tag: String) {
            runCatching { ctx.startActivity(launch) }
                .onFailure { AppLog.w("apk-update", "relaunch $tag KO: ${it.message}") }
        }
        main.post { go("immédiat") }
        main.postDelayed({ go("400ms") }, 400L)
        main.postDelayed({ go("1.2s") }, 1_200L)
        main.postDelayed({ go("2.5s") }, 2_500L)
    }
}
