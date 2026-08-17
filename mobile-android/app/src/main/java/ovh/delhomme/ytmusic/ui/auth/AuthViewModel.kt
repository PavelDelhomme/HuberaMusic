package ovh.delhomme.ytmusic.ui.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.BuildConfig
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
)

class AuthViewModel(private val container: AppContainer) : ViewModel() {
    private val prefs = container.sharedPrefs("ytm_passkey")

    private val _state = MutableStateFlow(AuthUiState())
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
            }
        }
    }

    fun updateEmail(v: String) { _state.value = _state.value.copy(email = v, error = null) }
    fun updatePassword(v: String) { _state.value = _state.value.copy(password = v, error = null) }
    fun updateName(v: String) { _state.value = _state.value.copy(name = v) }
    fun updateTotp(v: String) { _state.value = _state.value.copy(totp = v) }
    fun toggleMode() {
        if (!_state.value.allowRegister && !_state.value.registerMode) return
        _state.value = _state.value.copy(registerMode = !_state.value.registerMode, error = null)
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
                val offer = shouldOfferPasskey()
                _state.value = _state.value.copy(
                    loading = false,
                    needs2fa = false,
                    offerPasskey = offer,
                    loggedIn = !offer,
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
        _state.value = _state.value.copy(offerPasskey = false, loggedIn = true)
    }

    fun enrollPasskey(activityContext: android.content.Context) {
        viewModelScope.launch {
            _state.value = _state.value.copy(loading = true, error = null)
            try {
                val token = container.tokenStore.getAccess() ?: error("Session expirée")
                PasskeyAuth(activityContext, container.httpPlain).register(token, "Android")
                markPasskeyReady()
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

        fun factory(container: AppContainer) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                AuthViewModel(container) as T
        }
    }
}
