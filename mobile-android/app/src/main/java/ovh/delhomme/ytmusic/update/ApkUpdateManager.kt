package ovh.delhomme.ytmusic.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import ovh.delhomme.ytmusic.BuildConfig
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.ApkInfoResponse
import ovh.delhomme.ytmusic.debug.AppLog
import ovh.delhomme.ytmusic.player.PlaybackService
import java.io.File
import java.util.Calendar
import java.util.concurrent.TimeUnit

/**
 * Vérifie / télécharge / installe l’APK publiée sur le serveur (`/api/deploy/apk`)
 * — toujours la **dernière** version seule (pas de chaîne d’intermédiaires).
 *
 * « Plus tard » = snooze **temporel** choisi par l’utilisateur (pas un report
 * jusqu’à la prochaine version). Fermer l’app / le dialogue sans choisir
 * ne snooze pas → re-proposition au prochain lancement.
 * Annulation de l’install système → re-proposition immédiate.
 */
class ApkUpdateManager(
    private val context: Context,
    private val container: AppContainer,
) {
    private val prefs = context.getSharedPreferences("ytm_updates", Context.MODE_PRIVATE)

    data class CheckResult(
        val available: Boolean,
        val info: ApkInfoResponse? = null,
        val localCode: Int = BuildConfig.VERSION_CODE,
        val localName: String = BuildConfig.VERSION_NAME,
        val message: String? = null,
    )

    enum class SnoozeOption(val label: String) {
        ONE_HOUR("Dans 1 heure"),
        LATER_TODAY("Plus tard aujourd’hui"),
        TOMORROW("Demain"),
        THREE_DAYS("Dans 3 jours"),
        ONE_WEEK("Dans 1 semaine"),
    }

    fun lastCheckAt(): Long = prefs.getLong(KEY_LAST_CHECK, 0L)

    fun shouldAutoCheck(now: Long = System.currentTimeMillis()): Boolean {
        val last = lastCheckAt()
        return now - last >= PERIODIC_INTERVAL_MS
    }

    /** Report explicite jusqu’à [untilMs] pour la version [versionCode]. */
    fun snoozeUntil(versionCode: Int, untilMs: Long) {
        prefs.edit()
            .putInt(KEY_SNOOZE_CODE, versionCode)
            .putLong(KEY_SNOOZE_UNTIL, untilMs.coerceAtLeast(System.currentTimeMillis()))
            .remove(KEY_REPROMPT_INSTALL)
            .apply()
    }

    fun snooze(option: SnoozeOption, versionCode: Int, now: Long = System.currentTimeMillis()) {
        snoozeUntil(versionCode, resolveSnoozeUntil(option, now))
    }

    fun resolveSnoozeUntil(option: SnoozeOption, now: Long = System.currentTimeMillis()): Long {
        val cal = Calendar.getInstance().apply { timeInMillis = now }
        return when (option) {
            SnoozeOption.ONE_HOUR -> now + TimeUnit.HOURS.toMillis(1)
            SnoozeOption.LATER_TODAY -> {
                // Ce soir 20h ; si déjà passé → +4 h (plafond minuit+1h)
                val tonight = (cal.clone() as Calendar).apply {
                    set(Calendar.HOUR_OF_DAY, 20)
                    set(Calendar.MINUTE, 0)
                    set(Calendar.SECOND, 0)
                    set(Calendar.MILLISECOND, 0)
                }
                when {
                    tonight.timeInMillis > now + TimeUnit.HOURS.toMillis(1) -> tonight.timeInMillis
                    else -> now + TimeUnit.HOURS.toMillis(4)
                }
            }
            SnoozeOption.TOMORROW -> {
                cal.add(Calendar.DAY_OF_YEAR, 1)
                cal.set(Calendar.HOUR_OF_DAY, 10)
                cal.set(Calendar.MINUTE, 0)
                cal.set(Calendar.SECOND, 0)
                cal.set(Calendar.MILLISECOND, 0)
                cal.timeInMillis
            }
            SnoozeOption.THREE_DAYS -> now + TimeUnit.DAYS.toMillis(3)
            SnoozeOption.ONE_WEEK -> now + TimeUnit.DAYS.toMillis(7)
        }
    }

    /** @deprecated Prefer [snooze] — ancien report « jusqu’à prochaine version ». */
    fun dismissForVersion(versionCode: Int) {
        // Soft dismiss : ne plus snoozer définitivement. No-op volontaire.
        AppLog.i("apk-update", "dismiss soft (no permanent snooze) v$versionCode")
    }

    fun isSnoozed(versionCode: Int, now: Long = System.currentTimeMillis()): Boolean {
        if (versionCode <= 0) return false
        val until = prefs.getLong(KEY_SNOOZE_UNTIL, 0L)
        val code = prefs.getInt(KEY_SNOOZE_CODE, 0)
        if (until <= 0L || code != versionCode) return false
        if (now >= until) {
            prefs.edit().remove(KEY_SNOOZE_UNTIL).remove(KEY_SNOOZE_CODE).apply()
            return false
        }
        return true
    }

    fun clearSnooze() {
        prefs.edit().remove(KEY_SNOOZE_UNTIL).remove(KEY_SNOOZE_CODE).apply()
    }

    /** Install système annulée / échouée → forcer une nouvelle proposition. */
    fun markInstallCancelled() {
        prefs.edit()
            .putBoolean(KEY_REPROMPT_INSTALL, true)
            .remove(KEY_SNOOZE_UNTIL)
            .remove(KEY_SNOOZE_CODE)
            .apply()
        AppLog.i("apk-update", "install cancelled → will re-prompt")
    }

    fun consumeRepromptAfterInstall(): Boolean {
        if (!prefs.getBoolean(KEY_REPROMPT_INSTALL, false)) return false
        prefs.edit().remove(KEY_REPROMPT_INSTALL).apply()
        return true
    }

    fun shouldRepromptAfterInstall(): Boolean =
        prefs.getBoolean(KEY_REPROMPT_INSTALL, false)

    fun promptSlotNow(now: Long = System.currentTimeMillis()): String? {
        val cal = Calendar.getInstance().apply { timeInMillis = now }
        val hour = cal.get(Calendar.HOUR_OF_DAY)
        val minute = cal.get(Calendar.MINUTE)
        val mins = hour * 60 + minute
        val morning = 7 * 60
        val evening = 17 * 60
        val half = (WINDOW_HALF_MS / 60_000L).toInt()
        val slotHour = when {
            kotlin.math.abs(mins - morning) <= half -> 7
            kotlin.math.abs(mins - evening) <= half -> 17
            else -> return null
        }
        val day = "%04d-%02d-%02d".format(
            cal.get(Calendar.YEAR),
            cal.get(Calendar.MONTH) + 1,
            cal.get(Calendar.DAY_OF_MONTH),
        )
        return "$day-$slotHour"
    }

    fun alreadyPromptedSlot(slot: String): Boolean =
        prefs.getString(KEY_PROMPTED_SLOT, null) == slot

    fun markPromptedSlot(slot: String) {
        prefs.edit().putString(KEY_PROMPTED_SLOT, slot).apply()
    }

    fun canOfferPromptDialog(now: Long = System.currentTimeMillis()): Boolean {
        val slot = promptSlotNow(now) ?: return false
        return !alreadyPromptedSlot(slot)
    }

    /**
     * Au démarrage / reprise : propose si MAJ dispo et pas en snooze timer.
     * Fermer l’app sans répondre → re-demande ici.
     * Après annulation d’install → aussi ici.
     */
    suspend fun checkOnStartup(): CheckResult {
        val forceReprompt = shouldRepromptAfterInstall()
        val result = check(force = true, respectSnooze = !forceReprompt)
        if (forceReprompt && result.info != null &&
            (result.info.versionCode ?: 0) > BuildConfig.VERSION_CODE
        ) {
            consumeRepromptAfterInstall()
            return result.copy(available = true, message = result.message ?: "Réessayer l’installation")
        }
        if (result.available) return result
        return result
    }

    suspend fun checkOnPullRefresh(): CheckResult {
        val result = check(force = true, respectSnooze = true)
        result.info?.versionCode?.let { remote ->
            prefs.edit()
                .putInt(KEY_LAST_REMOTE_CODE, remote)
                .putString(KEY_LAST_REMOTE_NAME, result.info.versionName ?: "")
                .apply()
        }
        if (!result.available) return result
        // Pull : dialogue seulement dans les fenêtres 7h / 17h (sauf re-prompt install)
        if (shouldRepromptAfterInstall()) {
            consumeRepromptAfterInstall()
            return result
        }
        if (!canOfferPromptDialog()) {
            return result.copy(available = false, message = "MAJ dispo — voir Compte")
        }
        promptSlotNow()?.let { markPromptedSlot(it) }
        return result
    }

    fun cachedRemoteHint(): Pair<Int, String>? {
        val code = prefs.getInt(KEY_LAST_REMOTE_CODE, 0)
        if (code <= 0) return null
        val name = prefs.getString(KEY_LAST_REMOTE_NAME, null).orEmpty()
        return code to name
    }

    suspend fun check(force: Boolean = false, respectSnooze: Boolean = true): CheckResult =
        withContext(Dispatchers.IO) {
            if (!force && !shouldAutoCheck()) {
                return@withContext CheckResult(available = false, message = "check récent")
            }
            runCatching {
                container.ensureFreshToken()
                val info = container.api.apkInfo()
                prefs.edit()
                    .putLong(KEY_LAST_CHECK, System.currentTimeMillis())
                    .putInt(KEY_LAST_REMOTE_CODE, info.versionCode ?: 0)
                    .putString(KEY_LAST_REMOTE_NAME, info.versionName ?: "")
                    .apply()
                val remote = info.versionCode ?: 0
                val local = BuildConfig.VERSION_CODE
                when {
                    info.ready != true ->
                        CheckResult(false, info, local, message = "APK pas encore publiée")
                    remote <= local -> {
                        clearSnooze()
                        prefs.edit().remove(KEY_REPROMPT_INSTALL).apply()
                        CheckResult(
                            false,
                            info,
                            local,
                            message = "À jour — ${BuildConfig.VERSION_NAME}",
                        )
                    }
                    respectSnooze && isSnoozed(remote) ->
                        CheckResult(
                            false,
                            info,
                            local,
                            message = "Reportée jusqu’à plus tard",
                        )
                    else -> {
                        // Migre l’ancien snooze permanent (ignoré désormais)
                        if (prefs.contains(KEY_SNOOZED_CODE)) {
                            prefs.edit().remove(KEY_SNOOZED_CODE).apply()
                        }
                        CheckResult(true, info, local, message = "v$remote disponible")
                    }
                }
            }.getOrElse {
                AppLog.w("apk-update", "check failed: ${it.message}")
                CheckResult(false, message = it.message ?: "Échec vérif")
            }
        }

    /**
     * Télécharge l’APK **courante** puis lance l’installateur (PackageInstaller).
     * Coupe la lecture avant pour éviter ANR / session média zombie (Nothing).
     */
    suspend fun downloadAndInstall(info: ApkInfoResponse? = null): String = withContext(Dispatchers.IO) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !context.packageManager.canRequestPackageInstalls()
        ) {
            withContext(Dispatchers.Main) {
                val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                    .setData(Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            }
            return@withContext "Autorise l’installation pour PLM, puis réessaie"
        }

        // Pause + stop service avant DL (évite ANR + « rien en lecture » + vol Netflix)
        withContext(Dispatchers.Main) {
            runCatching {
                PlaybackService.Holder.player?.pause()
                PlaybackService.Holder.player?.stop()
                context.stopService(Intent(context, PlaybackService::class.java))
            }
        }

        container.ensureFreshToken()
        val meta = container.api.apkInfo()
        if (meta.ready != true) return@withContext "APK pas encore publiée"
        val remote = meta.versionCode ?: 0
        if (remote <= BuildConfig.VERSION_CODE) {
            return@withContext "Déjà à jour — ${BuildConfig.VERSION_NAME}"
        }

        val base = container.resolvedApiBase().trimEnd('/')
        val path = meta.downloadPath?.takeIf { it.startsWith("/") } ?: "/api/deploy/apk"
        val url = meta.downloadUrl?.takeIf {
            it.startsWith("https://") || it.startsWith("http://")
        } ?: "$base$path"

        val dir = File(context.cacheDir, "apk-updates").apply { mkdirs() }
        dir.listFiles()?.forEach { f ->
            if (f.name.startsWith("plm-update-") && f.name != "plm-update-$remote.apk") {
                f.delete()
            }
        }
        val out = File(dir, "plm-update-$remote.apk")
        if (out.exists()) out.delete()

        val req = Request.Builder().url(url).get().build()
        container.httpAuth.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                return@withContext "Téléchargement HTTP ${resp.code}"
            }
            val body = resp.body ?: return@withContext "Réponse vide"
            out.outputStream().use { os ->
                body.byteStream().use { it.copyTo(os) }
            }
        }
        if (out.length() < 1_000_000L) {
            out.delete()
            return@withContext "APK trop petite (${out.length()} o)"
        }
        AppLog.i("apk-update", "downloaded ${out.length()} bytes → install v$remote")
        clearSnooze()
        val ok = runCatching { installViaPackageInstaller(out) }.getOrElse { err ->
            AppLog.w("apk-update", "PackageInstaller KO: ${err.message} — fallback VIEW")
            withContext(Dispatchers.Main) { installApkViaView(out) }
            true
        }
        if (ok) "Installation lancée (v$remote)" else "Échec lancement installateur"
    }

    /** Session PackageInstaller (plus fiable que ACTION_VIEW sur Nothing / Android 14+). */
    private fun installViaPackageInstaller(file: File): Boolean {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            file.inputStream().use { input ->
                session.openWrite("base.apk", 0, file.length()).use { out ->
                    input.copyTo(out)
                    session.fsync(out)
                }
            }
            val action = "${context.packageName}.UPDATE_INSTALL"
            val intent = Intent(action).setPackage(context.packageName)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    PendingIntent.FLAG_MUTABLE
                } else {
                    0
                }
            val pi = PendingIntent.getBroadcast(context, sessionId, intent, flags)
            val filter = IntentFilter(action)
            ContextCompat.registerReceiver(
                context,
                object : BroadcastReceiver() {
                    override fun onReceive(ctx: Context?, intent: Intent?) {
                        val status = intent?.getIntExtra(
                            PackageInstaller.EXTRA_STATUS,
                            PackageInstaller.STATUS_FAILURE,
                        ) ?: PackageInstaller.STATUS_FAILURE
                        AppLog.i("apk-update", "install status=$status")
                        when (status) {
                            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                                val confirm = if (Build.VERSION.SDK_INT >= 33) {
                                    intent?.getParcelableExtra(
                                        Intent.EXTRA_INTENT,
                                        Intent::class.java,
                                    )
                                } else {
                                    @Suppress("DEPRECATION")
                                    intent?.getParcelableExtra(Intent.EXTRA_INTENT)
                                }
                                confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                confirm?.let { ctx?.startActivity(it) }
                                // Garder le receiver pour le statut final (OK / annulé)
                                return
                            }
                            PackageInstaller.STATUS_SUCCESS -> {
                                prefs.edit().remove(KEY_REPROMPT_INSTALL).apply()
                            }
                            PackageInstaller.STATUS_FAILURE_ABORTED,
                            PackageInstaller.STATUS_FAILURE,
                            PackageInstaller.STATUS_FAILURE_BLOCKED,
                            PackageInstaller.STATUS_FAILURE_CONFLICT,
                            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE,
                            PackageInstaller.STATUS_FAILURE_INVALID,
                            PackageInstaller.STATUS_FAILURE_STORAGE,
                            -> {
                                markInstallCancelled()
                            }
                        }
                        runCatching { ctx?.unregisterReceiver(this) }
                    }
                },
                filter,
                ContextCompat.RECEIVER_NOT_EXPORTED,
            )
            session.commit(pi.intentSender)
        }
        return true
    }

    private fun installApkViaView(file: File) {
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file,
        )
        val view = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(view)
    }

    companion object {
        private const val KEY_LAST_CHECK = "last_check_at"
        /** @deprecated legacy permanent snooze — migré vers KEY_SNOOZE_* */
        private const val KEY_SNOOZED_CODE = "snoozed_version_code"
        private const val KEY_SNOOZE_CODE = "snooze_version_code"
        private const val KEY_SNOOZE_UNTIL = "snooze_until_ms"
        private const val KEY_REPROMPT_INSTALL = "reprompt_after_install_cancel"
        private const val KEY_PROMPTED_SLOT = "prompted_slot"
        private const val KEY_LAST_REMOTE_CODE = "last_remote_code"
        private const val KEY_LAST_REMOTE_NAME = "last_remote_name"
        private val WINDOW_HALF_MS = TimeUnit.MINUTES.toMillis(45)
        private val PERIODIC_INTERVAL_MS = TimeUnit.HOURS.toMillis(6)
    }
}
