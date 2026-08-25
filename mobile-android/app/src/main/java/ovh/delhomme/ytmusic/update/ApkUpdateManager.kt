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
 * Prompt automatique (dialogue) : **au plus 2× / jour**, fenêtres ~7h et ~17h
 * (pull Accueil ou check périodique). Hors fenêtre → pas de popup ; le menu Compte
 * reste à jour (ligne rouge si MAJ dispo).
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

    fun lastCheckAt(): Long = prefs.getLong(KEY_LAST_CHECK, 0L)

    fun shouldAutoCheck(now: Long = System.currentTimeMillis()): Boolean {
        val last = lastCheckAt()
        return now - last >= PERIODIC_INTERVAL_MS
    }

    fun dismissForVersion(versionCode: Int) {
        prefs.edit().putInt(KEY_SNOOZED_CODE, versionCode).apply()
    }

    fun isSnoozed(versionCode: Int): Boolean =
        prefs.getInt(KEY_SNOOZED_CODE, 0) == versionCode && versionCode > 0

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

    suspend fun checkOnStartup(): CheckResult {
        val result = check(force = true, respectSnooze = true)
        if (result.available && canOfferPromptDialog()) {
            promptSlotNow()?.let { markPromptedSlot(it) }
            return result
        }
        return if (result.available) {
            result.copy(available = false, message = result.message ?: "MAJ dispo (menu Compte)")
        } else {
            result
        }
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
                        if (prefs.getInt(KEY_SNOOZED_CODE, 0) > 0) {
                            prefs.edit().remove(KEY_SNOOZED_CODE).apply()
                        }
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
                            message = "Reportée (v$remote) — prochaine version seulement",
                        )
                    else ->
                        CheckResult(true, info, local, message = "v$remote disponible")
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
        prefs.edit().remove(KEY_SNOOZED_CODE).apply()
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
            // Receiver one-shot pour loguer le statut
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
                        runCatching { ctx?.unregisterReceiver(this) }
                        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
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
                        }
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
        private const val KEY_SNOOZED_CODE = "snoozed_version_code"
        private const val KEY_PROMPTED_SLOT = "prompted_slot"
        private const val KEY_LAST_REMOTE_CODE = "last_remote_code"
        private const val KEY_LAST_REMOTE_NAME = "last_remote_name"
        private val WINDOW_HALF_MS = TimeUnit.MINUTES.toMillis(45)
        private val PERIODIC_INTERVAL_MS = TimeUnit.HOURS.toMillis(6)
    }
}
