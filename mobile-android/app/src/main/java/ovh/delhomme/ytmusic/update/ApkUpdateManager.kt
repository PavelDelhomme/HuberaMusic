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
import kotlinx.coroutines.withTimeout
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
 * L’APK OTA est **PLM prod** (`ovh.delhomme.ytmusic`). Depuis PLM Dev / Preprod,
 * la MAJ met à jour l’autre icône (pas le package courant) — messages + relaunch
 * ciblent donc le paquet de l’APK, pas `context.packageName`.
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
    /** Paquet cible de la dernière session d’install (persisté pour SUCCESS après kill). */
    private var lastTargetPackage: String? =
        prefs.getString(KEY_TARGET_PACKAGE, null)?.takeIf { it.isNotBlank() }

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

    @Volatile
    private var lastConfirmIntent: Intent? = null
    @Volatile
    private var lastReopenAt = 0L
    /** true = dernière install via ACTION_VIEW (fallback rare seulement). */
    @Volatile
    private var usedViewInstall = false
    private var lastInstallApk: File? = null
    /** Verrou anti double-feuille Confirmer (broadcasts / races / VIEW+PI). */
    private val confirmUiGate = AtomicBoolean(false)
    /** Empêche 2× createSession (tap Compte + resume + banner). */
    private val installInFlight = AtomicBoolean(false)
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var pendingConfirmRetry: Runnable? = null
    private var pendingViewFallback: Runnable? = null

    private fun resetConfirmGate() {
        confirmUiGate.set(false)
        prefs.edit().remove(KEY_CONFIRM_OPENED_AT).apply()
    }

    /**
     * Ouvre l’UI Confirmer au plus une fois pendant [CONFIRM_DEBOUNCE_MS].
     * Persiste l’horodatage pour survivre à un restart process entre 2 broadcasts.
     */
    private fun tryOpenConfirmUi(reason: String, open: () -> Unit): Boolean {
        val now = System.currentTimeMillis()
        val lastAt = prefs.getLong(KEY_CONFIRM_OPENED_AT, 0L)
        if (lastAt > 0L && now - lastAt < CONFIRM_DEBOUNCE_MS) {
            AppLog.i("apk-update", "confirm ignore ($reason) debounce=${now - lastAt}ms")
            return false
        }
        if (!confirmUiGate.compareAndSet(false, true)) {
            AppLog.i("apk-update", "confirm ignore ($reason) gate")
            return false
        }
        prefs.edit().putLong(KEY_CONFIRM_OPENED_AT, now).apply()
        AppLog.i("apk-update", "confirm open once ($reason)")
        runCatching(open).onFailure {
            AppLog.w("apk-update", "confirm open KO ($reason): ${it.message}")
            resetConfirmGate()
        }
        return true
    }

    /**
     * Clic vignette / Compte / notif : rouvre « Confirmer l’installation »
     * (Nothing le met souvent derrière PLM) ou relance le flux selon la phase.
     */
    fun onBannerAction(): Boolean {
        return when (_ui.value.phase) {
            Phase.AwaitingConfirm -> reopenConfirmInstall()
            Phase.Error, Phase.Available -> {
                startManualUpdate()
                true
            }
            Phase.Idle -> {
                if (_ui.value.available) {
                    startManualUpdate()
                    true
                } else {
                    false
                }
            }
            else -> false
        }
    }

    /** Relance l’écran système de confirmation (ou réinstalle depuis le cache APK). */
    fun reopenConfirmInstall(): Boolean {
        val now = System.currentTimeMillis()
        if (now - lastReopenAt < 4_000L) {
            AppLog.i("apk-update", "reopen debounce")
            return false
        }
        lastReopenAt = now
        val confirm = lastConfirmIntent
        if (confirm != null) {
            // Ne PAS resetConfirmGate ici : sinon chaque tap empile une feuille.
            return tryOpenConfirmUi("reopen-intent") {
                UpdateRelaunch.launchConfirm(context, confirm)
                notifier.show(
                    "Mise à jour PLM",
                    "Écran d’installation — Rouvrir",
                    100,
                    indeterminate = false,
                )
            }
        }
        // Pas d’intent : une seule nouvelle session PackageInstaller (après abandon des autres).
        val remote = _ui.value.remoteCode.takeIf { it > BuildConfig.VERSION_CODE }
            ?: prefs.getInt(KEY_LAST_REMOTE_CODE, 0)
        val pending = if (remote > BuildConfig.VERSION_CODE) apkFileFor(remote) else null
        if (pending != null && pending.isFile && pending.length() > 1_000_000L) {
            if (installInFlight.get()) {
                AppLog.i("apk-update", "reopen: session déjà en vol")
                return false
            }
            AppLog.i("apk-update", "reopen via cached apk v$remote (1 session)")
            scope.launch {
                if (!busy.compareAndSet(false, true)) return@launch
                try {
                    abandonAllSessions()
                    resetConfirmGate()
                    publish(
                        _ui.value.copy(
                            phase = Phase.Installing,
                            message = "Préparation de l’installateur…",
                            progress = 0f,
                            available = true,
                        ),
                    )
                    val msg = launchInstall(pending, remote)
                    val ok = msg.startsWith("Installation")
                    publish(
                        _ui.value.copy(
                            phase = if (ok) Phase.AwaitingConfirm else Phase.Error,
                            message = if (ok) {
                                "Valide l’installation système — une seule fenêtre"
                            } else {
                                msg
                            },
                            progress = 1f,
                            available = true,
                        ),
                    )
                } finally {
                    busy.set(false)
                }
            }
            return true
        }
        AppLog.w("apk-update", "reopen confirm: pas d’intent ni d’APK cache")
        return false
    }

    private fun cancelPendingInstallRetries() {
        pendingConfirmRetry?.let { mainHandler.removeCallbacks(it) }
        pendingViewFallback?.let { mainHandler.removeCallbacks(it) }
        pendingConfirmRetry = null
        pendingViewFallback = null
    }

    private fun restoreUi(): UiState {
        val phaseName = prefs.getString(KEY_UI_PHASE, null)
        val phase = runCatching { Phase.valueOf(phaseName ?: "") }.getOrDefault(Phase.Idle)
        val remoteCode = prefs.getInt(KEY_LAST_REMOTE_CODE, 0)
        // Après une MAJ réussie (ADB / install) ou process mort : ne jamais
        // restaurer AwaitingConfirm — l’intent système est mort et la vignette
        // bloquait Accueil / Compte (Nothing).
        val safe = when (phase) {
            Phase.Downloading, Phase.Checking, Phase.Installing -> Phase.Idle
            Phase.AwaitingConfirm -> {
                when {
                    remoteCode > 0 && remoteCode <= BuildConfig.VERSION_CODE -> Phase.UpToDate
                    else -> Phase.Available
                }
            }
            else -> phase
        }
        val message = when (safe) {
            Phase.UpToDate -> "À jour — ${BuildConfig.VERSION_NAME}"
            Phase.Available ->
                prefs.getString(KEY_UI_MESSAGE, "")?.takeIf { it.isNotBlank() }
                    ?: "Nouvelle version prête — appuie pour installer"
            else -> prefs.getString(KEY_UI_MESSAGE, "") ?: ""
        }
        return UiState(
            phase = safe,
            progress = 0f,
            message = message,
            remoteName = prefs.getString(KEY_LAST_REMOTE_NAME, null),
            remoteCode = remoteCode,
            available = safe == Phase.Available ||
                (safe == Phase.Error && remoteCode > BuildConfig.VERSION_CODE),
        )
    }

    /** Annule une confirmation coincée / abandonne la vignette bloquante. */
    fun dismissAwaitingConfirm(snooze: Boolean = true) {
        cancelPendingInstallRetries()
        lastConfirmIntent = null
        resetConfirmGate()
        installInFlight.set(false)
        abandonAllSessions()
        usedViewInstall = false
        lastInstallApk = null
        notifier.cancel()
        val remote = _ui.value.remoteCode.takeIf { it > 0 }
            ?: prefs.getInt(KEY_LAST_REMOTE_CODE, 0)
        if (snooze && remote > BuildConfig.VERSION_CODE) {
            snooze(SnoozeOption.LATER_TODAY, remote)
        }
        publish(
            UiState(
                phase = if (remote > 0 && remote <= BuildConfig.VERSION_CODE) {
                    Phase.UpToDate
                } else {
                    Phase.Idle
                },
                message = if (remote > 0 && remote <= BuildConfig.VERSION_CODE) {
                    "À jour — ${BuildConfig.VERSION_NAME}"
                } else {
                    "Installation reportée — tu pourras réessayer dans Compte"
                },
                remoteName = _ui.value.remoteName,
                remoteCode = remote,
                available = false,
            ),
        )
        AppLog.i("apk-update", "dismissAwaitingConfirm remote=$remote")
    }

    /**
     * Au démarrage : si on est déjà à jour, nettoie toute phase Confirmer
     * fantôme (cas Nothing après ADB / install partielle).
     */
    fun reconcileAfterBoot() {
        val remote = prefs.getInt(KEY_LAST_REMOTE_CODE, 0)
        val phase = _ui.value.phase
        // Checking / Installing fantômes après kill : jamais bloquer Compte
        if (phase == Phase.Checking || phase == Phase.Installing) {
            busy.set(false)
            publish(
                UiState(
                    phase = if (remote > BuildConfig.VERSION_CODE) Phase.Available else Phase.Idle,
                    message = if (remote > BuildConfig.VERSION_CODE) {
                        "Mise à jour prête — appuie pour télécharger"
                    } else {
                        "Installée ${BuildConfig.VERSION_NAME}"
                    },
                    remoteName = prefs.getString(KEY_LAST_REMOTE_NAME, null),
                    remoteCode = remote,
                    available = remote > BuildConfig.VERSION_CODE,
                ),
            )
        }
        if (remote > 0 && remote <= BuildConfig.VERSION_CODE) {
            if (phase == Phase.AwaitingConfirm || phase == Phase.Available ||
                phase == Phase.Error || phase == Phase.Installing || phase == Phase.Checking
            ) {
                lastConfirmIntent = null
                notifier.cancel()
                publish(
                    UiState(
                        phase = Phase.UpToDate,
                        message = "À jour — ${BuildConfig.VERSION_NAME}",
                        remoteName = prefs.getString(KEY_LAST_REMOTE_NAME, null),
                        remoteCode = remote,
                        available = false,
                    ),
                )
            }
            return
        }
        // Intent perdu après kill → ne pas rester bloqué sur Confirmer
        if (phase == Phase.AwaitingConfirm && lastConfirmIntent == null) {
            val pending = if (remote > BuildConfig.VERSION_CODE) apkFileFor(remote) else null
            if (pending == null || !pending.isFile || pending.length() < 1_000_000L) {
                publish(
                    _ui.value.copy(
                        phase = Phase.Available,
                        message = "Mise à jour prête — appuie pour télécharger",
                        available = true,
                    ),
                )
            }
        }
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
            current.phase == Phase.AwaitingConfirm
        ) {
            // Job en cours réel : ne pas écraser le progrès
            return
        }
        // Checking « fantôme » (coroutine annulée en quittant Compte) → on réessaie.
        val staleChecking =
            current.phase == Phase.Checking &&
                !busy.get() &&
                updateJob?.isActive != true
        if (current.phase == Phase.Checking && !staleChecking) {
            return
        }
        publish(
            current.copy(
                phase = Phase.Checking,
                message = "Vérification de la version…",
                progress = 0f,
            ),
        )
        try {
            val result = withTimeout(22_000L) {
                check(force = true, respectSnooze = false)
            }
            val remote = result.info?.versionCode ?: 0
            val remoteName = result.info?.versionName
            val targetPkg = result.info?.packageName?.takeIf { it.isNotBlank() } ?: PROD_PACKAGE
            if (targetPkg != context.packageName) {
                lastTargetPackage = targetPkg
                prefs.edit().putString(KEY_TARGET_PACKAGE, targetPkg).apply()
            }
            val hint = crossPackageHint(targetPkg)
            when {
                remote > BuildConfig.VERSION_CODE && !isSnoozed(remote) -> {
                    val pending = apkFileFor(remote).takeIf { it.isFile && it.length() > 1_000_000L }
                    if (pending != null) {
                        publish(
                            UiState(
                                phase = Phase.AwaitingConfirm,
                                message = listOfNotNull(
                                    "APK ${remoteName ?: remote} téléchargée — appuie pour lancer l’installateur",
                                    hint,
                                ).joinToString(" · "),
                                remoteName = remoteName,
                                remoteCode = remote,
                                available = true,
                            ),
                        )
                    } else {
                        publish(
                            UiState(
                                phase = Phase.Available,
                                message = listOfNotNull(
                                    "Nouvelle version ${remoteName ?: "p+$remote"} — appuie pour télécharger et installer",
                                    hint,
                                ).joinToString(" · "),
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
        } catch (e: kotlinx.coroutines.CancellationException) {
            // Quitter Compte pendant « Vérification… » ne doit PAS laisser l’UI coincée.
            if (_ui.value.phase == Phase.Checking) {
                publish(
                    UiState(
                        phase = Phase.Idle,
                        message = "Installée ${BuildConfig.VERSION_NAME}",
                        remoteName = current.remoteName,
                        remoteCode = current.remoteCode,
                        available = current.available,
                    ),
                )
            }
            throw e
        } catch (e: Exception) {
            AppLog.w("apk-update", "refreshAccountStatus fail: ${e.message}")
            publish(
                UiState(
                    phase = Phase.Error,
                    message = e.message?.take(120) ?: "Vérification impossible — réessaie ou navigateur",
                    remoteName = current.remoteName,
                    remoteCode = current.remoteCode,
                    available = current.remoteCode > BuildConfig.VERSION_CODE,
                ),
            )
        }
    }

    /** Débloque une UI coincée (Checking fantôme) et relance. */
    fun recoverStuckUpdateUi(reason: String = "manual") {
        AppLog.i("apk-update", "recoverStuckUpdateUi ($reason) phase=${_ui.value.phase}")
        updateJob?.cancel()
        busy.set(false)
        cancelPendingInstallRetries()
        resetConfirmGate()
        notifier.cancel()
        val remote = _ui.value.remoteCode.takeIf { it > 0 }
            ?: prefs.getInt(KEY_LAST_REMOTE_CODE, 0)
        publish(
            UiState(
                phase = if (remote > BuildConfig.VERSION_CODE) Phase.Available else Phase.Idle,
                message = if (remote > BuildConfig.VERSION_CODE) {
                    "Mise à jour prête — appuie pour télécharger"
                } else {
                    "Installée ${BuildConfig.VERSION_NAME}"
                },
                remoteName = prefs.getString(KEY_LAST_REMOTE_NAME, null),
                remoteCode = remote,
                available = remote > BuildConfig.VERSION_CODE,
            ),
        )
    }

    /**
     * Clic Compte « Mettre à jour » : tourne hors composition (survit navigation).
     * Publie l’état **tout de suite** (thread UI) pour que le bouton ne paraisse pas mort.
     *
     * Si une feuille Confirmer est déjà ouverte : on la rouvre — **jamais** une 2ᵉ session
     * (c’était la cause des multi-fenêtres quand on avait plusieurs versions de retard).
     */
    fun startManualUpdate() {
        val phase = _ui.value.phase
        if (phase == Phase.AwaitingConfirm) {
            AppLog.i("apk-update", "startManualUpdate → reopen only (pas de nouvelle session)")
            reopenConfirmInstall()
            return
        }
        if (phase == Phase.Downloading || phase == Phase.Installing || phase == Phase.Checking) {
            AppLog.i("apk-update", "startManualUpdate ignoré phase=$phase")
            return
        }
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
                            "Écran d’installation ouvert",
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
                                "Valide l’installation système — PLM se relancera ensuite"
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
                        "Écran d’installation ouvert",
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
                            ok -> "Valide l’installation système — PLM se relancera ensuite"
                            else -> msg
                        },
                        remoteName = remoteName,
                        remoteCode = remote,
                        available = ok || remote > BuildConfig.VERSION_CODE,
                        progress = if (ok) 1f else _ui.value.progress,
                    ),
                )
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) {
                    // Annulation (navigation) : ne jamais laisser « Vérification… » coincée.
                    if (_ui.value.phase == Phase.Checking ||
                        _ui.value.phase == Phase.Downloading ||
                        _ui.value.phase == Phase.Installing
                    ) {
                        notifier.cancel()
                        val remote = _ui.value.remoteCode
                        publish(
                            UiState(
                                phase = if (remote > BuildConfig.VERSION_CODE) {
                                    Phase.Available
                                } else {
                                    Phase.Idle
                                },
                                message = "Mise à jour interrompue — réessaie",
                                remoteName = _ui.value.remoteName,
                                remoteCode = remote,
                                available = remote > BuildConfig.VERSION_CODE,
                            ),
                        )
                    }
                    throw e
                }
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
            UpdateRelaunch.markPendingAfterPermission(context)
            withContext(Dispatchers.Main) {
                val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                    .setData(Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            }
            return "Autorise l’installation pour PLM, puis reviens — on relance auto"
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
        cancelPendingInstallRetries()
        // Ne reset PAS le gate si on a déjà une feuille en cours — une seule UI.
        if (!installInFlight.compareAndSet(false, true)) {
            AppLog.i("apk-update", "launchInstall: déjà une session en vol")
            return "Installation déjà en cours — une seule fenêtre"
        }
        lastConfirmIntent = null
        lastInstallApk = file
        usedViewInstall = false
        abandonAllSessions()
        resetConfirmGate()
        // Toujours PackageInstaller seul (pas de VIEW en parallèle = 2 feuilles).
        AppLog.i(
            "apk-update",
            "launchInstall PackageInstaller-only mfr=${Build.MANUFACTURER} brand=${Build.BRAND}",
        )
        val ok = runCatching { installViaPackageInstaller(file) }.getOrElse { err ->
            AppLog.w("apk-update", "PackageInstaller KO: ${err.message}")
            installInFlight.set(false)
            false
        }
        if (!ok) installInFlight.set(false)
        return if (ok) "Installation lancée (v$remote)" else "Échec lancement installateur — réessaie ou plm.delhomme.ovh/install"
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
        val metaPkg = meta.packageName?.takeIf { it.isNotBlank() } ?: PROD_PACKAGE
        // Dev/Preprod : on compare au catalogue OTA prod — même si le package courant
        // n’est pas celui de l’APK, on doit pouvoir installer PLM pour les vieilles builds.
        if (remote <= BuildConfig.VERSION_CODE && metaPkg == context.packageName) {
            return@withContext "Déjà à jour — ${BuildConfig.VERSION_NAME}"
        }
        if (remote <= BuildConfig.VERSION_CODE && metaPkg != context.packageName) {
            // Même versionCode que le serveur, mais autre package (ex. d+198 vs p+198) :
            // pas de DL — l’utilisateur doit ouvrir l’icône PLM.
            return@withContext crossPackageHint(metaPkg)
                ?: "Ouvre l’app PLM (prod) — cette build Dev est déjà au même code $remote"
        }
        lastTargetPackage = metaPkg
        prefs.edit().putString(KEY_TARGET_PACKAGE, metaPkg).apply()
        val hint = crossPackageHint(metaPkg)
        if (hint != null) {
            publish(
                _ui.value.copy(
                    phase = Phase.Downloading,
                    message = hint,
                    available = true,
                ),
            )
        }

        val base = container.resolvedApiBase().trimEnd('/')
        val path = meta.downloadPath?.takeIf { it.startsWith("/") } ?: "/api/deploy/apk"
        // Toujours passer par l’API résolue (même host que le JWT) — évite 401 si
        // downloadUrl pointe vers un alias (plm vs ytmusic) mal authentifié.
        val url = "$base$path"

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

    /** Package déclaré dans l’APK (prod), pas forcément celui de l’app qui lance la MAJ. */
    private fun packageNameFromApk(file: File): String? {
        val pi = context.packageManager.getPackageArchiveInfo(file.absolutePath, 0)
        return pi?.packageName?.takeIf { it.isNotBlank() }
    }

    private fun resolveTargetPackage(file: File, metaPackage: String? = null): String {
        val fromFile = packageNameFromApk(file)
        val fromMeta = metaPackage?.takeIf { it.isNotBlank() }
        val target = fromFile ?: fromMeta ?: PROD_PACKAGE
        lastTargetPackage = target
        prefs.edit().putString(KEY_TARGET_PACKAGE, target).apply()
        if (target != context.packageName) {
            AppLog.i(
                "apk-update",
                "cross-package OTA self=${context.packageName} target=$target channel=${BuildConfig.APP_CHANNEL}",
            )
        }
        return target
    }

    private fun crossPackageHint(target: String): String? {
        if (target == context.packageName) return null
        return when (BuildConfig.APP_CHANNEL) {
            "d" -> "Tu es sur PLM Dev — la MAJ installe/met à jour l’app PLM (icône sans « Dev »)."
            "b" -> "Tu es sur PLM Preprod — la MAJ installe/met à jour l’app PLM (prod)."
            else -> "La MAJ cible $target (pas cette app)."
        }
    }

    /** Session PackageInstaller — paquet = celui de l’APK (prod), même depuis Dev. */
    private fun installViaPackageInstaller(file: File): Boolean {
        val installer = context.packageManager.packageInstaller
        // One UI / MIUI : d’anciennes sessions actives → plusieurs PENDING_USER_ACTION
        for (info in installer.mySessions) {
            runCatching {
                AppLog.i("apk-update", "abandon session stale id=${info.sessionId}")
                installer.abandonSession(info.sessionId)
            }
        }
        val targetPkg = resolveTargetPackage(file)
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        // Critiquer : .dev / .preprod ne doivent PAS forcer leur packageId sur une APK prod.
        params.setAppPackageName(targetPkg)
        val oem = "${Build.MANUFACTURER} ${Build.BRAND}".lowercase()
        // Toujours USER_ACTION_REQUIRED (API 31+) : NOT_REQUIRED échoue souvent sans feuille
        // sur Samsung / Lenovo / Xiaomi / Nothing → « Vérification » ou install silencieuse KO.
        // Une seule feuille « Confirmer » est préférable à une MAJ fantôme.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            runCatching {
                params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
                AppLog.i("apk-update", "USER_ACTION_REQUIRED oem=$oem")
            }.onFailure {
                AppLog.w("apk-update", "setRequireUserAction KO: ${it.message}")
            }
        }
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
                    message = "Installation en cours…",
                    available = true,
                ),
            )
            notifier.show(
                "Mise à jour PLM",
                "Installation en cours…",
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

    private fun abandonAllSessions() {
        val installer = context.packageManager.packageInstaller
        for (info in installer.mySessions) {
            runCatching { installer.abandonSession(info.sessionId) }
        }
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
                lastConfirmIntent = UpdateRelaunch.extractConfirmIntent(intent)
                // UNE seule ouverture — les postDelayed ×2 empilaient des feuilles sur Nothing.
                tryOpenConfirmUi("pending-user-action") {
                    UpdateRelaunch.startConfirmIntent(ctx, intent)
                }
                publish(
                    _ui.value.copy(
                        phase = Phase.AwaitingConfirm,
                        message = "Valide l’installation — si l’écran est derrière PLM, appuie sur la vignette",
                        available = true,
                        progress = 1f,
                    ),
                )
                notifier.show(
                    "Mise à jour PLM",
                    "Écran d’installation ouvert",
                    100,
                    indeterminate = false,
                )
            }
            PackageInstaller.STATUS_SUCCESS -> {
                prefs.edit().remove(KEY_REPROMPT_INSTALL).apply()
                resetConfirmGate()
                installInFlight.set(false)
                val target = lastTargetPackage
                    ?: prefs.getString(KEY_TARGET_PACKAGE, null)
                    ?: context.packageName
                val cross = target != context.packageName
                notifier.done(
                    if (cross) "PLM mis à jour — ouvre l’icône PLM"
                    else "Installée — réouverture…",
                )
                publish(
                    UiState(
                        phase = Phase.Done,
                        message = if (cross) {
                            "PLM (prod) installé — ouvre l’icône « PLM », pas PLM Dev"
                        } else {
                            "Mise à jour installée — réouverture…"
                        },
                        available = false,
                        progress = 1f,
                    ),
                )
                UpdateRelaunch.relaunch(ctx.applicationContext, targetPackage = target)
            }
            PackageInstaller.STATUS_FAILURE_ABORTED -> {
                // Annulation feuille système : NE PAS re-prompt au prochain ON_RESUME
                // (sinon Samsung empile 10–25 sessions d’install).
                notifier.cancel()
                resetConfirmGate()
                installInFlight.set(false)
                abandonAllSessions()
                publish(
                    _ui.value.copy(
                        phase = Phase.Error,
                        message = "Installation annulée — réessaie ou ouvre plm.delhomme.ovh/install",
                        available = true,
                    ),
                )
            }
            PackageInstaller.STATUS_FAILURE,
            PackageInstaller.STATUS_FAILURE_BLOCKED,
            PackageInstaller.STATUS_FAILURE_CONFLICT,
            PackageInstaller.STATUS_FAILURE_INCOMPATIBLE,
            PackageInstaller.STATUS_FAILURE_INVALID,
            PackageInstaller.STATUS_FAILURE_STORAGE,
            -> {
                val statusMsg =
                    intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)?.takeIf { it.isNotBlank() }
                AppLog.w("apk-update", "install FAIL status=$status msg=$statusMsg")
                notifier.cancel()
                resetConfirmGate()
                installInFlight.set(false)
                abandonAllSessions()
                // Plus de fallback ACTION_VIEW auto : il ouvrait une 2ᵉ feuille système.
                markInstallCancelled()
                val human = when (status) {
                    PackageInstaller.STATUS_FAILURE_BLOCKED -> "bloquée par le système"
                    PackageInstaller.STATUS_FAILURE_CONFLICT -> "conflit de package"
                    PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "incompatible"
                    PackageInstaller.STATUS_FAILURE_INVALID -> "APK invalide"
                    PackageInstaller.STATUS_FAILURE_STORAGE -> "stockage insuffisant"
                    else -> "échouée"
                }
                publish(
                    _ui.value.copy(
                        phase = Phase.Error,
                        message = "Installation $human${statusMsg?.let { " ($it)" } ?: ""} — réessaie ou plm.delhomme.ovh/install",
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
        private const val KEY_CONFIRM_OPENED_AT = "confirm_opened_at_ms"
        private const val KEY_TARGET_PACKAGE = "ota_target_package"
        private const val PROD_PACKAGE = "ovh.delhomme.ytmusic"
        /** Fenêtre anti double-popup (broadcasts OEM / recreation Activity). */
        private const val CONFIRM_DEBOUNCE_MS = 45_000L
        private val WINDOW_HALF_MS = TimeUnit.MINUTES.toMillis(45)
        private val PERIODIC_INTERVAL_MS = TimeUnit.HOURS.toMillis(6)
    }
}
