package ovh.delhomme.ytmusic.data

import android.content.Context
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.MutableStateFlow
import okhttp3.Authenticator
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.Route
import okhttp3.logging.HttpLoggingInterceptor
import ovh.delhomme.ytmusic.BuildConfig
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.moshi.MoshiConverterFactory
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

class AppContainer(context: Context) {
    private val appContext = context.applicationContext
    /** Pour caches locaux (home, recherche…) hors DataStore. */
    fun sharedPrefs(name: String) =
        appContext.getSharedPreferences(name, Context.MODE_PRIVATE)
    val tokenStore = TokenStore(appContext)
    val quickAccess = QuickAccessStore(appContext)
    val homeCache = HomeCacheStore(appContext)
    val mixCache = MixCacheStore(appContext)
    /** Invalide le cache LibraryScreen (45s) après add/remove biblio. */
    val libraryEpoch = MutableStateFlow(0L)
    fun bumpLibraryEpoch() {
        libraryEpoch.value = System.currentTimeMillis()
    }
    val offlineStore by lazy { LocalOfflineStore(appContext, moshi) }
    val localPlayback by lazy { LocalPlaybackStore(appContext, moshi) }
    private val apiPrefs = appContext.getSharedPreferences("ytm_api", Context.MODE_PRIVATE)

    val deviceId: String by lazy {
        val prefs = appContext.getSharedPreferences("ytm_device", Context.MODE_PRIVATE)
        prefs.getString("id", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("id", it).apply()
        }
    }

    private val devicePrefs by lazy {
        appContext.getSharedPreferences("ytm_device", Context.MODE_PRIVATE)
    }

    /** Sync lecture multi-appareils (publier + recevoir). Défaut false = file locale. */
    fun receiveRemoteSync(): Boolean {
        // Migration one-shot : lectures indépendantes par défaut
        if (!devicePrefs.getBoolean("playback_sync_independent_v1", false)) {
            devicePrefs.edit()
                .putBoolean("receive_remote_sync", false)
                .putBoolean("playback_sync_independent_v1", true)
                .apply()
        }
        return devicePrefs.getBoolean("receive_remote_sync", false)
    }

    fun setReceiveRemoteSync(on: Boolean) {
        devicePrefs.edit()
            .putBoolean("receive_remote_sync", on)
            .putBoolean("playback_sync_independent_v1", true)
            .apply()
    }

    /** Base API sans slash final (override prefs > BuildConfig). */
    fun resolvedApiBase(): String {
        val override = apiPrefs.getString("base_url", null)?.trim()?.trimEnd('/')
        val raw = if (!override.isNullOrBlank()) override else BuildConfig.API_BASE_URL.trimEnd('/')
        // Sur device physique, 127.0.0.1 = le téléphone — bascule sur BuildConfig (LAN / prod).
        if (raw.contains("127.0.0.1") || raw.contains("localhost")) {
            val baked = BuildConfig.API_BASE_URL.trimEnd('/')
            if (baked.isNotBlank() && !baked.contains("127.0.0.1") && !baked.contains("localhost")) {
                if (!override.isNullOrBlank()) {
                    apiPrefs.edit().remove("base_url").apply()
                }
                return baked
            }
        }
        return raw
    }

    fun apiBaseOverride(): String? =
        apiPrefs.getString("base_url", null)?.trim()?.trimEnd('/')?.takeIf { it.isNotBlank() }

    /** Persiste une URL API (ex. http://192.168.1.134:8787). null = reset BuildConfig. */
    fun setApiBaseOverride(url: String?) {
        var cleaned = url?.trim()?.trimEnd('/')?.takeIf { it.isNotBlank() }
        // Refuse 127.0.0.1 sur téléphone : pointe le device, pas le PC.
        if (cleaned != null && (cleaned.contains("127.0.0.1") || cleaned.contains("localhost"))) {
            val baked = BuildConfig.API_BASE_URL.trimEnd('/')
            cleaned = if (!baked.contains("127.0.0.1") && !baked.contains("localhost")) {
                baked
            } else {
                null
            }
        }
        apiPrefs.edit().apply {
            if (cleaned == null) remove("base_url") else putString("base_url", cleaned)
        }.apply()
    }

