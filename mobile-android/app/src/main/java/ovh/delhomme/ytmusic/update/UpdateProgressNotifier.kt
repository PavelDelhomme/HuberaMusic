package ovh.delhomme.ytmusic.update

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import ovh.delhomme.ytmusic.MainActivity
import ovh.delhomme.ytmusic.R

/** Notification persistante pendant DL / préparation installateur (le clic Compte ne suffit pas). */
class UpdateProgressNotifier(private val context: Context) {
    private val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Mises à jour PLM",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
                description = "Téléchargement et installation de l’application"
            },
        )
    }

    fun show(title: String, text: String, progress: Int?, indeterminate: Boolean) {
        ensureChannel()
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val b = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_play)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
        when {
            indeterminate -> b.setProgress(100, 0, true)
            progress != null -> b.setProgress(100, progress.coerceIn(0, 100), false)
        }
        nm.notify(NOTIF_ID, b.build())
    }

    fun done(text: String) {
        ensureChannel()
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        nm.notify(
            NOTIF_ID,
            NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_play)
                .setContentTitle("Mise à jour PLM")
                .setContentText(text)
                .setContentIntent(open)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .build(),
        )
    }

    fun cancel() {
        nm.cancel(NOTIF_ID)
    }

    companion object {
        private const val CHANNEL_ID = "plm_apk_update"
        private const val NOTIF_ID = 41001
    }
}
