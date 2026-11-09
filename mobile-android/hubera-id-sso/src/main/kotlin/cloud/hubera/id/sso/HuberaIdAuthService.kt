package cloud.hubera.id.sso

import android.app.Service
import android.content.Intent
import android.os.IBinder

class HuberaIdAuthService : Service() {
    private lateinit var authenticator: HuberaIdAuthenticator

    override fun onCreate() {
        super.onCreate()
        authenticator = HuberaIdAuthenticator(applicationContext)
    }

    override fun onBind(intent: Intent?): IBinder = authenticator.iBinder
}