    /** DEV = LAN / localhost ; PROD = HTTPS distant. */
    fun apiEnvKind(base: String = resolvedApiBase()): String {
        val u = base.trimEnd('/').lowercase()
        return when {
            u.startsWith("https://") &&
                !u.contains("127.0.0.1") &&
                !u.contains("localhost") &&
                !u.contains("192.168.") &&
                !u.contains("10.") -> "prod"
            else -> "dev"
        }
    }

    fun apiEnvLabel(base: String = resolvedApiBase()): String =
        if (apiEnvKind(base) == "prod") "PROD" else "DEV"

    private val moshi: Moshi = Moshi.Builder()
        // Avant KotlinJsonAdapterFactory : duration (et autres) string|number
        .add(FlexibleStringAdapter())
        .add(KotlinJsonAdapterFactory())
        .build()

    private val refreshLock = Any()

    private val rewriteHost = Interceptor { chain ->
        val preferred = (resolvedApiBase() + "/").toHttpUrlOrNull()
            ?: return@Interceptor chain.proceed(chain.request())
        val req = chain.request()
        val nextUrl = req.url.newBuilder()
            .scheme(preferred.scheme)
            .host(preferred.host)
            .port(preferred.port)
            .build()
        chain.proceed(req.newBuilder().url(nextUrl).build())
    }

    private val authInterceptor = Interceptor { chain ->
        // Cache mémoire d’abord — évite runBlocking DataStore à chaque heartbeat
        val token = tokenStore.peekAccess()
            ?: runCatching { runBlocking { tokenStore.getAccess() } }.getOrNull()
        val req = chain.request().newBuilder()
            .header("X-Device-Id", deviceId)
            .header("X-Device-Name", android.os.Build.MODEL ?: "Android")
            .apply {
                if (!token.isNullOrBlank()) header("Authorization", "Bearer $token")
            }
            .build()
        chain.proceed(req)
    }

    /** Client sans Authenticator (refresh / login) — évite les boucles 401. */
    private val plainClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .addInterceptor(rewriteHost)
        .addInterceptor(
            HttpLoggingInterceptor().apply {
                level = if (BuildConfig.DEBUG) {
                    HttpLoggingInterceptor.Level.BASIC
                } else {
                    HttpLoggingInterceptor.Level.NONE
                }
            },
        )
        .build()

    private val tokenAuthenticator = Authenticator { _: Route?, response: Response ->
        if (responseCount(response) >= 2) return@Authenticator null
        val path = response.request.url.encodedPath
        if (path.contains("/api/auth/login") ||
            path.contains("/api/auth/register") ||
            path.contains("/api/auth/refresh") ||
            path.contains("/api/auth/passkeys")
        ) {
            return@Authenticator null
        }
        val newToken = synchronized(refreshLock) {
            // Un autre thread a peut-être déjà refresh
            val current = tokenStore.peekAccess()
            val prevAuth = response.request.header("Authorization")
            if (!current.isNullOrBlank() && prevAuth != null && prevAuth != "Bearer $current") {
                return@synchronized current
            }
            runCatching { runBlocking { refreshAccessToken() } }.getOrNull()
        } ?: return@Authenticator null

        response.request.newBuilder()
            .header("Authorization", "Bearer $newToken")
            .build()
    }

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .addInterceptor(rewriteHost)
        .addInterceptor(authInterceptor)
        .authenticator(tokenAuthenticator)
        .addInterceptor(
            HttpLoggingInterceptor().apply {
                level = if (BuildConfig.DEBUG) {
                    HttpLoggingInterceptor.Level.BASIC
                } else {
                    HttpLoggingInterceptor.Level.NONE
                }
            },
        )
        .build()

