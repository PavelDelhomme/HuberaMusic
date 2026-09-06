package ovh.delhomme.ytmusic.update

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import ovh.delhomme.ytmusic.debug.AppLog

/**
 * Bridge transparent : lance l’écran système « Confirmer l’installation »
 * depuis une Activity (One UI / MIUI / OxygenOS bloquent souvent startActivity
 * depuis un BroadcastReceiver).
 *
 * Ne doit ouvrir l’écran **qu’une seule fois** (évite recreation / double intent).
 */
class UpdateConfirmProxyActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Recreation (rotation / process) → ne pas relancer une 2ᵉ feuille système
        if (savedInstanceState != null) {
            finish()
            return
        }
        if (intent?.getBooleanExtra(EXTRA_CONSUMED, false) == true) {
            finish()
            return
        }
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
            runCatching {
                startActivity(confirm)
                intent.putExtra(EXTRA_CONSUMED, true)
            }.onFailure { AppLog.w("apk-update", "proxy confirm KO: ${it.message}") }
        } else {
            AppLog.w("apk-update", "proxy confirm: EXTRA_CONFIRM manquant")
        }
        finish()
    }

    companion object {
        const val EXTRA_CONFIRM = "ovh.delhomme.ytmusic.EXTRA_CONFIRM_INSTALL"
        private const val EXTRA_CONSUMED = "ovh.delhomme.ytmusic.EXTRA_CONFIRM_CONSUMED"
    }
}
