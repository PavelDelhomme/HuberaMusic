package ovh.delhomme.ytmusic.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import ovh.delhomme.ytmusic.YtMusicApp
import ovh.delhomme.ytmusic.debug.AppLog

/**
 * Reçoit le statut PackageInstaller **et** [Intent.ACTION_MY_PACKAGE_REPLACED].
 *
 * Le receiver dynamique (in-process) meurt avec l’ancien process au remplacement
 * du paquet : sans entrée manifeste, STATUS_SUCCESS n’arrive jamais et PLM
 * ne se relance pas. Celui-ci survit dans l’APK **nouvelle**.
 */
class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val appCtx = context.applicationContext
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            AppLog.i("apk-update", "MY_PACKAGE_REPLACED → réouverture")
            // goAsync : laisse le temps aux alarmes / notifs avant que le receiver meure
            val pending = goAsync()
            try {
                UpdateRelaunch.relaunch(appCtx)
            } finally {
                // Petit délai pour que AlarmManager enregistre les triggers
                android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                    runCatching { pending.finish() }
                }, 800L)
            }
            return
        }
        val status = intent.getIntExtra(
            PackageInstaller.EXTRA_STATUS,
            PackageInstaller.STATUS_FAILURE,
        )
        AppLog.i("apk-update", "install broadcast status=$status action=${intent.action}")
        val mgr = runCatching { YtMusicApp.instance.container.apkUpdateManager }.getOrNull()
        if (mgr != null) {
            mgr.onInstallerStatus(context, intent)
            return
        }
        if (status == PackageInstaller.STATUS_SUCCESS) {
            UpdateRelaunch.relaunch(appCtx)
        } else if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            UpdateRelaunch.startConfirmIntent(context, intent)
        }
    }
}