    /** Client sans auth interceptor (passkeys login). */
    val httpPlain: OkHttpClient = plainClient

    val apiBaseUrl: String
        get() = resolvedApiBase().trimEnd('/') + "/"

    private val refreshApi: YtMusicApi = Retrofit.Builder()
        .baseUrl(BuildConfig.API_BASE_URL.trimEnd('/') + "/")
        .client(plainClient)
        .addConverterFactory(MoshiConverterFactory.create(moshi))
        .build()
        .create(YtMusicApi::class.java)

    val api: YtMusicApi = Retrofit.Builder()
        .baseUrl(BuildConfig.API_BASE_URL.trimEnd('/') + "/")
        .client(client)
        .addConverterFactory(MoshiConverterFactory.create(moshi))
        .build()
        .create(YtMusicApi::class.java)

    fun streamUrl(trackId: String): String {
        offlineStore.playUri(trackId)?.let { return it.toString() }
        // Toujours via proxy API : les URLs googlevideo sont liées à l’IP du serveur
        // (?redirect=1 → 403 depuis le téléphone / autre réseau).
        val base = resolvedApiBase() + "/api/stream/$trackId"
        val token = tokenStore.peekAccess()
        return if (!token.isNullOrBlank()) {
            "$base?access_token=${java.net.URLEncoder.encode(token, Charsets.UTF_8.name())}"
        } else {
            base
        }
    }

    /** Stream vidéo progressif (onglet Vidéo) — muet, syncé sur l’audio. */
    fun videoStreamUrl(trackId: String): String {
        val base = resolvedApiBase() + "/api/stream/$trackId?type=video"
        val token = tokenStore.peekAccess()
        return if (!token.isNullOrBlank()) {
            "$base&access_token=${java.net.URLEncoder.encode(token, Charsets.UTF_8.name())}"
        } else {
            base
        }
    }

    /** URL HTTP stream uniquement (pour télécharger en local). */
    fun remoteStreamUrl(trackId: String): String {
        val base = resolvedApiBase() + "/api/stream/$trackId"
        val token = tokenStore.peekAccess()
        return if (!token.isNullOrBlank()) {
            "$base?access_token=${java.net.URLEncoder.encode(token, Charsets.UTF_8.name())}"
        } else {
            base
        }
    }

    /** Pré-chauffe le resolve youtubei côté API (piste courante + suivantes). */
    fun warmStreamUrl(trackId: String): String =
        resolvedApiBase() + "/api/stream/$trackId/url"

