package ovh.delhomme.ytmusic.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
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
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Vérifie / télécharge / installe l’APK publiée sur le serveur (`/api/deploy/apk`)
 * — toujours la **dernière** version seule (pas de chaîne d’intermédiaires).
 *
 * Le téléchargement vit dans un scope **application** : quitter Compte
 * n’annule plus la MAJ, et l’écran retrouve l’état (phase + %) au retour.
 */
class ApkUpdateManager(
    private val context: Context,
    private val container: AppContainer,
) {
    private val prefs = context.getSharedPreferences("ytm_updates", Context.MODE_PRIVATE)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var updateJob: Job? = null
    private val busy = AtomicBoolean(false)
    private val notifier = UpdateProgressNotifier(context.applicationContext)

    enum class Phase {
        Idle,
        Checking,
        UpToDate,
        Available,
        Downloading,
        Installing,
        AwaitingConfirm,
        Done,
        Error,
    }

    data class UiState(
        val phase: Phase = Phase.Idle,
        /** 0f…1f pendant Downloading */
        val progress: Float = 0f,
        val message: String = "",
        val remoteName: String? = null,
        val remoteCode: Int = 0,
        val available: Boolean = false,
    )

    private val _ui = MutableStateFlow(restoreUi())
    val ui: StateFlow<UiState> = _ui.asStateFlow()

    private fun restoreUi(): UiState {
        val phaseName = prefs.getString(KEY_UI_PHASE, null)
        val phase = runCatching { Phase.valueOf(phaseName ?: "") }.getOrDefault(Phase.Idle)
        // Ne pas restaurer Downloading/Checking (job mort) → Idle avec message
        val safe = when (phase) {
            Phase.Downloading, Phase.Checking, Phase.Installing -> Phase.Idle
            else -> phase
        }
        return UiState(
            phase = safe,
            progress = 0f,
            message = prefs.getString(KEY_UI_MESSAGE, "") ?: "",
            remoteName = prefs.getString(KEY_LAST_REMOTE_NAME, null),
            remoteCode = prefs.getInt(KEY_LAST_REMOTE_CODE, 0),
            available = safe == Phase.Available || safe == Phase.AwaitingConfirm ||
                (safe == Phase.Error && prefs.getInt(KEY_LAST_REMOTE_CODE, 0) > BuildConfig.VERSION_CODE),
        )
    }

    private fun publish(state: UiState) {
        _ui.value = state
        prefs.edit()
            .putString(KEY_UI_PHASE, state.phase.name)
            .putString(KEY_UI_MESSAGE, state.message)
            .apply()
    }

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
     * Rafraîchit le libellé Compte (sans lancer de DL).
     * À appeler à l’entrée / retour sur l’écran Compte.
     */
    suspend fun refreshAccountStatus() {
        val current = _ui.value
        if (current.phase == Phase.Downloading || current.phase == Phase.Installing ||
            current.phase == Phase.Checking || current.phase == Phase.AwaitingConfirm
        ) {
            // Job en cours : ne pas écraser le progrès
            return
        }
        publish(
            current.copy(
                phase = Phase.Checking,
                message = "Vérification de la version…",
                progress = 0f,
            ),
        )
        val result = check(force = true, respectSnooze = false)
        val remote = result.info?.versionCode ?: 0
        val remoteName = result.info?.versionName
        when {
            remote > BuildConfig.VERSION_CODE && !isSnoozed(remote) -> {
                val pending = apkFileFor(remote).takeIf { it.isFile && it.length() > 1_000_000L }
                if (pending != null) {
                    publish(
                        UiState(
                            phase = Phase.AwaitingConfirm,
                            message = "APK ${remoteName ?: remote} téléchargée — appuie pour lancer l’installateur",
                            remoteName = remoteName,
                            remoteCode = remote,
                            available = true,
                        ),
                    )
                } else {
                    publish(
                        UiState(
                            phase = Phase.Available,
                            message = "Nouvelle version ${remoteName ?: "p+$remote"} — appuie pour télécharger et installer",
                            remoteName = remoteName,
                            remoteCode = remote,
                            available = true,
                        ),
                    )
                }
            }
            remote > BuildConfig.VERSION_CODE -> {
                publish(
                    UiState(
                        phase = Phase.Idle,
                        message = "Installée ${BuildConfig.VERSION_NAME} · serveur $remoteName (ignorée pour plus tard)",
                        remoteName = remoteName,
                        remoteCode = remote,
                        available = false,
                    ),
                )
            }
            remote > 0 && remote < BuildConfig.VERSION_CODE -> {
                publish(
                    UiState(
                        phase = Phase.UpToDate,
                        message = "À jour — installée ${BuildConfig.VERSION_NAME}" +
                            (remoteName?.let { " (catalogue serveur $it — republier l’APK)" } ?: ""),
                        remoteName = remoteName,
                        remoteCode = remote,
                        available = false,
                    ),
                )
            }
            remote > 0 -> {
                publish(
                    UiState(
                        phase = Phase.UpToDate,
                        message = "À jour — installée ${BuildConfig.VERSION_NAME}" +
                            (remoteName?.let { " · serveur $it" } ?: ""),
                        remoteName = remoteName,
                        remoteCode = remote,
                        available = false,
                    ),
                )
            }
            else -> {
                publish(
                    UiState(
                        phase = Phase.Idle,
                        message = result.message ?: "Installée ${BuildConfig.VERSION_NAME}",
                        available = false,
                    ),
                )
            }
        }
    }

    /**
     * Clic Compte « Mettre à jour » : tourne hors composition (survit navigation).
     * Publie l’état **tout de suite** (thread UI) pour que le bouton ne paraisse pas mort.
     */
    fun startManualUpdate() {
        if (!busy.compareAndSet(false, true)) {
            AppLog.i("apk-update", "déjà en cours phase=${_ui.value.phase}")
            return
        }
        publish(
            _ui.value.copy(
                phase = Phase.Checking,
                message = "Vérification de la version…",
                progress = 0f,
                available = true,
            ),
        )
        notifier.show("Mise à jour PLM", "Vérification de la version…", null, indeterminate = true)
        updateJob?.cancel()
        updateJob = scope.launch {
            try {
                val check = check(force = true, respectSnooze = false)
                val remote = check.info?.versionCode ?: 0
                val remoteName = check.info?.versionName
                if (remote <= BuildConfig.VERSION_CODE) {
                    notifier.cancel()
                    publish(
                        UiState(
                            phase = Phase.UpToDate,
                            message = check.message ?: "À jour — ${BuildConfig.VERSION_NAME}",
                            remoteName = remoteName,
                            remoteCode = remote,
                            available = false,
                        ),
                    )
                    return@launch
                }
                val pending = apkFileFor(remote)
                if (pending.isFile && pending.length() > 1_000_000L) {
                    publish(
                        UiState(
                            phase = Phase.Installing,
                            message = "Préparation de l’installateur (${remoteName ?: remote})…",
                            remoteName = remoteName,
                            remoteCode = remote,
                            available = true,
                            progress = 0f,
                        ),
                    )
                    notifier.show(
                        "Mise à jour PLM",
                        "Préparation de l’installateur…",
                        0,
                        indeterminate = true,
                    )
                    val msg = launchInstall(pending, remote)
                    val okInstall = msg.startsWith("Installation")
                    if (okInstall) {
                        notifier.show(
                            "Mise à jour PLM",
                            "Confirme l’installation — PLM se relancera ensuite",
                            100,
                            indeterminate = false,
                        )
                    } else {
                        notifier.cancel()
                    }
                    publish(
                        UiState(
                            phase = if (okInstall) Phase.AwaitingConfirm else Phase.Error,
                            message = if (okInstall) {
                                "Confirme l’installation — PLM se relancera toute seule"
                            } else {
                                msg
                            },
                            remoteName = remoteName,
                            remoteCode = remote,
                            available = true,
                            progress = 1f,
                        ),
                    )
                    return@launch
                }
                publish(
                    UiState(
                        phase = Phase.Downloading,
                        message = "Téléchargement ${remoteName ?: remote}… 0 %",
                        remoteName = remoteName,
                        remoteCode = remote,
                        available = true,
                        progress = 0f,
                    ),
                )
                notifier.show("Mise à jour PLM", "Téléchargement… 0 %", 0, indeterminate = false)
                val msg = downloadAndInstall(check.info) { p ->
                    val pct = (p * 100).toInt().coerceIn(0, 99)
                    val line = "Téléchargement ${remoteName ?: remote}… $pct %"
                    _ui.update {
                        it.copy(
                            phase = Phase.Downloading,
                            progress = p,
                            message = line,
                            remoteName = remoteName,
                            remoteCode = remote,
                            available = true,
                        )
                    }
                    notifier.show("Mise à jour PLM", line, pct, indeterminate = false)
                }
                val ok = msg.startsWith("Installation")
                if (ok) {
                    notifier.show(
                        "Mise à jour PLM",
                        "Confirme l’installation — PLM se relancera ensuite",
                        100,
                        indeterminate = false,
                    )
                } else {
                    notifier.cancel()
                }
                publish(
                    UiState(
                        phase = when {
                            ok -> Phase.AwaitingConfirm
                            msg.contains("Autorise", ignoreCase = true) -> Phase.Error
                            msg.contains("Déjà à jour") -> Phase.UpToDate
                            else -> Phase.Error
                        },
                        message = when {
                            ok -> "Confirme l’installation — PLM se relancera toute seule"
                            else -> msg
                        },
                        remoteName = remoteName,
                        remoteCode = remote,
                        available = ok || remote > BuildConfig.VERSION_CODE,
                        progress = if (ok) 1f else _ui.value.progress,
                    ),
                )
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                AppLog.w("apk-update", "manual update fail", e)
                notifier.cancel()
                publish(
                    _ui.value.copy(
                        phase = Phase.Error,
                        message = e.message ?: "Échec mise à jour",
                        available = (_ui.value.remoteCode > BuildConfig.VERSION_CODE),
                    ),
                )
            } finally {
                busy.set(false)
            }
        }
    }

    private fun apkFileFor(remoteCode: Int): File {
        val dir = File(context.cacheDir, "apk-updates").apply { mkdirs() }
        return File(dir, "plm-update-$remoteCode.apk")
    }

    private suspend fun launchInstall(file: File, remote: Int): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !context.packageManager.canRequestPackageInstalls()
        ) {
            withContext(Dispatchers.Main) {
                val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                    .setData(Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            }
            return "Autorise l’installation pour PLM, puis réessaie"
        }
        withContext(Dispatchers.Main) {
            runCatching {
                PlaybackService.Holder.player?.pause()
                PlaybackService.Holder.player?.stop()
                context.stopService(Intent(context, PlaybackService::class.java))
            }
        }
        clearSnooze()
        UpdateRelaunch.markPending(context)
        val ok = runCatching { installViaPackageInstaller(file) }.getOrElse { err ->
            AppLog.w("apk-update", "PackageInstaller KO: ${err.message} — fallback VIEW")
            withContext(Dispatchers.Main) { installApkViaView(file) }
            true
        }
        return if (ok) "Installation lancée (v$remote)" else "Échec lancement installateur"
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
    suspend fun downloadAndInstall(
        info: ApkInfoResponse? = null,
        onProgress: ((Float) -> Unit)? = null,
    ): String = withContext(Dispatchers.IO) {
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
        val meta = info ?: container.api.apkInfo()
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
        val out = apkFileFor(remote)
        if (out.exists()) out.delete()

        val req = Request.Builder().url(url).get().build()
        container.httpAuth.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                return@withContext "Téléchargement HTTP ${resp.code}"
            }
            val body = resp.body ?: return@withContext "Réponse vide"
            val total = body.contentLength().takeIf { it > 0 }
                ?: meta.sizeBytes?.toLong()?.takeIf { it > 0 }
                ?: -1L
            out.outputStream().use { os ->
                body.byteStream().use { input ->
                    val buf = ByteArray(64 * 1024)
                    var read = 0L
                    var lastPct = -1
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        os.write(buf, 0, n)
                        read += n
                        if (total > 0) {
                            val p = (read.toFloat() / total.toFloat()).coerceIn(0f, 0.99f)
                            val pct = (p * 100).toInt()
                            if (pct != lastPct) {
                                lastPct = pct
                                onProgress?.invoke(p)
                            }
                        } else if (read % (512 * 1024L) < buf.size) {
                            onProgress?.invoke((read / (8f * 1024f * 1024f)).coerceIn(0f, 0.9f))
                        }
                    }
                }
            }
            onProgress?.invoke(1f)
        }
        if (out.length() < 1_000_000L) {
            out.delete()
            return@withContext "APK trop petite (${out.length()} o)"
        }
        AppLog.i("apk-update", "downloaded ${out.length()} bytes → install v$remote")
        publish(
            _ui.value.copy(
                phase = Phase.Installing,
                progress = 0f,
                message = "Préparation de l’installateur (v$remote)… 0 %",
            ),
        )
        notifier.show("Mise à jour PLM", "Préparation de l’installateur… 0 %", 0, indeterminate = false)
        launchInstall(out, remote)
    }

    /** Session PackageInstaller (plus fiable que ACTION_VIEW sur Nothing / Android 14+). */
    private fun installViaPackageInstaller(file: File): Boolean {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        // API 34+ : évite le kill immédiat → on peut relancer PLM après SUCCESS
        if (Build.VERSION.SDK_INT >= 34) {
            runCatching { params.setDontKillApp(true) }
        }
        UpdateRelaunch.markPending(context)
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            val total = file.length().coerceAtLeast(1L)
            file.inputStream().use { input ->
                session.openWrite("base.apk", 0, file.length()).use { out ->
                    val buf = ByteArray(256 * 1024)
                    var written = 0L
                    var lastPct = -1
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        written += n
                        val pct = ((written * 100L) / total).toInt().coerceIn(0, 99)
                        if (pct != lastPct) {
                            lastPct = pct
                            val line = "Préparation de l’installateur… $pct %"
                            publish(
                                _ui.value.copy(
                                    phase = Phase.Installing,
                                    progress = (written.toFloat() / total.toFloat()).coerceIn(0f, 0.99f),
                                    message = line,
                                    available = true,
                                ),
                            )
                            notifier.show("Mise à jour PLM", line, pct, indeterminate = false)
                        }
                    }
                    session.fsync(out)
                }
            }
            publish(
                _ui.value.copy(
                    phase = Phase.Installing,
                    progress = 1f,
                    message = "Ouverture de l’écran d’installation…",
                    available = true,
                ),
            )
            notifier.show(
                "Mise à jour PLM",
                "Ouverture de l’écran d’installation…",
                100,
                indeterminate = true,
            )
            val intent = Intent(context, UpdateInstallReceiver::class.java).apply {
                action = "${context.packageName}.UPDATE_INSTALL"
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    PendingIntent.FLAG_MUTABLE
                } else {
                    0
                }
            val pi = PendingIntent.getBroadcast(context, sessionId, intent, flags)
            session.commit(pi.intentSender)
        }
        return true
    }

    /** Appelé depuis [UpdateInstallReceiver] (manifeste — survit au kill du process). */
    fun onInstallerStatus(ctx: Context, intent: Intent) {
        val status = intent.getIntExtra(
            PackageInstaller.EXTRA_STATUS,
            PackageInstaller.STATUS_FAILURE,
        )
        AppLog.i("apk-update", "install status=$status")
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                UpdateRelaunch.startConfirmIntent(ctx, intent)
                publish(
                    _ui.value.copy(
                        phase = Phase.AwaitingConfirm,
                        message = "Confirme l’installation — PLM se relancera toute seule",
                        available = true,
                        progress = 1f,
                    ),
                )
                notifier.show(
                    "Mise à jour PLM",
                    "Confirme l’installation sur l’écran système",
                    100,
                    indeterminate = false,
                )
            }
            PackageInstaller.STATUS_SUCCESS -> {
                prefs.edit().remove(KEY_REPROMPT_INSTALL).apply()
                notifier.done("Installée — réouverture…")
                publish(
                    UiState(
                        phase = Phase.Done,
                        message = "Mise à jour installée — réouverture…",
                        available = false,
                        progress = 1f,
                    ),
                )
                UpdateRelaunch.relaunch(ctx.applicationContext)
            }
            PackageInstaller.STATUS_FAILURE_ABORTED,
            PackageInstaller.STATUS_FAILURE,
            PackageInstaller.STATUS_FAILURE_BLOCKED,
            PackageInstaller.STATUS_FAILURE_CONFLICT,
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE,
            PackageInstaller.STATUS_FAILURE_INVALID,
            PackageInstaller.STATUS_FAILURE_STORAGE,
            -> {
                notifier.cancel()
                markInstallCancelled()
                publish(
                    _ui.value.copy(
                        phase = Phase.Error,
                        message = "Installation annulée ou échouée — appuie pour réessayer",
                        available = true,
                    ),
                )
            }
        }
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
        private const val KEY_UI_PHASE = "ui_phase"
        private const val KEY_UI_MESSAGE = "ui_message"
        private val WINDOW_HALF_MS = TimeUnit.MINUTES.toMillis(45)
        private val PERIODIC_INTERVAL_MS = TimeUnit.HOURS.toMillis(6)
    }
}
