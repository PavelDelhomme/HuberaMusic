package cloud.hubera.id.sso

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import org.json.JSONObject

/**
 * SSO inter-apps Hubera : ContentProvider (signature) + AccountManager type [HuberaIdPeers.ACCOUNT_TYPE].
 */
object HuberaIdAccounts {

    fun listAccounts(ctx: Context): List<HuberaIdAccount> {
        val best = linkedMapOf<String, HuberaIdAccount>()
        for (acc in listAllCopies(ctx)) {
            val prev = best[acc.email]
            if (prev == null || acc.updatedAt >= prev.updatedAt) {
                best[acc.email] = acc
            }
        }
        return best.values.toList()
    }

    fun listAllCopies(ctx: Context): List<HuberaIdAccount> {
        val out = mutableListOf<HuberaIdAccount>()
        val pkgs = (HuberaIdPeers.packages + ctx.packageName).distinct()
        for (pkg in pkgs) {
            queryProvider(
                ctx,
                Uri.parse("content://${HuberaIdPeers.huberaAuthority(pkg)}/accounts"),
                hubera = true,
                fallbackPkg = pkg,
            )?.let { out.addAll(it) }
            queryProvider(
                ctx,
                Uri.parse("content://${HuberaIdPeers.cloudityAuthority(pkg)}/accounts"),
                hubera = false,
                fallbackPkg = pkg,
            )?.let { out.addAll(it) }
        }
        out.addAll(listFromAccountManager(ctx))
        return out
    }

    fun saveSession(
        ctx: Context,
        email: String,
        accessToken: String,
        refreshToken: String,
        displayName: String = "",
        issuer: String = "hubera-id",
        gatewayUrl: String = "",
        tenantId: Int = 1,
    ) {
        val clean = email.trim().lowercase()
        if (clean.isEmpty()) return
        val now = System.currentTimeMillis()
        val values = ContentValues().apply {
            put(HuberaIdProvider.COL_EMAIL, clean)
            put(HuberaIdProvider.COL_ACCESS, accessToken)
            put(HuberaIdProvider.COL_REFRESH, refreshToken)
            put(HuberaIdProvider.COL_NAME, displayName)
            put(HuberaIdProvider.COL_ISSUER, issuer)
            put(HuberaIdProvider.COL_GATEWAY, gatewayUrl)
            put(HuberaIdProvider.COL_TENANT, tenantId)
            put(HuberaIdProvider.COL_UPDATED_AT, now)
        }
        val pkgs = (HuberaIdPeers.packages + ctx.packageName).distinct()
        for (pkg in pkgs) {
            runCatching {
                ctx.contentResolver.insert(
                    Uri.parse("content://${HuberaIdPeers.huberaAuthority(pkg)}/accounts"),
                    values,
                )
            }
            runCatching {
                ctx.contentResolver.insert(
                    Uri.parse("content://${HuberaIdPeers.cloudityAuthority(pkg)}/accounts"),
                    values,
                )
            }
        }
        saveToAccountManager(ctx, clean, accessToken, refreshToken, displayName, issuer)
    }

    fun clearAccount(ctx: Context, email: String) {
        val clean = email.trim().lowercase()
        if (clean.isEmpty()) return
        val pkgs = (HuberaIdPeers.packages + ctx.packageName).distinct()
        for (pkg in pkgs) {
            runCatching {
                ctx.contentResolver.delete(
                    Uri.parse("content://${HuberaIdPeers.huberaAuthority(pkg)}/accounts/$clean"),
                    null,
                    null,
                )
            }
            runCatching {
                ctx.contentResolver.delete(
                    Uri.parse("content://${HuberaIdPeers.cloudityAuthority(pkg)}/accounts/$clean"),
                    null,
                    null,
                )
            }
        }
        runCatching {
            val am = AccountManager.get(ctx)
            for (acc in am.getAccountsByType(HuberaIdPeers.ACCOUNT_TYPE)) {
                if (acc.name.equals(clean, ignoreCase = true)) {
                    am.removeAccountExplicitly(acc)
                }
            }
        }
    }