    /** Ping /api/health sur l’URL courante (ou une URL candidate). */
    suspend fun probeApiHealth(baseUrl: String? = null): Result<String> {
        val base = (baseUrl ?: resolvedApiBase()).trimEnd('/')
        return runCatching {
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                val probeClient = OkHttpClient.Builder()
                    .connectTimeout(8, TimeUnit.SECONDS)
                    .readTimeout(8, TimeUnit.SECONDS)
                    .build()
                val req = okhttp3.Request.Builder()
                    .url("$base/api/health")
                    .get()
                    .build()
                probeClient.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) error("HTTP ${resp.code}")
                    resp.body?.string()?.take(180) ?: "ok"
                }
            }
        }
    }

    /**
     * Refresh JWT via client « plain » (pas d’Authenticator).
     * Ne clear la session que sur erreur d’auth (401/403), jamais sur timeout / API down.
     */
    private suspend fun refreshAccessToken(): String? {
        val refresh = tokenStore.getRefresh()
        if (refresh.isNullOrBlank()) {
            return null
        }
        return try {
            val r = refreshApi.refresh(RefreshBody(refresh))
            tokenStore.saveSession(
                r.token,
                r.refreshToken ?: refresh,
                r.user.email,
                r.user.name,
            )
            r.token
        } catch (e: Exception) {
            if (isAuthFailure(e)) {
                tokenStore.clear()
            }
            null
        }
    }

    /**
     * Garde un access token utilisable.
     * Ne se fie PAS uniquement à l’exp JWT (secret API peut avoir changé).
     */
    suspend fun ensureFreshToken(): Boolean {
        tokenStore.warmCache()
        val access = tokenStore.getAccess()
        val refresh = tokenStore.getRefresh()
        if (access.isNullOrBlank() && refresh.isNullOrBlank()) return false

        val ttl = if (!access.isNullOrBlank()) jwtExpiresInMs(access) else -1L
        // Access encore loin de l’expiration → OK (Authenticator rattrape un 401 réel)
        if (ttl > 60_000L) return true

        if (refresh.isNullOrBlank()) {
            // Pas de refresh : garder l’access tant qu’il n’est pas expiré
            return ttl > 0
        }
        // Refresh échoué réseau → rester OK si access encore un peu valide
        if (refreshAccessToken() != null) return true
        return ttl > 0 || !tokenStore.getAccess().isNullOrBlank()
    }

    /**
     * Validation au démarrage.
     * Tokens présents + API injoignable → reste connecté (mode dégradé).
     * Clear uniquement sur rejet auth explicite.
     */
    suspend fun validateSession(): Boolean {
        tokenStore.warmCache()
        val access = tokenStore.getAccess()
        val refresh = tokenStore.getRefresh()
        if (access.isNullOrBlank() && refresh.isNullOrBlank()) return false

        val meResult = runCatching { api.me() }
        if (meResult.getOrNull()?.user != null) return true

        val err = meResult.exceptionOrNull()
        if (isNetworkFailure(err)) {
            // API LAN down / Wi‑Fi pas prêt — ne pas déconnecter
            return true
        }

        if (refresh.isNullOrBlank()) {
            if (isAuthFailure(err)) tokenStore.clear()
            // Autre erreur HTTP sans refresh : garder si access encore là et pas auth
            return !isAuthFailure(err) && !access.isNullOrBlank()
        }

        if (refreshAccessToken() == null) {
            // Auth wipe déjà fait dans refreshAccessToken si 401 ;
            // réseau → tokens encore là → rester connecté
            return !tokenStore.getRefresh().isNullOrBlank() ||
                !tokenStore.getAccess().isNullOrBlank()
        }
        val me2 = runCatching { api.me() }
        if (me2.getOrNull()?.user != null) return true
        return isNetworkFailure(me2.exceptionOrNull())
    }

    companion object {
        fun isNetworkFailure(t: Throwable?): Boolean {
            var e = t
            while (e != null) {
                if (e is IOException) return true
                e = e.cause
            }
            return false
        }

        fun isAuthFailure(t: Throwable?): Boolean {
            var e = t
            while (e != null) {
                if (e is HttpException && (e.code() == 401 || e.code() == 403)) return true
                e = e.cause
            }
            return false
        }

        /** Decode JWT exp sans vérif crypto (indicatif client). */
        fun jwtExpiresInMs(jwt: String): Long {
            return try {
                val parts = jwt.split('.')
                if (parts.size < 2) return 0L
                val padded = parts[1]
                    .replace('-', '+')
                    .replace('_', '/')
                    .let {
                        val rem = it.length % 4
                        if (rem == 0) it else it + "=".repeat(4 - rem)
                    }
                val json = String(android.util.Base64.decode(padded, android.util.Base64.DEFAULT))
                val exp = Regex("\"exp\"\\s*:\\s*(\\d+)").find(json)?.groupValues?.get(1)?.toLongOrNull()
                    ?: return 0L
                exp * 1000L - System.currentTimeMillis()
            } catch (_: Exception) {
                0L
            }
        }

        private fun responseCount(response: Response): Int {
            var n = 1
            var prior: Response? = response.priorResponse
            while (prior != null) {
                n++
                prior = prior.priorResponse
            }
            return n
        }
    }
}
