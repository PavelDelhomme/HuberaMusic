package cloud.hubera.id.sso

import android.accounts.AbstractAccountAuthenticator
import android.accounts.Account
import android.accounts.AccountAuthenticatorResponse
import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import android.os.Bundle

class HuberaIdAuthenticator(private val context: Context) : AbstractAccountAuthenticator(context) {

    override fun addAccount(
        response: AccountAuthenticatorResponse?,
        accountType: String?,
        authTokenType: String?,
        requiredFeatures: Array<out String>?,
        options: Bundle?,
    ): Bundle {
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: Intent(Intent.ACTION_MAIN).setPackage(context.packageName)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        intent.putExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE, response)
        return Bundle().apply { putParcelable(AccountManager.KEY_INTENT, intent) }
    }

    override fun getAuthToken(
        response: AccountAuthenticatorResponse?,
        account: Account,
        authTokenType: String?,
        options: Bundle?,
    ): Bundle {
        val am = AccountManager.get(context)
        val type = authTokenType ?: HuberaIdPeers.TOKEN_ACCESS
        var token = am.peekAuthToken(account, type).orEmpty()
        if (token.isBlank() && type == HuberaIdPeers.TOKEN_ACCESS) {
            token = HuberaIdAccounts.listAccounts(context)
                .firstOrNull { it.email.equals(account.name, ignoreCase = true) }
                ?.accessToken
                .orEmpty()
        }
        if (token.isBlank() && type == HuberaIdPeers.TOKEN_REFRESH) {
            token = am.getPassword(account).orEmpty()
        }
        if (token.isBlank()) {
            return addAccount(response, account.type, type, null, options)
        }
        return Bundle().apply {
            putString(AccountManager.KEY_ACCOUNT_NAME, account.name)
            putString(AccountManager.KEY_ACCOUNT_TYPE, account.type)
            putString(AccountManager.KEY_AUTHTOKEN, token)
        }
    }

    override fun getAuthTokenLabel(authTokenType: String?): String = "Hubera ID"

    override fun confirmCredentials(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        options: Bundle?,
    ): Bundle? = null

    override fun updateCredentials(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        authTokenType: String?,
        options: Bundle?,
    ): Bundle = addAccount(response, account?.type, authTokenType, null, options)

    override fun hasFeatures(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        features: Array<out String>?,
    ): Bundle = Bundle().apply { putBoolean(AccountManager.KEY_BOOLEAN_RESULT, false) }

    override fun editProperties(
        response: AccountAuthenticatorResponse?,
        accountType: String?,
    ): Bundle = Bundle()
}