    private fun queryProvider(
        ctx: Context,
        uri: Uri,
        hubera: Boolean,
        fallbackPkg: String,
    ): List<HuberaIdAccount>? {
        return try {
            ctx.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
                val emailIdx = cursor.getColumnIndex(HuberaIdProvider.COL_EMAIL)
                val accessIdx = cursor.getColumnIndex(HuberaIdProvider.COL_ACCESS)
                val refreshIdx = cursor.getColumnIndex(HuberaIdProvider.COL_REFRESH)
                val nameIdx = cursor.getColumnIndex(HuberaIdProvider.COL_NAME)
                val issuerIdx = cursor.getColumnIndex(HuberaIdProvider.COL_ISSUER)
                val gwIdx = cursor.getColumnIndex(HuberaIdProvider.COL_GATEWAY)
                val tenantIdx = cursor.getColumnIndex(HuberaIdProvider.COL_TENANT)
                val sourceIdx = cursor.getColumnIndex(HuberaIdProvider.COL_SOURCE)
                val updatedIdx = cursor.getColumnIndex(HuberaIdProvider.COL_UPDATED_AT)
                val rows = mutableListOf<HuberaIdAccount>()
                while (cursor.moveToNext()) {
                    val email = if (emailIdx >= 0) cursor.getString(emailIdx).orEmpty() else ""
                    if (email.isBlank()) continue
                    val access = if (accessIdx >= 0) cursor.getString(accessIdx).orEmpty() else ""
                    val refresh = if (refreshIdx >= 0) cursor.getString(refreshIdx).orEmpty() else ""
                    if (access.isBlank() && refresh.isBlank()) continue
                    rows.add(
                        HuberaIdAccount(
                            email = email.trim().lowercase(),
                            accessToken = access,
                            refreshToken = refresh,
                            displayName = if (nameIdx >= 0) cursor.getString(nameIdx).orEmpty() else "",
                            issuer = when {
                                issuerIdx >= 0 -> cursor.getString(issuerIdx).orEmpty().ifBlank {
                                    if (hubera) "hubera-id" else "cloudity"
                                }
                                hubera -> "hubera-id"
                                else -> "cloudity"
                            },
                            gatewayUrl = if (gwIdx >= 0) cursor.getString(gwIdx).orEmpty() else "",
                            tenantId = if (tenantIdx >= 0) cursor.getInt(tenantIdx) else 1,
                            sourcePackage = if (sourceIdx >= 0) {
                                cursor.getString(sourceIdx).orEmpty().ifEmpty { fallbackPkg }
                            } else {
                                fallbackPkg
                            },
                            updatedAt = if (updatedIdx >= 0) cursor.getLong(updatedIdx) else jwtExpMillis(access),
                        ),
                    )
                }
                rows
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun listFromAccountManager(ctx: Context): List<HuberaIdAccount> {
        return try {
            val am = AccountManager.get(ctx)
            am.getAccountsByType(HuberaIdPeers.ACCOUNT_TYPE).map { acc ->
                val access = am.peekAuthToken(acc, HuberaIdPeers.TOKEN_ACCESS).orEmpty()
                val refresh = am.getPassword(acc).orEmpty().ifBlank {
                    am.peekAuthToken(acc, HuberaIdPeers.TOKEN_REFRESH).orEmpty()
                }
                HuberaIdAccount(
                    email = acc.name.trim().lowercase(),
                    accessToken = access,
                    refreshToken = refresh,
                    displayName = am.getUserData(acc, "display_name").orEmpty(),
                    issuer = am.getUserData(acc, "issuer").orEmpty().ifBlank { "hubera-id" },
                    sourcePackage = "account-manager",
                    updatedAt = am.getUserData(acc, "updated_at")?.toLongOrNull() ?: 0L,
                )
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun saveToAccountManager(
        ctx: Context,
        email: String,
        accessToken: String,
        refreshToken: String,
        displayName: String,
        issuer: String,
    ) {
        runCatching {
            val am = AccountManager.get(ctx)
            val account = Account(email, HuberaIdPeers.ACCOUNT_TYPE)
            val extras = Bundle().apply {
                putString("display_name", displayName)
                putString("issuer", issuer)
                putString("updated_at", System.currentTimeMillis().toString())
            }
            val added = am.addAccountExplicitly(account, refreshToken, extras)
            if (!added) {
                am.setPassword(account, refreshToken)
                am.setUserData(account, "display_name", displayName)
                am.setUserData(account, "issuer", issuer)
                am.setUserData(account, "updated_at", System.currentTimeMillis().toString())
            }
            if (accessToken.isNotBlank()) {
                am.setAuthToken(account, HuberaIdPeers.TOKEN_ACCESS, accessToken)
            }
            if (refreshToken.isNotBlank()) {
                am.setAuthToken(account, HuberaIdPeers.TOKEN_REFRESH, refreshToken)
            }
        }
    }

    fun jwtExpMillis(token: String): Long {
        val seconds = jwtExpSeconds(token)
        return if (seconds > 0) seconds * 1000L else 0L
    }

    fun jwtEmail(token: String): String {
        if (token.isBlank()) return ""
        return try {
            val obj = jwtPayload(token) ?: return ""
            obj.optString("email").ifBlank { obj.optString("sub") }
                .trim()
                .lowercase()
        } catch (_: Exception) {
            ""
        }
    }

    private fun jwtExpSeconds(token: String): Long {
        val obj = jwtPayload(token) ?: return 0L
        return obj.optLong("exp", 0L)
    }

    private fun jwtPayload(token: String): JSONObject? {
        if (token.isEmpty()) return null
        return try {
            val parts = token.split('.')
            if (parts.size < 2) return null
            var b64 = parts[1].replace('-', '+').replace('_', '/')
            when (b64.length % 4) {
                2 -> b64 += "=="
                3 -> b64 += "="
                1 -> return null
            }
            JSONObject(String(Base64.decode(b64, Base64.DEFAULT)))
        } catch (_: Exception) {
            null
        }
    }
}
