package ovh.delhomme.ytmusic.ui.util

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.widget.Toast

/**
 * Toast toujours sur le Main looper.
 * `AppContainer.appScope` est en [Dispatchers.IO] — un Toast direct y crash
 * (`Can't toast on a thread that has not called Looper.prepare()`).
 */
fun Context.toastMain(
    message: CharSequence,
    length: Int = Toast.LENGTH_SHORT,
) {
    val appCtx = applicationContext
    val show = Runnable { Toast.makeText(appCtx, message, length).show() }
    if (Looper.myLooper() == Looper.getMainLooper()) {
        show.run()
    } else {
        Handler(Looper.getMainLooper()).post(show)
    }
}
