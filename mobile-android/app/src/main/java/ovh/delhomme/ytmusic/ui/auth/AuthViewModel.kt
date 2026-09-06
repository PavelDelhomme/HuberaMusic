package ovh.delhomme.ytmusic.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.BuildConfig
import ovh.delhomme.ytmusic.DeviceLoginDeepLink
import ovh.delhomme.ytmusic.auth.DeviceLoginQr
import ovh.delhomme.ytmusic.auth.PasskeyAuth
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.LoginBody
import ovh.delhomme.ytmusic.data.RegisterBody
import retrofit2.HttpException

data class AuthUiState(
    val email: String = BuildConfig.DEV_EMAIL,
    val password: String = BuildConfig.DEV_PASSWORD,
    val name: String = "",
    val totp: String = "",
    val registerMode: Boolean = false,
    val needs2fa: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val loggedIn: Boolean = false,
    /** Après login mot de passe : proposer d’enregistrer une passkey. */
    val offerPasskey: Boolean = false,
    /** Toujours true : Bitwarden / GPM peuvent avoir une passkey sans flag local. */
    val showPasskeyLogin: Boolean = true,
    val allowRegister: Boolean = false,
    /** URL à encoder en QR (appareil déjà connecté doit scanner). */
    val deviceApproveUrl: String? = null,
    val deviceQrStatus: String = "idle",
)

class AuthViewModel(private val container: AppContainer) : ViewModel() {
    private val prefs = container.sharedPrefs("ytm_passkey")
    private val authPrefs = container.sharedPrefs("ytm_auth_v1")
    private var deviceLoginJob: Job? = null

