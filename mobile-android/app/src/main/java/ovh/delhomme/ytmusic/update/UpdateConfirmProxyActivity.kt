package ovh.delhomme.ytmusic.update

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import ovh.delhomme.ytmusic.debug.AppLog

/**
 * Bridge transparent : lance l’écran système « Confirmer l’installation »
 * depuis une Activity (One UI / MIUI / OxygenOS bloquent souvent startActivity
 * depuis un BroadcastReceiver).
 */
class UpdateConfirmProxyActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val confirm = runCatching {
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                intent.getParcelableExtra(EXTRA_CONFIRM, Intent::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(EXTRA_CONFIRM)
            }
        }.getOrNull()
        if (confirm != null) {
            confirm.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP,
            )
            runCatching { startActivity(confirm) }
                .onFailure { AppLog.w("apk-update", "proxy confirm KO: ${it.message}") }
        } else {
            AppLog.w("apk-update", "proxy confirm: EXTRA_CONFIRM manquant")
        }
        finish()
    }

    companion object {
        const val EXTRA_CONFIRM = "ovh.delhomme.ytmusic.EXTRA_CONFIRM_INSTALL"
    }
}
