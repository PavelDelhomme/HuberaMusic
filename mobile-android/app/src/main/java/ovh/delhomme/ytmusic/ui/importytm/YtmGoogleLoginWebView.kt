package ovh.delhomme.ytmusic.ui.importytm

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import ovh.delhomme.ytmusic.debug.AppLog
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

private const val YTM_HOME = "https://music.youtube.com/"

private const val PAGE_KIND_JS =
    "(function(){try{var t=((document.body&&document.body.innerText)||'')+' '+(document.title||'');" +
        "t=t.toLowerCase();" +
        "if(/timeout|took too long|err_timed_out|this page isn.?t working/.test(t))return 'timeout';" +
        "if(/couldn.?t sign you in|may not be secure|disallowed_useragent/.test(t))return 'blocked';" +
        "return 'ok';}catch(e){return 'ok';}})()"

/**
 * Connexion Google dans l’app. « Continuer » ouvre YouTube Music puis capture
 * SAPISID — on ne reste plus coincé sur accounts.google.com.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun YtmGoogleLoginWebView(
    onCaptured: (cookie: String) -> Unit,
    onCancel: () -> Unit,
) {
    val context = LocalContext.current
    var progress by remember { mutableFloatStateOf(0f) }
    var status by remember { mutableStateOf("Connexion Google…") }
    var webView by remember { mutableStateOf<WebView?>(null) }
    var captured by remember { mutableStateOf(false) }
    var lastUrl by remember { mutableStateOf("") }
    val capturing = remember { AtomicBoolean(false) }
    val awaitingYtm = remember { AtomicBoolean(false) }
    val ytmErrorTries = remember { AtomicInteger(0) }
    val latestOnCaptured by rememberUpdatedState(onCaptured)

    fun tryCapture(reason: String, notifyIfIncomplete: Boolean = false) {
        if (captured) return
        val wv = webView
        val onHub = YtmCookieCapture.isYtmHub(lastUrl.ifBlank { wv?.url })
        if (!onHub && !notifyIfIncomplete) return
        if (!capturing.compareAndSet(false, true)) return

        fun finishCollect() {
            if (captured) {
                capturing.set(false)
                return
            }
            YtmCookieCapture.flush()
            val cookie = YtmCookieCapture.collect()
            val hubNow = YtmCookieCapture.isYtmHub(lastUrl.ifBlank { wv?.url })
            if (!hubNow || !YtmCookieCapture.isComplete(cookie)) {
                capturing.set(false)
                AppLog.w(
                    "ytm",
                    "capture incomplète ($reason) hub=$hubNow keys=${YtmCookieCapture.keySummary(cookie)} url=${lastUrl.take(120)}",
                )
                if (notifyIfIncomplete) {
                    status = "Pas encore de session YouTube Music — attends l’accueil, ou réessaie Continuer."
                    Toast.makeText(context, "Session YouTube Music pas encore prête", Toast.LENGTH_SHORT).show()
                }
                return
            }
            captured = true
            capturing.set(false)
            AppLog.i(
                "ytm",
                "cookies capturés ($reason) len=${cookie.length} keys=${YtmCookieCapture.keySummary(cookie)}",
            )
            latestOnCaptured(cookie)
        }

        if (wv == null) {
            finishCollect()
            return
        }
        val done = AtomicBoolean(false)
        fun onceFinish() {
            if (done.compareAndSet(false, true)) finishCollect()
        }
        wv.postDelayed({ onceFinish() }, 2_000)
        val posted = runCatching {
            wv.evaluateJavascript(
                "(function(){try{return document.cookie||''}catch(e){return ''}})()",
            ) { raw ->
                val js = YtmCookieCapture.decodeJsCookieString(raw)
                if (js.isNotBlank()) YtmCookieCapture.ingestJsCookies(wv, js)
                onceFinish()
            }
        }
        if (posted.isFailure) {
            AppLog.w("ytm", "evaluateJavascript", posted.exceptionOrNull())
            onceFinish()
        }
    }

    fun openYtm(reason: String) {
        val wv = webView ?: return
        if (captured) return
        if (YtmCookieCapture.isYtmHub(wv.url ?: lastUrl)) {
            tryCapture(reason, notifyIfIncomplete = true)
            return
        }
        val first = awaitingYtm.compareAndSet(false, true)
        if (!first && reason != "continuer") return
        awaitingYtm.set(true)
        status = "Ouverture de YouTube Music…"
        AppLog.i("ytm", "openYtm ($reason) from=${(wv.url ?: lastUrl).take(160)}")
        wv.loadUrl(YTM_HOME)
    }

    BackHandler {
        val wv = webView
        if (wv != null && wv.canGoBack()) wv.goBack() else onCancel()
    }

    LaunchedEffect(Unit) {
        while (isActive && !captured) {
            delay(1_500)
            val url = lastUrl
            when {
                YtmCookieCapture.isYtmHub(url) -> tryCapture("poll")
                YtmCookieCapture.isPostGoogleLogin(url) -> openYtm("poll-post-login")
                YtmCookieCapture.isConsent(url) -> { /* l’utilisateur doit accepter */ }
            }
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
                    TextButton(
                        onClick = {
                            Toast.makeText(context, "Ouverture de YouTube Music…", Toast.LENGTH_SHORT).show()
                            openYtm("continuer")
                        },
                    ) {
                        Text("Continuer")
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
                                onUrl = { lastUrl = it },
                                onYtmReady = { tryCapture(it) },
                                onLeaveGoogle = { openYtm(it) },
                                ytmErrorTries = ytmErrorTries,
                                awaitingYtm = awaitingYtm,
                            )
                            YtmCookieCapture.clearThen { post { loadUrl(YTM_HOME) } }
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
    onUrl: (String) -> Unit,
    onYtmReady: (reason: String) -> Unit,
    onLeaveGoogle: (reason: String) -> Unit,
    ytmErrorTries: AtomicInteger,
    awaitingYtm: AtomicBoolean,
) {
    val cm = CookieManager.getInstance()
    cm.setAcceptCookie(true)
    cm.setAcceptThirdPartyCookies(this, true)

    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    settings.javaScriptCanOpenWindowsAutomatically = false
    settings.setSupportMultipleWindows(false)
    settings.loadsImagesAutomatically = true
    settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
    settings.cacheMode = WebSettings.LOAD_DEFAULT
    if (Build.VERSION.SDK_INT >= 26) {
        settings.safeBrowsingEnabled = false
    }
    val ua = WebSettings.getDefaultUserAgent(context)
        .replace("; wv", "")
        .replace(" Version/4.0", "")
    settings.userAgentString = ua

    webChromeClient = object : WebChromeClient() {
        override fun onProgressChanged(view: WebView?, newProgress: Int) {
            onProgress(newProgress / 100f)
        }
    }

    webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
            val url = request?.url?.toString() ?: return false
            return interceptNonHttp(view, url)
        }

        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
            val host = url.orEmpty()
            onUrl(host)
            AppLog.i("ytm", "page ${host.take(180)}")
            onStatus(
                when {
                    YtmCookieCapture.isConsent(host) -> "Accepte pour continuer vers YouTube Music"
                    "accounts.google.com" in host -> "Connecte-toi (compte Google gratuit — pas Premium)"
                    YtmCookieCapture.isYtmHub(host) -> "YouTube Music — récupération automatique…"
                    else -> "Connexion Google…"
                },
            )
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            val host = url.orEmpty()
            onUrl(host)
            if (YtmCookieCapture.isYtmHub(host)) {
                awaitingYtm.set(false)
                ytmErrorTries.set(0)
                view?.postDelayed({ onYtmReady("page-ytm") }, 1_400)
                return
            }
            if (YtmCookieCapture.isPostGoogleLogin(host)) {
                view?.postDelayed({ onLeaveGoogle("post-login") }, 400)
                return
            }
            if ("accounts.google.com" in host) {
                view?.evaluateJavascript(PAGE_KIND_JS) { raw ->
                    val kind = YtmCookieCapture.decodeJsCookieString(raw)
                    if (kind == "timeout" || kind == "blocked") {
                        AppLog.w("ytm", "google page $kind url=${host.take(160)}")
                        if (YtmCookieCapture.hasGoogleSession()) {
                            onStatus("Google a coupé la page — on ouvre YouTube Music…")
                            onLeaveGoogle(kind)
                        } else {
                            onStatus("Google a échoué. Reconnecte-toi, puis appuie sur Continuer.")
                        }
                    }
                }
            }
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest?,
            error: WebResourceError?,
        ) {
            if (request?.isForMainFrame != true) return
            val url = request.url?.toString().orEmpty()
            val desc = error?.description?.toString().orEmpty()
            AppLog.w("ytm", "webview error ${error?.errorCode} $desc ${url.take(160)}")
            val timeoutish = (error?.errorCode ?: 0) in
                setOf(
                    WebViewClient.ERROR_TIMEOUT,
                    WebViewClient.ERROR_HOST_LOOKUP,
                    WebViewClient.ERROR_CONNECT,
                    WebViewClient.ERROR_IO,
                ) || desc.contains("TIMEOUT", true)
            if (!timeoutish) return
            if ("music.youtube.com" in url) {
                if (ytmErrorTries.getAndIncrement() < 2) {
                    onStatus("YouTube Music lent — nouvel essai…")
                    view.postDelayed({ view.loadUrl(YTM_HOME) }, 800)
                } else {
                    awaitingYtm.set(false)
                    onStatus("YouTube Music n’a pas chargé. Appuie sur Continuer.")
                }
                return
            }
            if (YtmCookieCapture.hasGoogleSession()) {
                awaitingYtm.set(false)
                onStatus("Timeout Google — ouverture de YouTube Music…")
                onLeaveGoogle("error-timeout")
            }
        }
    }
}

private fun interceptNonHttp(view: WebView?, url: String): Boolean {
    val lower = url.lowercase()
    if (lower.startsWith("http://") || lower.startsWith("https://")) return false
    AppLog.w("ytm", "url non-http ${url.take(180)}")
    if (lower.startsWith("intent:")) {
        val fallback = runCatching {
            val parsed = Uri.parse(url)
            parsed.getQueryParameter("browser_fallback_url")
                ?: Regex("browser_fallback_url=([^;]+)").find(url)?.groupValues?.getOrNull(1)
                    ?.let { Uri.decode(it) }
        }.getOrNull()
        if (!fallback.isNullOrBlank()) {
            view?.loadUrl(fallback)
            return true
        }
        view?.loadUrl(YTM_HOME)
        return true
    }
    return true
}