    private val _state = MutableStateFlow(
        AuthUiState(
            email = authPrefs.getString(KEY_LAST_EMAIL, null)
                ?.trim()
                ?.takeIf { it.isNotBlank() }
                ?: BuildConfig.DEV_EMAIL,
            // Jamais préremplir le mdp hors build debug (évite fuite sur APK prod debug partagée).
            password = if (BuildConfig.DEBUG) BuildConfig.DEV_PASSWORD else "",
        ),
    )
    val state: StateFlow<AuthUiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            val allow = runCatching { container.api.authConfig().allowRegister == true }.getOrDefault(false)
            _state.value = _state.value.copy(allowRegister = allow)
            if (!allow && _state.value.registerMode) {
                _state.value = _state.value.copy(registerMode = false)
            }
            if (container.validateSession()) {
                _state.value = _state.value.copy(loggedIn = true)
            } else {
                startDeviceLoginQr()
            }
        }
    }

    fun updateEmail(v: String) { _state.value = _state.value.copy(email = v, error = null) }
    fun updatePassword(v: String) { _state.value = _state.value.copy(password = v, error = null) }
    fun updateName(v: String) { _state.value = _state.value.copy(name = v) }
    fun updateTotp(v: String) { _state.value = _state.value.copy(totp = v) }
    fun toggleMode() {
        if (!_state.value.allowRegister && !_state.value.registerMode) return
        val next = !_state.value.registerMode
        _state.value = _state.value.copy(registerMode = next, error = null)
        if (next) stopDeviceLoginQr() else startDeviceLoginQr()
    }

    /** QR sur l’écran login : un appareil déjà connecté scanne pour approuver. */
    fun startDeviceLoginQr() {
        if (_state.value.registerMode || _state.value.loggedIn || _state.value.offerPasskey) return
        deviceLoginJob?.cancel()
        deviceLoginJob = viewModelScope.launch {
            while (isActive && !_state.value.registerMode && !_state.value.loggedIn) {
                try {
                    val s = container.api.deviceLoginStart()
                    _state.value = _state.value.copy(
                        deviceApproveUrl = s.approveUrl,
                        deviceQrStatus = "waiting",
                    )
                    val refreshAt = (s.expiresAt - 5_000L).coerceAtLeast(System.currentTimeMillis() + 5_000L)
                    while (isActive && System.currentTimeMillis() < refreshAt) {
                        delay(1_500L)
                        val r = runCatching {
                            container.api.deviceLoginPoll(
                                mapOf("id" to s.id, "pollSecret" to s.pollSecret),
                            )
                        }.getOrNull() ?: continue
                        when (r.status) {
                            "approved" -> {
                                val token = r.token
                                if (token.isNullOrBlank()) break
                                container.tokenStore.saveSession(
                                    token,
                                    r.refreshToken,
                                    r.user?.email,
                                    r.user?.name,
                                )
                                r.user?.email?.let {
                                    authPrefs.edit().putString(KEY_LAST_EMAIL, it).apply()
                                }
                                _state.value = _state.value.copy(
                                    loading = false,
                                    loggedIn = true,
                                    deviceQrStatus = "approved",
                                    deviceApproveUrl = null,
                                    error = null,
                                )
                                return@launch
                            }
                            "expired" -> {
                                _state.value = _state.value.copy(deviceQrStatus = "expired")
                                break
                            }
                        }
                    }
                } catch (e: Exception) {
                    _state.value = _state.value.copy(
                        deviceQrStatus = "idle",
                        deviceApproveUrl = null,
                    )
                    delay(3_000L)
                }
            }
        }
    }

    fun stopDeviceLoginQr() {
        deviceLoginJob?.cancel()
        deviceLoginJob = null
        _state.value = _state.value.copy(deviceApproveUrl = null, deviceQrStatus = "idle")
    }

    /** Scan d’un QR d’invite (claim) depuis l’écran login. */
    fun claimFromScannedQr(raw: String) {
        when (val link = DeviceLoginQr.parse(raw)) {
            is DeviceLoginDeepLink.Claim -> {
                viewModelScope.launch {
                    _state.value = _state.value.copy(loading = true, error = null)
                    try {
                        val r = container.api.deviceLoginClaim(mapOf("claim" to link.claim))
                        container.tokenStore.saveSession(
                            r.token,
                            r.refreshToken,
                            r.user.email,
                            r.user.name,
                        )
                        authPrefs.edit().putString(KEY_LAST_EMAIL, r.user.email).apply()
                        stopDeviceLoginQr()
                        _state.value = _state.value.copy(loading = false, loggedIn = true)
                    } catch (e: Exception) {
                        _state.value = _state.value.copy(
                            loading = false,
                            error = e.message ?: "QR invite invalide ou expiré",
                        )
                    }
                }
            }
            is DeviceLoginDeepLink.Approve -> {
                _state.value = _state.value.copy(
                    error = "Ce QR doit être scanné depuis un compte déjà connecté (Compte → Scanner).",
                )
            }
            null -> {
                _state.value = _state.value.copy(error = "QR non reconnu — attend un lien PLM de connexion.")
            }
        }
    }

    fun submit() {
        val s = _state.value
        val email = s.email.trim().trim { it <= ' ' || it.code in 0x2000..0x200F || it.code == 0xFEFF }
        // ADB / clavier : espaces, NBSP, zero-width en fin de mdp
        val password = s.password
            .trim()
            .trim { it <= ' ' || it.code in 0x2000..0x200F || it.code == 0xFEFF }
        if (email.isBlank() || password.isBlank()) {
            _state.value = s.copy(error = "Email et mot de passe requis")
            return
        }
        if (s.registerMode && password.length < 10) {
            _state.value = s.copy(error = "Mot de passe trop court (10 caractères minimum)")
            return
        }
        viewModelScope.launch {
            _state.value = s.copy(loading = true, error = null, email = email, password = password)
            try {
                val res = if (s.registerMode) {
                    container.api.register(
                        RegisterBody(email, password, s.name.ifBlank { null }),
                    )
                } else {
                    container.api.login(
                        LoginBody(
                            email,
                            password,
                            s.totp.ifBlank { null },
                        ),
                    )
                }
                container.tokenStore.saveSession(
                    res.token,
                    res.refreshToken,
                    res.user.email,
                    res.user.name,
                )
                authPrefs.edit().putString(KEY_LAST_EMAIL, res.user.email).apply()
                stopDeviceLoginQr()
                val offer = shouldOfferPasskey()
                _state.value = _state.value.copy(
                    loading = false,
                    needs2fa = false,
                    offerPasskey = offer,
                    loggedIn = !offer,
                    email = res.user.email,
                )
            } catch (e: HttpException) {
                val body = e.response()?.errorBody()?.string().orEmpty()
                val needs2fa = e.code() == 401 && (body.contains("2FA") || body.contains("needs2fa"))
                _state.value = _state.value.copy(
                    loading = false,
                    needs2fa = needs2fa,
                    error = if (needs2fa) "Entre ton code 2FA" else (body.ifBlank { e.message() }),
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    loading = false,
                    error = e.message ?: "Erreur de connexion",
                )
            }
        }
    }

    fun dismissPasskeyOffer() {
        prefs.edit().putBoolean(KEY_DISMISSED, true).apply()
        stopDeviceLoginQr()
        _state.value = _state.value.copy(offerPasskey = false, loggedIn = true)
    }

    override fun onCleared() {
        stopDeviceLoginQr()
        super.onCleared()
    }

    fun enrollPasskey(activityContext: android.content.Context) {
        viewModelScope.launch {
            _state.value = _state.value.copy(loading = true, error = null)
            try {
                val token = container.tokenStore.getAccess() ?: error("Session expirée")
                PasskeyAuth(activityContext, container.httpPlain).register(token, "Android")
                markPasskeyReady()
                stopDeviceLoginQr()
                _state.value = _state.value.copy(
                    loading = false,
                    offerPasskey = false,
                    showPasskeyLogin = true,
                    loggedIn = true,
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    loading = false,
                    error = e.message ?: "Échec enregistrement passkey",
                )
            }
        }
    }

    fun loginWithPasskey(activityContext: android.content.Context) {
        viewModelScope.launch {
            _state.value = _state.value.copy(loading = true, error = null)
            try {
                val auth = PasskeyAuth(activityContext, container.httpPlain)
                val tokens = auth.login(_state.value.email.ifBlank { null })
                container.tokenStore.saveSession(
                    tokens.token,
                    tokens.refreshToken,
                    tokens.email,
                    tokens.name,
                )
                markPasskeyReady()
                stopDeviceLoginQr()
                _state.value = _state.value.copy(
                    loading = false,
                    loggedIn = true,
                    showPasskeyLogin = true,
                )
            } catch (e: Exception) {
                _state.value = _state.value.copy(
                    loading = false,
                    error = e.message
                        ?: "Aucune passkey — connecte-toi au mot de passe pour en enregistrer une.",
                )
            }
        }
    }

    /** Appelé depuis AccountSheet après register réussi. */
    fun markPasskeyReady() {
        prefs.edit()
            .putBoolean(KEY_READY, true)
            .remove(KEY_DISMISSED)
            .apply()
        _state.value = _state.value.copy(showPasskeyLogin = true)
    }

    private fun shouldOfferPasskey(): Boolean {
        if (prefs.getBoolean(KEY_READY, false)) return false
        if (prefs.getBoolean(KEY_DISMISSED, false)) return false
        return true
    }

    companion object {
        private const val KEY_READY = "ready"
        private const val KEY_DISMISSED = "offer_dismissed"
        private const val KEY_LAST_EMAIL = "last_email"

        fun factory(container: AppContainer) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                AuthViewModel(container) as T
        }
    }
}
