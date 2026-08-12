package ovh.delhomme.ytmusic.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request
import ovh.delhomme.ytmusic.BuildConfig
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.ApkInfoResponse
import ovh.delhomme.ytmusic.debug.AppLog
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Vérifie / télécharge / installe l’APK publiée sur le serveur (`/api/deploy/apk`)
 * sans passer par l’UI GitHub — entièrement in-app.
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
        val message: String? = null,
    )

    fun lastCheckAt(): Long = prefs.getLong(KEY_LAST_CHECK, 0L)

    fun shouldAutoCheck(now: Long = System.currentTimeMillis()): Boolean {
        val last = lastCheckAt()
        return now - last >= TimeUnit.DAYS.toMillis(1)
    }

    suspend fun check(force: Boolean = false): CheckResult = withContext(Dispatchers.IO) {
        if (!force && !shouldAutoCheck()) {
            return@withContext CheckResult(available = false, message = "check récent")
        }
        runCatching {
            container.ensureFreshToken()
            val info = container.api.apkInfo()
            prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply()
            val remote = info.versionCode ?: 0
            val local = BuildConfig.VERSION_CODE
            if (info.ready != true) {
                CheckResult(false, info, local, "APK pas encore publiée")
            } else if (remote <= local) {
                CheckResult(false, info, local, "À jour (v$local)")
            } else {
                CheckResult(true, info, local, "v$remote disponible")
            }
        }.getOrElse {
            AppLog.w("apk-update", "check failed: ${it.message}")
            CheckResult(false, message = it.message ?: "Échec vérif")
        }
    }

    /**
     * Télécharge l’APK puis lance l’installateur système.
     * Nécessite « Installer des apps inconnues » pour ce package sur Android 8+.
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
        container.ensureFreshToken()
        val meta = info ?: container.api.apkInfo()
        if (meta.ready != true) return@withContext "APK pas encore publiée"
        val remote = meta.versionCode ?: 0
        if (remote <= BuildConfig.VERSION_CODE) return@withContext "Déjà à jour"

        val base = container.resolvedApiBase().trimEnd('/')
        val path = meta.downloadPath?.takeIf { it.startsWith("/") } ?: "/api/deploy/apk"
        val url = meta.downloadUrl?.takeIf {
            it.startsWith("https://") || it.startsWith("http://")
        } ?: "$base$path"

        val dir = File(context.cacheDir, "apk-updates").apply { mkdirs() }
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
        withContext(Dispatchers.Main) { installApkViaView(out) }
        "Installation lancée (v$remote)"
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
    }
}
