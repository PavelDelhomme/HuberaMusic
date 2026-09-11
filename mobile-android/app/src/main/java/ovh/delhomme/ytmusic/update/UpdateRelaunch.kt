package ovh.delhomme.ytmusic.update

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import ovh.delhomme.ytmusic.MainActivity
import ovh.delhomme.ytmusic.R
import ovh.delhomme.ytmusic.debug.AppLog

object UpdateRelaunch {
    private const val PREFS = "ytm_updates"
    const val KEY_RELAUNCH = "relaunch_after_update"
    private const val KEY_RELAUNCH_AT = "relaunch_after_update_at"
    const val KEY_PENDING_AFTER_PERMISSION = "pending_install_after_permission"
    const val EXTRA_AFTER_UPDATE = "plm_after_apk_update"

    private const val RELAUNCH_NOTIF_CHANNEL = "plm_apk_relaunch"
    private const val RELAUNCH_NOTIF_ID = 41002
    private const val PI_ALARM = 99201
    private const val PI_NOTIF = 99202
    private const val WINDOW_MS = 180_000L

    fun markPending(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_RELAUNCH, true)
            .putLong(KEY_RELAUNCH_AT, System.currentTimeMillis())
            .commit() // commit : doit survivre au kill immédiat du process
    }

    fun consumePending(ctx: Context): Boolean {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_RELAUNCH, false)) return false
        prefs.edit().remove(KEY_RELAUNCH).remove(KEY_RELAUNCH_AT).apply()
        return true
    }

    /** true si une MAJ vient de s’installer (fenêtre 3 min). */
    fun shouldAutoRelaunch(ctx: Context): Boolean {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_RELAUNCH, false)) return false
        val at = prefs.getLong(KEY_RELAUNCH_AT, 0L)
        if (at <= 0L) return true
        return System.currentTimeMillis() - at in 0..WINDOW_MS
    }

    fun clearPending(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_RELAUNCH)
            .remove(KEY_RELAUNCH_AT)
            .apply()
    }

    fun markPendingAfterPermission(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_PENDING_AFTER_PERMISSION, true)
            .apply()
    }

    fun consumePendingAfterPermission(ctx: Context): Boolean {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_PENDING_AFTER_PERMISSION, false)) return false
        prefs.edit().remove(KEY_PENDING_AFTER_PERMISSION).apply()
        return true
    }

    fun extractConfirmIntent(intent: Intent): Intent? {
        val confirm = if (Build.VERSION.SDK_INT >= 33) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(Intent.EXTRA_INTENT)
        } ?: return null
        confirm.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                Intent.FLAG_ACTIVITY_SINGLE_TOP,
        )
        return confirm
    }

    fun startConfirmIntent(ctx: Context, intent: Intent) {
        val confirm = extractConfirmIntent(intent) ?: return
        launchConfirm(ctx, confirm)
    }

    /** Lance via Activity bridge — une seule fois (pas de double startActivity). */
    fun launchConfirm(ctx: Context, confirm: Intent) {
        confirm.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                Intent.FLAG_ACTIVITY_SINGLE_TOP,
        )
        val proxy = Intent(ctx, UpdateConfirmProxyActivity::class.java).apply {
            putExtra(UpdateConfirmProxyActivity.EXTRA_CONFIRM, confirm)
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP,
            )
        }
        runCatching { ctx.startActivity(proxy) }
            .onFailure { e ->
                AppLog.w("apk-update", "proxy start KO: ${e.message} — direct once")
                runCatching { ctx.startActivity(confirm) }
                    .onFailure { e2 -> AppLog.w("apk-update", "confirm install KO: ${e2.message}") }
            }
    }

    fun launchIntent(ctx: Context, targetPackage: String? = null): Intent {
        val pkg = targetPackage?.takeIf { it.isNotBlank() } ?: ctx.packageName
        val launch = Intent(ctx, MainActivity::class.java).apply {
            // Toujours notre MainActivity (même package après replace)
            if (pkg == ctx.packageName) {
                setClass(ctx, MainActivity::class.java)
            } else {
                setPackage(pkg)
                // Autre package (Dev → Prod) : intent lanceur générique
            }
            action = Intent.ACTION_MAIN
            addCategory(Intent.CATEGORY_LAUNCHER)
            putExtra(EXTRA_AFTER_UPDATE, true)
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED,
            )
        }
        if (pkg != ctx.packageName) {
            return ctx.packageManager.getLaunchIntentForPackage(pkg)?.apply {
                putExtra(EXTRA_AFTER_UPDATE, true)
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP or
                        Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED,
                )
            } ?: launch
        }
        return launch
    }

    /**
     * Relance l’app après install.
     * Sur Android 10+ un [BroadcastReceiver] ne peut souvent pas ouvrir une Activity :
     * on combine startActivity + AlarmManager + notification heads-up / plein écran.
     */
    fun relaunch(ctx: Context, targetPackage: String? = null) {
        val appCtx = ctx.applicationContext
        markPending(appCtx)
        val launch = launchIntent(appCtx, targetPackage)
        AppLog.i("apk-update", "relaunch begin pkg=${launch.`package` ?: appCtx.packageName}")

        // PendingIntent.send a souvent le droit BAL (PackageInstaller / alarm) — plus fiable
        // que startActivity depuis un BroadcastReceiver.
        fun firePi(tag: String) {
            runCatching {
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                val pi = PendingIntent.getActivity(appCtx, 99310, launch, flags)
                if (Build.VERSION.SDK_INT >= 34) {
                    val opts = android.app.ActivityOptions.makeBasic().apply {
                        setPendingIntentBackgroundActivityStartMode(
                            android.app.ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED,
                        )
                    }
                    pi.send(appCtx, 0, null, null, null, null, opts.toBundle())
                } else {
                    pi.send()
                }
                AppLog.i("apk-update", "relaunch PI $tag OK")
            }.onFailure {
                AppLog.w("apk-update", "relaunch PI $tag KO: ${it.message}")
            }
        }

        val main = Handler(Looper.getMainLooper())
        fun go(tag: String) {
            runCatching {
                if (Build.VERSION.SDK_INT >= 34) {
                    val opts = android.app.ActivityOptions.makeBasic().apply {
                        setPendingIntentBackgroundActivityStartMode(
                            android.app.ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED,
                        )
                    }
                    appCtx.startActivity(launch, opts.toBundle())
                } else {
                    appCtx.startActivity(launch)
                }
                AppLog.i("apk-update", "relaunch $tag OK")
            }.onFailure {
                AppLog.w("apk-update", "relaunch $tag KO: ${it.message}")
                firePi(tag)
            }
        }
        // Immédiat + très court (Android tue le process vite après replace)
        firePi("t0")
        main.post { go("immédiat") }
        main.postDelayed({ firePi("120ms"); go("120ms") }, 120L)
        main.postDelayed({ firePi("400ms"); go("400ms") }, 400L)

        scheduleAlarmRelaunch(appCtx, launch)
        showRelaunchNotification(appCtx, launch)
    }

    /** Appelé depuis [YtMusicApp.onCreate] si le process redémarre après replace. */
    fun onAppProcessStart(ctx: Context) {
        if (!shouldAutoRelaunch(ctx)) return
        AppLog.i("apk-update", "process start → auto relaunch")
        relaunch(ctx)
    }

    private fun scheduleAlarmRelaunch(ctx: Context, launch: Intent) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pi = PendingIntent.getActivity(ctx, PI_ALARM, launch, flags)
        val now = SystemClock.elapsedRealtime()
        val delays = longArrayOf(200L, 600L, 1_200L)
        for ((i, d) in delays.withIndex()) {
            val trigger = now + d
            val piI = PendingIntent.getActivity(ctx, PI_ALARM + i, launch, flags)
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, piI)
                } else {
                    @Suppress("DEPRECATION")
                    am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, piI)
                }
                AppLog.i("apk-update", "alarm relaunch +${d}ms")
            }.onFailure { e ->
                AppLog.w("apk-update", "alarm exact KO: ${e.message} — inexact")
                runCatching {
                    am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, piI)
                }.onFailure {
                    runCatching { am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pi) }
                }
            }
        }
    }

    private fun showRelaunchNotification(ctx: Context, launch: Intent) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            val existing = nm.getNotificationChannel(RELAUNCH_NOTIF_CHANNEL)
            if (existing == null) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        RELAUNCH_NOTIF_CHANNEL,
                        "Réouverture après MAJ",
                        NotificationManager.IMPORTANCE_HIGH,
                    ).apply {
                        description = "Rouvre PLM juste après une mise à jour"
                        setShowBadge(true)
                        enableVibration(true)
                    },
                )
            }
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val contentPi = PendingIntent.getActivity(ctx, PI_NOTIF, launch, flags)
        val fullPi = PendingIntent.getActivity(ctx, PI_NOTIF + 1, launch, flags)
        val notif = NotificationCompat.Builder(ctx, RELAUNCH_NOTIF_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_play)
            .setContentTitle("PLM mis à jour")
            .setContentText("Touche pour rouvrir — ouverture auto…")
            .setContentIntent(contentPi)
            .setFullScreenIntent(fullPi, true)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setTimeoutAfter(20_000L)
            .build()
        runCatching { nm.notify(RELAUNCH_NOTIF_ID, notif) }
            .onFailure { AppLog.w("apk-update", "relaunch notif KO: ${it.message}") }
        // Remplace aussi la notif « Installée — réouverture… » pour qu’un tap ouvre vraiment
        runCatching {
            nm.notify(
                41001,
                NotificationCompat.Builder(ctx, RELAUNCH_NOTIF_CHANNEL)
                    .setSmallIcon(R.drawable.ic_stat_play)
                    .setContentTitle("Mise à jour PLM")
                    .setContentText("Installée — touche pour ouvrir")
                    .setContentIntent(contentPi)
                    .setAutoCancel(true)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .build(),
            )
        }
    }
}
