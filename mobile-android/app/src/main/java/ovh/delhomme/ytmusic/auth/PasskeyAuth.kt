package ovh.delhomme.ytmusic.auth

import android.content.Context
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import ovh.delhomme.ytmusic.BuildConfig

/**
 * Passkeys via Android Credential Manager (pas de WebView).
 * Compatible biométrie appareil **et** gestionnaires (Bitwarden, Google Password Manager…).
 * L’origine attendue côté API est WEBAUTHN_ANDROID_ORIGINS (apk-key-hash).
 */
class PasskeyAuth(private val context: Context, private val http: OkHttpClient) {
    private val cm = CredentialManager.create(context)
    private val base = BuildConfig.API_BASE_URL.trimEnd('/')
    private val androidOrigin = BuildConfig.ANDROID_WEBAUTHN_ORIGIN
    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    suspend fun login(email: String?): AuthTokens {
        val optionsBody = JSONObject().apply {
            if (!email.isNullOrBlank()) put("email", email.trim())
        }
        val options = withContext(Dispatchers.IO) {
            postJson("/api/auth/passkeys/login/options", optionsBody, authed = false)
        }
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(GetPublicKeyCredentialOption(sanitizePublicKeyJson(options)))
            .build()
        val result = try {
            cm.getCredential(activityContext(), request)
        } catch (e: Exception) {
            throw Exception(friendlyGetError(e), e)
        }
        val cred = result.credential as? PublicKeyCredential
            ?: error("Réponse passkey invalide")
        val responseJson = JSONObject(cred.authenticationResponseJson)
        val verifyBody = JSONObject().put("credential", responseJson)
        val session = withContext(Dispatchers.IO) {
            postJson("/api/auth/passkeys/login/verify", verifyBody, authed = false)
        }
        return AuthTokens(
            token = session.getString("token"),
            refreshToken = session.optString("refreshToken").ifBlank { null },
            email = session.optJSONObject("user")?.optString("email"),
            name = session.optJSONObject("user")?.optString("name"),
        )
    }

    suspend fun register(accessToken: String, deviceName: String = "Android"): JSONObject {
        val options = withContext(Dispatchers.IO) {
            postJson(
                "/api/auth/passkeys/register/options",
                JSONObject(),
                authed = true,
                bearer = accessToken,
            )
        }
        val createReq = CreatePublicKeyCredentialRequest(
            /* requestJson = */ sanitizePublicKeyJson(options),
            /* clientDataHash = */ null,
            /* preferImmediatelyAvailableCredentials = */ false,
        )
        val result = try {
            cm.createCredential(activityContext(), createReq)
        } catch (e: Exception) {
            throw Exception(friendlyCreateError(e), e)
        }
        val response = result as? CreatePublicKeyCredentialResponse
            ?: error("Création passkey invalide")
        val responseJson = JSONObject(response.registrationResponseJson)
        val verifyBody = JSONObject()
            .put("credential", responseJson)
            .put("name", deviceName)
        return withContext(Dispatchers.IO) {
            postJson(
                "/api/auth/passkeys/register/verify",
                verifyBody,
                authed = true,
                bearer = accessToken,
            )
        }
    }

    private fun friendlyGetError(e: Throwable): String {
        return when (e) {
            is NoCredentialException ->
                "Aucune passkey trouvée. Active Bitwarden (ou GPM) comme fournisseur de passkeys " +
                    "dans Réglages Android, ou connecte-toi au mot de passe puis enregistre-en une."
            is GetCredentialCancellationException ->
                "Connexion passkey annulée."
            is GetCredentialException ->
                e.errorMessage?.toString()?.ifBlank { null }
                    ?: "Échec passkey — vérifie Bitwarden / empreinte."
            else -> e.message?.ifBlank { null }
                ?: "Échec connexion passkey."
        }
    }

    private fun friendlyCreateError(e: Throwable): String {
        return when (e) {
            is CreateCredentialCancellationException ->
                "Enregistrement passkey annulé."
            is CreateCredentialException ->
                e.errorMessage?.toString()?.ifBlank { null }
                    ?: "Échec enregistrement — choisis Bitwarden ou l’empreinte dans la feuille système."
            else -> e.message?.ifBlank { null }
                ?: "Échec enregistrement passkey."
        }
    }

    private fun activityContext(): android.content.Context {
        var c: android.content.Context? = context
        while (c is android.content.ContextWrapper) {
            if (c is android.app.Activity) return c
            c = c.baseContext
        }
        return context
    }

    /** Credential Manager (surtout Android 14+/Nothing) refuse parfois `hints`. */
    private fun sanitizePublicKeyJson(raw: JSONObject): String {
        raw.remove("hints")
        return raw.toString()
    }

    private fun postJson(
        path: String,
        body: JSONObject,
        authed: Boolean,
        bearer: String? = null,
    ): JSONObject {
        val req = Request.Builder()
            .url("$base$path")
            .header("Content-Type", "application/json")
            .header("Origin", androidOrigin)
            .header("X-Client", "android-kotlin")
            .apply {
                if (authed && !bearer.isNullOrBlank()) header("Authorization", "Bearer $bearer")
            }
            .post(body.toString().toRequestBody(jsonMedia))
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val err = runCatching { JSONObject(text).optString("error") }.getOrNull()
                error(err?.ifBlank { null } ?: "HTTP ${resp.code}")
            }
            return if (text.isBlank()) JSONObject() else JSONObject(text)
        }
    }
}

data class AuthTokens(
    val token: String,
    val refreshToken: String?,
    val email: String?,
    val name: String?,
)
