package ovh.delhomme.ytmusic.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore("ytmusic_prefs")

class TokenStore(private val context: Context) {
    private val accessKey = stringPreferencesKey("access_token")
    private val refreshKey = stringPreferencesKey("refresh_token")
    private val emailKey = stringPreferencesKey("user_email")
    private val nameKey = stringPreferencesKey("user_name")

    @Volatile
    private var cachedAccess: String? = null

    @Volatile
    private var cachedRefresh: String? = null

    val accessToken: Flow<String?> = context.dataStore.data.map { it[accessKey] }
    val userEmail: Flow<String?> = context.dataStore.data.map { it[emailKey] }

    /** Lecture synchrone cache (OkHttp interceptor) — sans bloquer DataStore. */
    fun peekAccess(): String? = cachedAccess

    suspend fun getEmail(): String? =
        context.dataStore.data.first()[emailKey]?.trim()?.takeIf { it.isNotBlank() }

    suspend fun getAccess(): String? {
        val v = context.dataStore.data.first()[accessKey]
        cachedAccess = v
        return v
    }

    suspend fun getRefresh(): String? {
        val v = context.dataStore.data.first()[refreshKey]
        cachedRefresh = v
        return v
    }

    suspend fun saveSession(token: String, refresh: String?, email: String?, name: String?) {
        cachedAccess = token
        if (refresh != null) cachedRefresh = refresh
        context.dataStore.edit {
            it[accessKey] = token
            if (refresh != null) it[refreshKey] = refresh
            if (email != null) it[emailKey] = email
            if (name != null) it[nameKey] = name
        }
    }

    suspend fun clear() {
        cachedAccess = null
        cachedRefresh = null
        context.dataStore.edit { it.clear() }
    }

    /** Précharge le cache au démarrage (Activity / Application). */
    suspend fun warmCache() {
        getAccess()
        getRefresh()
    }
}
