package ovh.delhomme.ytmusic.ui.importytm

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.os.Build
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebView.WebViewTransport
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import ovh.delhomme.ytmusic.debug.AppLog

private const val START_URL =
    "https://accounts.google.com/ServiceLogin?service=youtube&passive=true" +
        "&continue=https%3A%2F%2Fmusic.youtube.com%2F&hl=fr"

/**
 * Connexion Google dans l’app. Dès que YouTube Music a déposé SAPISID / PSID,
 * on remonte la ligne Cookie — pas de copier-coller, pas de Premium.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun YtmGoogleLoginWebView(
    onCaptured: (cookie: String) -> Unit,
    onCancel: () -> Unit,
) {
    var progress by remember { mutableFloatStateOf(0f) }
    var status by remember { mutableStateOf("Connexion Google…") }
    var webView by remember { mutableStateOf<WebView?>(null) }
    var captured by remember { mutableStateOf(false) }
    val latestOnCaptured by rememberUpdatedState(onCaptured)

    fun tryCapture(reason: String, notifyIfIncomplete: Boolean = false) {
        if (captured) return
        YtmCookieCapture.flush()
        val cookie = YtmCookieCapture.collect()
        if (!YtmCookieCapture.isComplete(cookie)) {
            if (notifyIfIncomplete) {
                status = "Pas encore prêt — connecte-toi jusqu’à voir YouTube Music, puis réessaie."
            }
            return
        }
        captured = true
        AppLog.i("ytm", "cookies capturés ($reason) len=${cookie.length}")
        latestOnCaptured(cookie)
    }

    BackHandler {
        val wv = webView
        if (wv != null && wv.canGoBack()) wv.goBack() else onCancel()
    }

    LaunchedEffect(Unit) {
        while (isActive && !captured) {
            delay(1_400)
            tryCapture("poll")
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            webView?.apply {
                stopLoading()
                destroy()
            }
            webView = null
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Compte Google") },
                navigationIcon = {
                    IconButton(onClick = onCancel) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Annuler")
                    }
                },
                actions = {
                    TextButton(onClick = { tryCapture("manuel", notifyIfIncomplete = true) }) {
                        Text("J’ai validé")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            if (progress in 0.01f..0.99f) {
                LinearProgressIndicator(
                    progress = { progress },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Text(
                status,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            Box(Modifier.fillMaxSize()) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        WebView(ctx).apply {
                            webView = this
                            setupYtmWebView(
                                onProgress = { progress = it },
                                onStatus = { status = it },
                                onMaybeReady = { tryCapture(it) },
                            )
                            loadUrl(START_URL)
                        }
                    },
                )
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
private fun WebView.setupYtmWebView(
    onProgress: (Float) -> Unit,
    onStatus: (String) -> Unit,
    onMaybeReady: (reason: String) -> Unit,
) {
    val cm = CookieManager.getInstance()
    cm.setAcceptCookie(true)
    cm.setAcceptThirdPartyCookies(this, true)

    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.javaScriptCanOpenWindowsAutomatically = true
    settings.setSupportMultipleWindows(true)
    settings.loadsImagesAutomatically = true
    settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
    settings.cacheMode = WebSettings.LOAD_DEFAULT
    if (Build.VERSION.SDK_INT >= 26) {
        settings.safeBrowsingEnabled = false
    }
    // Google refuse le UA « wv » (WebView). On se fait passer pour Chrome.
    val ua = WebSettings.getDefaultUserAgent(context)
        .replace("; wv", "")
        .replace(" Version/4.0", "")
    settings.userAgentString = ua

    webChromeClient = object : WebChromeClient() {
        override fun onProgressChanged(view: WebView?, newProgress: Int) {
            onProgress(newProgress / 100f)
        }

        override fun onCreateWindow(
            view: WebView?,
            isDialog: Boolean,
            isUserGesture: Boolean,
            resultMsg: android.os.Message?,
        ): Boolean {
            val transport = resultMsg?.obj as? WebViewTransport ?: return false
            transport.webView = view
            resultMsg.sendToTarget()
            return true
        }
    }

    webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
            return false
        }

        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
            val host = url.orEmpty()
            onStatus(
                when {
                    "accounts.google.com" in host -> "Connecte-toi (compte Google gratuit — pas Premium)"
                    "music.youtube.com" in host -> "YouTube Music — récupération automatique…"
                    else -> "Connexion Google…"
                },
            )
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            val host = url.orEmpty()
            if ("music.youtube.com" in host && "ServiceLogin" !in host && "signin" !in host.lowercase()) {
                view?.postDelayed({ onMaybeReady("page-ytm") }, 700)
            } else if ("accounts.google.com" !in host) {
                view?.postDelayed({ onMaybeReady("page") }, 1_200)
            }
        }
    }
}
