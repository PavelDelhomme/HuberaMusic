package ovh.delhomme.ytmusic

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.LibraryMusic
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import android.widget.Toast
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.zIndex
import kotlin.math.roundToInt
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.BuildConfig
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.ListenBody
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.data.buildRadioQueue
import ovh.delhomme.ytmusic.data.fetchAutoplayTracksFast
import ovh.delhomme.ytmusic.data.resolveArtistId
import ovh.delhomme.ytmusic.player.PlaybackService
import ovh.delhomme.ytmusic.player.PlayerController
import ovh.delhomme.ytmusic.ui.auth.LoginScreen
import ovh.delhomme.ytmusic.ui.components.AddToPlaylistSheet
import ovh.delhomme.ytmusic.ui.components.CastSheet
import ovh.delhomme.ytmusic.ui.components.LocalNowPlaying
import ovh.delhomme.ytmusic.ui.components.MiniPlayerBar
import ovh.delhomme.ytmusic.ui.components.NowPlayingInfo
import ovh.delhomme.ytmusic.ui.components.TrackActionsSheet
import ovh.delhomme.ytmusic.ui.debug.DebugLogsScreen
import ovh.delhomme.ytmusic.ui.detail.ArtistDetailScreen
import ovh.delhomme.ytmusic.debug.AppLog
import ovh.delhomme.ytmusic.ui.detail.ArtistSongsScreen
import ovh.delhomme.ytmusic.ui.importytm.YtmImportScreen
import ovh.delhomme.ytmusic.ui.detail.CollectionDetailScreen
import ovh.delhomme.ytmusic.ui.detail.DetailKind
import ovh.delhomme.ytmusic.ui.home.HomeScreen
import ovh.delhomme.ytmusic.ui.library.LibraryFilter
import ovh.delhomme.ytmusic.ui.library.LibraryScreen
import ovh.delhomme.ytmusic.ui.player.NowPlayingScreen
import ovh.delhomme.ytmusic.ui.prefs.RecoPrefsScreen
import ovh.delhomme.ytmusic.ui.search.SearchScreen
import ovh.delhomme.ytmusic.ui.theme.YtMusicTheme
import androidx.navigation.NavType
import androidx.navigation.navArgument

class MainActivity : ComponentActivity() {
    private val notifPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* ignore */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Splash → thème app après le premier frame
        setTheme(R.style.Theme_YTMusic)
        enableEdgeToEdge()
        if (Build.VERSION.SDK_INT >= 33) {
            val ok = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            if (ok != PackageManager.PERMISSION_GRANTED) {
                notifPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        val app = application as YtMusicApp
        setContent {
            YtMusicTheme {
                YtMusicAppContent(
                    container = app.container,
                    openPlayerFromIntent = intent?.getBooleanExtra(EXTRA_OPEN_PLAYER, false) == true,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    companion object {
        const val EXTRA_OPEN_PLAYER = "ovh.delhomme.ytmusic.OPEN_PLAYER"
        /** Injection session (tests ADB) — build debug uniquement. */
        const val EXTRA_ACCESS_TOKEN = "ytm_access_token"
        const val EXTRA_REFRESH_TOKEN = "ytm_refresh_token"
        const val EXTRA_USER_EMAIL = "ytm_user_email"

        fun parseDeviceLogin(uri: Uri?): DeviceLoginDeepLink? {
            if (uri == null) return null
            val isHttps =
                (uri.scheme == "https" || uri.scheme == "http") &&
                    uri.host?.contains("ytmusic") == true &&
                    (uri.path?.startsWith("/login-device") == true)
            val isCustom = uri.scheme == "ytmusic" && uri.host == "login-device"
            if (!isHttps && !isCustom) return null
            val claim = uri.getQueryParameter("claim")?.trim().orEmpty()
            if (claim.isNotEmpty()) return DeviceLoginDeepLink.Claim(claim)
            val id = uri.getQueryParameter("id")?.trim().orEmpty()
            val code = uri.getQueryParameter("code")?.trim().orEmpty()
            if (id.isNotEmpty() && code.isNotEmpty()) return DeviceLoginDeepLink.Approve(id, code)
            return null
        }
    }
}

sealed class DeviceLoginDeepLink {
    data class Approve(val id: String, val code: String) : DeviceLoginDeepLink()
    data class Claim(val claim: String) : DeviceLoginDeepLink()
}

private sealed class Tab(val route: String, val label: String, val icon: ImageVector) {
    data object Home : Tab("home", "Accueil", Icons.Default.Home)
    data object Search : Tab("search", "Recherche", Icons.Default.Search)
    data object Library : Tab("library", "Biblio", Icons.Default.LibraryMusic)
}

@Composable
fun YtMusicAppContent(
    container: AppContainer,
    openPlayerFromIntent: Boolean = false,
) {
    val context = LocalContext.current
    val activity = context as? ComponentActivity
    val scope = rememberCoroutineScope()
    var loggedIn by remember { mutableStateOf<Boolean?>(null) }
    var showNowPlaying by remember { mutableStateOf(openPlayerFromIntent) }
    var playerFocusToken by remember {
        mutableIntStateOf(if (openPlayerFromIntent) 1 else 0)
    }
    var pendingApprove by remember { mutableStateOf<DeviceLoginDeepLink.Approve?>(null) }
    var deviceLoginBusy by remember { mutableStateOf(false) }

    fun handleDeviceLoginUri(uri: Uri?) {
        when (val link = MainActivity.parseDeviceLogin(uri)) {
            is DeviceLoginDeepLink.Claim -> {
                scope.launch {
                    deviceLoginBusy = true
                    runCatching {
                        val r = container.api.deviceLoginClaim(mapOf("claim" to link.claim))
                        container.tokenStore.saveSession(
                            r.token,
                            r.refreshToken,
                            r.user.email,
                            r.user.name,
                        )
                        loggedIn = true
                        Toast.makeText(context, "Connecté via QR", Toast.LENGTH_SHORT).show()
                    }.onFailure {
                        Toast.makeText(context, it.message ?: "Échec QR", Toast.LENGTH_LONG).show()
                    }
                    deviceLoginBusy = false
                }
            }
            is DeviceLoginDeepLink.Approve -> pendingApprove = link
            null -> Unit
        }
    }

    val player = remember(container) {
        PlayerController(
            context.applicationContext,
            container::streamUrl,
            container::warmStreamUrl,
        ).also { ctrl ->
            ctrl.autoFillFetcher = { seedId ->
                fetchAutoplayTracksFast(container.api, seedId)
            }
            ctrl.onPersistLocal = { snap ->
                container.localPlayback.save(
                    ovh.delhomme.ytmusic.data.LocalPlaybackStore.Snapshot(
                        queue = snap.queue,
                        queueIndex = snap.queueIndex,
                        positionMs = snap.positionMs,
                        userQueueEnd = snap.userQueueEnd,
                        queueTitle = snap.queueTitle,
                        wasPlaying = snap.wasPlaying,
                    ),
                )
            }
            ctrl.onClearLocal = { container.localPlayback.clear() }
        }
    }
    DisposableEffect(player) {
        player.connect()
        onDispose {
            player.flushPersist()
            player.release()
        }
    }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, player) {
        val obs = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) player.flushPersist()
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
    }

    // Clic notification → ouvrir le lecteur (singleTask / onNewIntent) + QR login
    DisposableEffect(activity) {
        if (activity == null) return@DisposableEffect onDispose { }
        val listener = androidx.core.util.Consumer<Intent> { intent ->
            if (intent.getBooleanExtra(MainActivity.EXTRA_OPEN_PLAYER, false)) {
                showNowPlaying = true
                playerFocusToken++
                intent.removeExtra(MainActivity.EXTRA_OPEN_PLAYER)
            }
            handleDeviceLoginUri(intent.data)
        }
        activity.addOnNewIntentListener(listener)
        onDispose { activity.removeOnNewIntentListener(listener) }
    }

    LaunchedEffect(Unit) {
        handleDeviceLoginUri(activity?.intent?.data)
    }

    LaunchedEffect(openPlayerFromIntent) {
        if (openPlayerFromIntent) {
            showNowPlaying = true
            if (playerFocusToken == 0) playerFocusToken = 1
        }
    }

    LaunchedEffect(Unit) {
        val intent = activity?.intent
        val injected = intent?.getStringExtra(MainActivity.EXTRA_ACCESS_TOKEN)?.trim().orEmpty()
        if (BuildConfig.DEBUG && injected.isNotEmpty()) {
            container.tokenStore.saveSession(
                injected,
                intent?.getStringExtra(MainActivity.EXTRA_REFRESH_TOKEN),
                intent?.getStringExtra(MainActivity.EXTRA_USER_EMAIL),
                null,
            )
            intent?.removeExtra(MainActivity.EXTRA_ACCESS_TOKEN)
            intent?.removeExtra(MainActivity.EXTRA_REFRESH_TOKEN)
            intent?.removeExtra(MainActivity.EXTRA_USER_EMAIL)
            loggedIn = true
        } else {
            // Hors Wi‑Fi maison : APK/override LAN → bascule VPS prod (évite « plus de connexion »)
            val switched = container.ensureReachableApiOrFallbackToProd()
            if (switched) {
                Toast.makeText(
                    context,
                    "API locale injoignable — bascule PROD",
                    Toast.LENGTH_LONG,
                ).show()
            }
            // Tokens déjà là → UI tout de suite (pas d’écran noir pendant /me)
            container.tokenStore.warmCache()
            val hasTokens =
                !container.tokenStore.peekAccess().isNullOrBlank() ||
                    !container.tokenStore.getRefresh().isNullOrBlank()
            if (hasTokens) {
                loggedIn = true
                if (!container.validateSession()) {
                    loggedIn = false
                }
            } else {
                loggedIn = container.validateSession()
            }
        }
    }

    // Si une piste tourne déjà (service survivant) → mini-player / éventuellement notif
    LaunchedEffect(loggedIn) {
        if (loggedIn == true && openPlayerFromIntent) {
            showNowPlaying = true
        }
    }

    BackHandler(enabled = loggedIn == true && showNowPlaying) {
        showNowPlaying = false
    }

    when (loggedIn) {
        null -> Box(
            Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background),
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    "PLM",
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary,
                )
                Spacer(Modifier.height(16.dp))
                CircularProgressIndicator(
                    modifier = Modifier.size(36.dp),
                    color = MaterialTheme.colorScheme.primary,
                    strokeWidth = 3.dp,
                )
                Spacer(Modifier.height(12.dp))
                Text(
                    "Connexion…",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        false -> LoginScreen(container = container, onLoggedIn = { loggedIn = true })
        true -> {
            pendingApprove?.let { pending ->
                AlertDialog(
                    onDismissRequest = { pendingApprove = null },
                    title = { Text("Autoriser la connexion ?") },
                    text = {
                        Text(
                            "Un autre appareil demande à se connecter avec ton compte via QR. " +
                                "N’accepte que si c’est toi.",
                        )
                    },
                    confirmButton = {
                        TextButton(
                            enabled = !deviceLoginBusy,
                            onClick = {
                                scope.launch {
                                    deviceLoginBusy = true
                                    runCatching {
                                        container.ensureFreshToken()
                                        container.api.deviceLoginApprove(
                                            mapOf("id" to pending.id, "code" to pending.code),
                                        )
                                        Toast.makeText(
                                            context,
                                            "Appareil autorisé",
                                            Toast.LENGTH_SHORT,
                                        ).show()
                                        pendingApprove = null
                                    }.onFailure {
                                        Toast.makeText(
                                            context,
                                            it.message ?: "Échec",
                                            Toast.LENGTH_LONG,
                                        ).show()
                                    }
                                    deviceLoginBusy = false
                                }
                            },
                        ) { Text("Autoriser") }
                    },
                    dismissButton = {
                        TextButton(onClick = { pendingApprove = null }) { Text("Refuser") }
                    },
                )
            }
            MainTabs(
                container = container,
                player = player,
                expanded = showNowPlaying,
                playerFocusToken = playerFocusToken,
                onOpenPlayer = {
                    showNowPlaying = true
                    playerFocusToken++
                },
                onClosePlayer = { showNowPlaying = false },
                onPlayTracks = { tracks, idx ->
                    val t = tracks.getOrNull(idx)
                    AppLog.breadcrumb("play", "${t?.id ?: "?"} idx=$idx n=${tracks.size}")
                    if (container.receiveRemoteSync()) {
                        scope.launch {
                            runCatching {
                                container.api.setSessionActive(mapOf("targetId" to container.deviceId))
                            }
                        }
                    }
                    player.play(tracks, idx)
                    showNowPlaying = false
                },
                onPlayNamed = { tracks, idx, title ->
                    val t = tracks.getOrNull(idx)
                    AppLog.breadcrumb("play", "$title · ${t?.id ?: "?"} n=${tracks.size}")
                    val radioish =
                        title.contains("radio", ignoreCase = true) ||
                            title.equals("Mix", ignoreCase = true) ||
                            title.contains("rapport", ignoreCase = true)
                    if (container.receiveRemoteSync()) {
                        scope.launch {
                            runCatching {
                                container.api.setSessionActive(mapOf("targetId" to container.deviceId))
                            }
                        }
                    }
                    if (radioish) {
                        player.playRadioOrEnqueue(tracks, title, sourceKind = "mix")
                    } else {
                        player.play(
                            tracks,
                            idx,
                            title,
                            sourceId = t?.album?.id,
                            sourceKind = if (t?.album?.id != null) "album" else null,
                        )
                    }
                    showNowPlaying = false
                },
                onLoggedOut = { loggedIn = false },
                onStartRadioFromNowPlaying = {
                    val t = player.state.value.track ?: return@MainTabs
                    scope.launch {
                        val mix = buildRadioQueue(container.api, "track", t.id, t, mixCache = container.mixCache)
                        if (mix.isNotEmpty()) {
                            player.playRadioOrEnqueue(mix, "Mix", sourceKind = "radio")
                        }
                    }
                },
            )
        }
    }
}

@Composable
private fun MainTabs(
    container: AppContainer,
    player: PlayerController,
    expanded: Boolean,
    playerFocusToken: Int = 0,
    onOpenPlayer: () -> Unit,
    onClosePlayer: () -> Unit,
    onPlayTracks: (List<TrackDto>, Int) -> Unit,
    onPlayNamed: (List<TrackDto>, Int, String) -> Unit = { tracks, idx, _ -> onPlayTracks(tracks, idx) },
    onLoggedOut: () -> Unit,
    onStartRadioFromNowPlaying: () -> Unit,
) {
    val nav = rememberNavController()
    val tabs = listOf(Tab.Home, Tab.Search, Tab.Library)
    val backStack by nav.currentBackStackEntryAsState()
    val current = backStack?.destination?.route
    val playerUi by player.state.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    // Garde NowPlaying monté après 1ʳᵉ ouverture (pas de remount → pas de rebuffer)
    var playerSheetMounted by remember { mutableStateOf(expanded) }
    if (expanded) playerSheetMounted = true

    LaunchedEffect(current) {
        if (!current.isNullOrBlank()) AppLog.breadcrumb("nav", current)
    }

    fun openDetail(item: TrackDto) {
        if (item.type?.equals("mix", ignoreCase = true) == true) {
            nav.navigate("detail/mix/${Uri.encode(item.id)}")
            return
        }
        val kind = when {
            item.isAlbum() -> "album"
            item.isArtist() -> "artist"
            else -> "playlist"
        }
        nav.navigate("detail/$kind/${Uri.encode(item.id)}")
    }

    fun openArtist(id: String?, name: String) {
        scope.launch {
            val resolved = resolveArtistId(container.api, id, name)
            if (resolved.isNullOrBlank()) {
                android.widget.Toast.makeText(
                    context,
                    "Artiste introuvable",
                    android.widget.Toast.LENGTH_SHORT,
                ).show()
                return@launch
            }
            onClosePlayer()
            nav.navigate("detail/artist/${Uri.encode(resolved)}")
        }
    }

    var menuTrack by remember { mutableStateOf<TrackDto?>(null) }
    var menuPlaylistId by remember { mutableStateOf<String?>(null) }
    var detailReloadToken by remember { mutableStateOf(0) }
    var addToPlaylistTrack by remember { mutableStateOf<TrackDto?>(null) }
    var showCast by remember { mutableStateOf(false) }
    var likedIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var forceOnboarding by remember { mutableStateOf(false) }
    var onboardingChecked by remember { mutableStateOf(false) }

    var sessionHydrated by remember { mutableStateOf(false) }
    var pendingRemoteLabel by remember { mutableStateOf<String?>(null) }
    /** Empêche d’écraser l’état web juste après la restauration multi-appareils. */
    var suppressSessionPublishUntil by remember { mutableStateOf(0L) }

    // Sync J’aime ↔ notification média (cœur dans le panneau système)
    LaunchedEffect(likedIds) {
        PlaybackService.Holder.syncLikedIds(likedIds)
    }
    DisposableEffect(Unit) {
        PlaybackService.Holder.onLikedIdsChanged = { ids -> likedIds = ids }
        onDispose { PlaybackService.Holder.onLikedIdsChanged = null }
    }

    LaunchedEffect(Unit) {
        runCatching { container.tokenStore.warmCache() }
        likedIds = runCatching {
            container.api.library().liked.map { it.id }.toSet()
        }.getOrDefault(emptySet())
        if (!onboardingChecked) {
            onboardingChecked = true
            forceOnboarding = runCatching {
                val p = container.api.prefs().prefs
                !p.onboardingDone || (p.genres.isEmpty() && p.moods.isEmpty())
            }.getOrDefault(false)
        }
        if (!sessionHydrated) {
            sessionHydrated = true
            if (!container.receiveRemoteSync()) {
                // Lectures indépendantes : restaurer file locale (survit force-stop)
                val local = container.localPlayback.load()
                if (local != null && local.queue.isNotEmpty()) {
                    suppressSessionPublishUntil = System.currentTimeMillis() + 8_000L
                    player.restoreQueue(
                        tracks = local.queue,
                        startIndex = local.queueIndex,
                        positionMs = local.positionMs,
                        autoplay = false, // ne pas auto-relancer après kill
                        title = local.queueTitle,
                        userQueueEnd = local.userQueueEnd,
                    )
                }
            } else runCatching {
                container.ensureFreshToken()
                val snap = container.api.session()
                val st = snap.state
                val queue = st?.queue.orEmpty().filter { it.isPlayable() }
                val current = st?.current?.takeIf { it.isPlayable() }
                val tracks = when {
                    queue.isNotEmpty() -> queue
                    current != null -> listOf(current)
                    else -> emptyList()
                }
                if (tracks.isNotEmpty()) {
                    val idx = when {
                        current != null -> tracks.indexOfFirst { it.id == current.id }
                            .takeIf { it >= 0 } ?: (st?.queueIndex ?: 0)
                        else -> st?.queueIndex ?: 0
                    }.coerceIn(0, tracks.lastIndex)
                    val posMs = ((st?.progress ?: 0.0) * 1000.0).toLong().coerceAtLeast(0L)
                    // Ne jamais voler la lecture au démarrage : sync file en pause.
                    // L’utilisateur appuie play → claim actif (évite conflit web/mobile).
                    val autoplay = false
                    suppressSessionPublishUntil = System.currentTimeMillis() + 12_000L
                    player.restoreQueue(
                        tracks = tracks,
                        startIndex = idx,
                        positionMs = posMs,
                        autoplay = autoplay,
                        title = "File synchronisée",
                        userQueueEnd = st?.userQueueEnd,
                    )
                    pendingRemoteLabel = if (st?.isPlaying == true) {
                        "En pause — lecture active ailleurs"
                    } else {
                        null
                    }
                } else if (st?.current != null) {
                    pendingRemoteLabel = st.current.title ?: "Titre en attente"
                }
            }.onFailure {
                pendingRemoteLabel = "Titre en attente"
            }
        }
    }

    // Publier l’état seulement si sync lecture activée (sinon file 100 % locale)
    suspend fun publishPlayback() {
        if (!container.receiveRemoteSync()) return
        if (System.currentTimeMillis() < suppressSessionPublishUntil) return
        val ui = player.state.value
        val t = ui.track ?: return
        runCatching {
            container.api.publishSessionState(
                mapOf(
                    "current" to t,
                    "queue" to ui.queue,
                    "queueIndex" to ui.queueIndex,
                    "userQueueEnd" to ui.userQueueEnd,
                    "autoplay" to ui.autoplaySuggestions,
                    "isPlaying" to ui.playing,
                    "progress" to (ui.positionMs / 1000.0),
                    "duration" to (ui.durationMs / 1000.0).coerceAtLeast(0.0),
                    "shuffle" to ui.shuffle,
                    "repeat" to when (ui.repeat) {
                        ovh.delhomme.ytmusic.player.RepeatMode.Off -> "off"
                        ovh.delhomme.ytmusic.player.RepeatMode.All -> "all"
                        ovh.delhomme.ytmusic.player.RepeatMode.One -> "one"
                    },
                    "updatedAt" to System.currentTimeMillis(),
                    "deviceId" to container.deviceId,
                ),
            )
        }
    }
    LaunchedEffect(playerUi.track?.id, playerUi.playing, playerUi.queueIndex) {
        if (playerUi.track == null) return@LaunchedEffect
        delay(400)
        publishPlayback()
    }
    // Heartbeat progress pendant lecture — assez fréquent pour la timeline multi-appareils
    LaunchedEffect(playerUi.playing, playerUi.track?.id) {
        if (!playerUi.playing || playerUi.track == null) return@LaunchedEffect
        while (isActive) {
            delay(4_000)
            if (!player.state.value.playing) break
            publishPlayback()
        }
    }

    // Miroir timeline remote quand on est en pause (titre sync ailleurs)
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(lifecycleOwner) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) {
                delay(2_000)
                if (!container.receiveRemoteSync()) continue
                if (player.state.value.playing) continue
                if (System.currentTimeMillis() < suppressSessionPublishUntil) continue
                runCatching {
                    val snap = container.api.session()
                    val st = snap.state ?: return@runCatching
                    if (snap.activePlayerId == container.deviceId) return@runCatching
                    val remoteId = st.current?.id ?: st.queue.getOrNull(st.queueIndex)?.id
                    val localId = player.state.value.track?.id
                    if (remoteId.isNullOrBlank() || remoteId != localId) return@runCatching
                    val base = (st.progress ?: 0.0).coerceAtLeast(0.0)
                    val ageSec = if (st.isPlaying) {
                        ((System.currentTimeMillis() - (st.updatedAt ?: System.currentTimeMillis()))
                            .coerceAtLeast(0L) / 1000.0)
                    } else {
                        0.0
                    }
                    val mirrored = ((base + ageSec) * 1000.0).toLong()
                    val durMs = ((st.duration ?: 0.0) * 1000.0).toLong()
                    player.mirrorPosition(mirrored, durMs)
                }
            }
        }
    }

    // Sync multi-appareils : pull file + progress
    var lastDeviceRegisterAt by remember { mutableLongStateOf(0L) }
    LaunchedEffect(lifecycleOwner, playerUi.playing) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (isActive) {
                val playing = player.state.value.playing
                val now = System.currentTimeMillis()
                runCatching {
                    if (now - lastDeviceRegisterAt > 60_000L) {
                        lastDeviceRegisterAt = now
                        container.api.registerSessionDevice(
                            mapOf(
                                "deviceId" to container.deviceId,
                                "name" to (android.os.Build.MODEL ?: "Android"),
                                "deviceType" to "mobile",
                                "canPlay" to true,
                            ),
                        )
                        if (playing && container.receiveRemoteSync()) {
                            runCatching {
                                container.api.setSessionActive(mapOf("targetId" to container.deviceId))
                            }
                        }
                    }
                    if (!playing && container.receiveRemoteSync() && now >= suppressSessionPublishUntil) {
                        val snap = container.api.session()
                        val st = snap.state
                        val remoteQueue = st?.queue.orEmpty().filter { it.isPlayable() }
                        val ui = player.state.value
                        val localIds = ui.queue.map { it.id }
                        val remoteIds = remoteQueue.map { it.id }
                        val remoteActiveElsewhere =
                            snap.activePlayerId != null &&
                                snap.activePlayerId != container.deviceId &&
                                (st?.updatedAt ?: 0L) > (now - 120_000)
                        if (remoteActiveElsewhere && remoteIds.isNotEmpty()) {
                            val current = st?.current?.takeIf { it.isPlayable() }
                            val idx = when {
                                current != null -> remoteQueue.indexOfFirst { it.id == current.id }
                                    .takeIf { it >= 0 } ?: (st?.queueIndex ?: 0)
                                else -> st?.queueIndex ?: 0
                            }.coerceIn(0, remoteQueue.lastIndex)
                            val base = (st?.progress ?: 0.0).coerceAtLeast(0.0)
                            val ageSec = if (st?.isPlaying == true) {
                                ((now - (st.updatedAt ?: now)).coerceAtLeast(0L) / 1000.0)
                            } else 0.0
                            val posMs = ((base + ageSec) * 1000.0).toLong().coerceAtLeast(0L)
                            if (remoteIds != localIds || ui.track?.id != current?.id) {
                                suppressSessionPublishUntil = System.currentTimeMillis() + 8_000L
                                player.restoreQueue(
                                    tracks = remoteQueue,
                                    startIndex = idx,
                                    positionMs = posMs,
                                    autoplay = false,
                                    title = "File synchronisée",
                                    userQueueEnd = st?.userQueueEnd,
                                )
                            } else {
                                player.mirrorPosition(
                                    posMs,
                                    ((st?.duration ?: 0.0) * 1000.0).toLong(),
                                )
                            }
                        }
                    }
                }
                delay(if (playing) 45_000 else 8_000)
            }
        }
    }

    // Signaux d’écoute pour le moteur de reco
    var lastListenStartId by remember { mutableStateOf<String?>(null) }
    var completedIds by remember { mutableStateOf(setOf<String>()) }
    var lastProgressSentAt by remember { mutableStateOf(0L) }
    var skipCandidate by remember {
        mutableStateOf<Triple<TrackDto, Long, Long>?>(null) // track, pos, dur
    }

    LaunchedEffect(playerUi.track?.id) {
        val next = playerUi.track
        val prev = skipCandidate
        if (prev != null && next?.id != prev.first.id) {
            val (t, pos, dur) = prev
            val pct = if (dur > 0) pos.toDouble() / dur else 0.0
            if (t.id !in completedIds && (pct < 0.30 || pos < 15_000L)) {
                runCatching {
                    container.api.listen(
                        ListenBody(
                            t.id,
                            "skip",
                            progressPct = pct,
                            durationMs = dur,
                            track = t,
                        ),
                    )
                }
            }
        }
        if (next != null) {
            skipCandidate = Triple(next, playerUi.positionMs, playerUi.durationMs)
            if (next.id != lastListenStartId) {
                lastListenStartId = next.id
                runCatching {
                    container.api.listen(ListenBody(next.id, "start", track = next))
                }
            }
        } else {
            skipCandidate = null
        }
    }

    LaunchedEffect(playerUi.positionMs, playerUi.durationMs, playerUi.track?.id) {
        val t = playerUi.track ?: return@LaunchedEffect
        skipCandidate = Triple(t, playerUi.positionMs, playerUi.durationMs)
        if (playerUi.durationMs <= 0 || t.id in completedIds) return@LaunchedEffect
        val pct = playerUi.positionMs.toDouble() / playerUi.durationMs
        if (pct >= 0.85) {
            completedIds = (completedIds + t.id).let { s ->
                if (s.size <= 64) s else s.toList().takeLast(48).toSet()
            }
            runCatching {
                container.api.listen(
                    ListenBody(
                        t.id,
                        "complete",
                        progressPct = pct,
                        durationMs = playerUi.durationMs,
                        track = t,
                    ),
                )
            }
        }
    }

    LaunchedEffect(playerUi.playing, playerUi.track?.id) {
        if (!playerUi.playing || playerUi.track == null) return@LaunchedEffect
        while (isActive) {
            delay(25_000)
            val t = player.state.value.track ?: break
            val ui = player.state.value
            if (!ui.playing) break
            val now = System.currentTimeMillis()
            if (now - lastProgressSentAt < 20_000) continue
            lastProgressSentAt = now
            val pct = if (ui.durationMs > 0) {
                ui.positionMs.toDouble() / ui.durationMs * 100.0
            } else {
                0.0
            }
            runCatching {
                container.api.listen(
                    ListenBody(
                        t.id,
                        "progress",
                        progressPct = pct,
                        durationMs = ui.durationMs,
                        track = t,
                    ),
                )
            }
        }
    }

    LaunchedEffect(playerUi.playing, playerUi.track?.id, expanded, playerSheetMounted) {
        // NowPlaying (monté) gère son tick — éviter double tick / travail inutile
        if (playerSheetMounted) return@LaunchedEffect
        while (playerUi.playing && playerUi.track != null) {
            player.tick()
            delay(500)
        }
    }

    CompositionLocalProvider(
        LocalNowPlaying provides NowPlayingInfo(
            trackId = playerUi.track?.id,
            playing = playerUi.playing,
            albumId = playerUi.track?.album?.id,
            sourceId = playerUi.sourceId,
            sourceKind = playerUi.sourceKind,
            queueTitle = playerUi.queueTitle,
        ),
    ) {
    Scaffold(
        contentWindowInsets = WindowInsets.safeDrawing,
        bottomBar = {
            if (!expanded) {
                Column(Modifier.navigationBarsPadding()) {
                    playerUi.track?.let { track ->
                        MiniPlayerBar(
                            track = track,
                            playing = playerUi.playing,
                            progress = if (playerUi.durationMs > 0) {
                                (playerUi.positionMs.toFloat() / playerUi.durationMs).coerceIn(0f, 1f)
                            } else {
                                0f
                            },
                            durationMs = playerUi.durationMs,
                            onToggle = {
                                suppressSessionPublishUntil = 0L
                                scope.launch {
                                    if (container.receiveRemoteSync()) {
                                        runCatching {
                                            container.api.setSessionActive(
                                                mapOf("targetId" to container.deviceId),
                                            )
                                        }
                                    }
                                    val wasPlaying = player.state.value.playing
                                    player.toggle()
                                    if (!wasPlaying) {
                                        delay(350)
                                        publishPlayback()
                                    }
                                }
                            },
                            onNext = {
                                suppressSessionPublishUntil = 0L
                                scope.launch {
                                    if (container.receiveRemoteSync()) {
                                        runCatching {
                                            container.api.setSessionActive(
                                                mapOf("targetId" to container.deviceId),
                                            )
                                        }
                                    }
                                    player.skipNext()
                                }
                            },
                            onPrev = {
                                suppressSessionPublishUntil = 0L
                                scope.launch {
                                    if (container.receiveRemoteSync()) {
                                        runCatching {
                                            container.api.setSessionActive(
                                                mapOf("targetId" to container.deviceId),
                                            )
                                        }
                                    }
                                    player.skipPrevOrRestart(forcePrevious = false)
                                }
                            },
                            onSeekBy = { delta -> player.seekBy(delta) },
                            onOpen = onOpenPlayer,
                            onDismiss = {
                                onClosePlayer()
                                player.stopAndClear()
                            },
                            onSeek = { ratio ->
                                val dur = playerUi.durationMs
                                if (dur > 0) player.seek((ratio * dur).toLong())
                            },
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(MaterialTheme.colorScheme.surfaceVariant),
                        )
                    } ?: pendingRemoteLabel?.let { label ->
                        Text(
                            "En attente · $label",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(MaterialTheme.colorScheme.surfaceVariant)
                                .padding(16.dp),
                        )
                    }
                    NavigationBar(
                        containerColor = MaterialTheme.colorScheme.surface,
                    ) {
                        tabs.forEach { tab ->
                            NavigationBarItem(
                                selected = current == tab.route,
                                onClick = {
                                    nav.navigate(tab.route) {
                                        popUpTo(nav.graph.startDestinationId) { saveState = true }
                                        launchSingleTop = true
                                        restoreState = true
                                    }
                                },
                                icon = { Icon(tab.icon, contentDescription = tab.label) },
                                label = { Text(tab.label) },
                            )
                        }
                    }
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = nav,
            startDestination = Tab.Home.route,
            modifier = Modifier.padding(padding),
        ) {
            composable(Tab.Home.route) {
                HomeScreen(
                    container = container,
                    onPlay = onPlayTracks,
                    onPlayNamed = onPlayNamed,
                    onMore = { menuTrack = it; menuPlaylistId = null },
                    onOpenDetail = ::openDetail,
                    onOpenArtist = ::openArtist,
                    onOpenRecoPrefs = { nav.navigate("reco_prefs") },
                    onOpenDebugLogs = { nav.navigate("debug_logs") },
                    onOpenYtmImport = { nav.navigate("ytm_import") },
                    onOpenDownloads = {
                        LibraryFilter.pendingSelect = LibraryFilter.Downloads
                        nav.navigate(Tab.Library.route) {
                            launchSingleTop = true
                            restoreState = true
                        }
                    },
                    onLoggedOut = onLoggedOut,
                    onMoreMix = { id, title, covers ->
                        menuTrack = TrackDto(
                            id = id,
                            title = title,
                            artists = listOf(ovh.delhomme.ytmusic.data.ArtistRef("Mix radio")),
                            thumbnails = covers.firstOrNull()?.thumbnails,
                            type = "mix",
                        )
                        menuPlaylistId = null
                    },
                )
            }
            composable(Tab.Search.route) {
                SearchScreen(
                    container = container,
                    onPlay = onPlayTracks,
                    onMore = { menuTrack = it; menuPlaylistId = null },
                    onOpenDetail = ::openDetail,
                    onOpenArtist = ::openArtist,
                )
            }
            composable(Tab.Library.route) {
                LibraryScreen(
                    container = container,
                    onPlay = onPlayTracks,
                    onMore = { menuTrack = it; menuPlaylistId = null },
                    onOpenDetail = ::openDetail,
                    onOpenArtist = ::openArtist,
                    onOpenRecoPrefs = { nav.navigate("reco_prefs") },
                    onOpenDebugLogs = { nav.navigate("debug_logs") },
                    onOpenYtmImport = { nav.navigate("ytm_import") },
                    onLoggedOut = onLoggedOut,
                )
            }
            composable("debug_logs") {
                DebugLogsScreen(container = container, onBack = { nav.popBackStack() })
            }
            composable("ytm_import") {
                YtmImportScreen(
                    container = container,
                    onBack = { nav.popBackStack() },
                )
            }
            composable("reco_prefs") {
                RecoPrefsScreen(
                    container = container,
                    forceOnboarding = false,
                    onDone = { nav.popBackStack() },
                    onBack = { nav.popBackStack() },
                )
            }
            composable(
                route = "detail/{kind}/{id}",
                arguments = listOf(
                    navArgument("kind") { type = NavType.StringType },
                    navArgument("id") { type = NavType.StringType },
                ),
            ) { entry ->
                val kindStr = entry.arguments?.getString("kind") ?: "playlist"
                val id = entry.arguments?.getString("id") ?: return@composable
                val kind = when (kindStr) {
                    "album" -> DetailKind.Album
                    "artist" -> DetailKind.Artist
                    "mix" -> DetailKind.Mix
                    else -> DetailKind.Playlist
                }
                if (kind == DetailKind.Artist) {
                    ArtistDetailScreen(
                        container = container,
                        artistId = id,
                        reloadToken = detailReloadToken,
                        onBack = { nav.popBackStack() },
                        onPlay = onPlayTracks,
                        onPlayNamed = onPlayNamed,
                        onMore = { track ->
                            menuTrack = track
                            menuPlaylistId = null
                        },
                        onOpenDetail = ::openDetail,
                        onOpenAllSongs = {
                            nav.navigate("artist_songs/${Uri.encode(id)}")
                        },
                    )
                } else {
                    CollectionDetailScreen(
                        container = container,
                        kind = kind,
                        id = id,
                        reloadToken = detailReloadToken,
                        player = player,
                        onBack = { nav.popBackStack() },
                        onPlay = onPlayTracks,
                        onPlayNamed = onPlayNamed,
                        onMore = { track, playlistId ->
                            menuTrack = track
                            menuPlaylistId = playlistId
                        },
                        onOpenArtist = { artistId, name -> openArtist(artistId, name) },
                        onOpenAddToPlaylist = { track ->
                            addToPlaylistTrack = track
                        },
                    )
                }
            }
            composable(
                route = "artist_songs/{id}",
                arguments = listOf(
                    navArgument("id") { type = NavType.StringType },
                ),
            ) { entry ->
                val id = entry.arguments?.getString("id") ?: return@composable
                ArtistSongsScreen(
                    container = container,
                    artistId = id,
                    reloadToken = detailReloadToken,
                    onBack = { nav.popBackStack() },
                    onPlay = onPlayTracks,
                    onMore = { track ->
                        menuTrack = track
                        menuPlaylistId = null
                    },
                    onOpenDetail = ::openDetail,
                )
            }
        }
    }

    menuTrack?.let { track ->
        TrackActionsSheet(
            track = track,
            container = container,
            player = player,
            likedIds = likedIds,
            onDismiss = {
                menuTrack = null
                menuPlaylistId = null
            },
            onLikedChanged = { likedIds = it },
            onOpenAddToPlaylist = {
                addToPlaylistTrack = track
                menuTrack = null
                menuPlaylistId = null
            },
            onOpenAlbum = { id ->
                onClosePlayer()
                nav.navigate("detail/album/${Uri.encode(id)}")
            },
            onOpenArtist = { id ->
                openArtist(id, "")
            },
            onCast = { showCast = true },
            playlistId = menuPlaylistId,
            onRemovedFromPlaylist = { detailReloadToken++ },
        )
    }

    addToPlaylistTrack?.let { track ->
        AddToPlaylistSheet(
            track = track,
            container = container,
            onDismiss = { addToPlaylistTrack = null },
        )
    }

    // Garde NowPlaying en composition une fois ouvert — évite remount / rebuffer à chaque expand
    val sheetAlpha by animateFloatAsState(
        targetValue = if (expanded) 1f else 0f,
        animationSpec = tween(220),
        label = "np-alpha",
    )
    val sheetSlide by animateFloatAsState(
        targetValue = if (expanded) 0f else 1f,
        animationSpec = tween(240),
        label = "np-slide",
    )
    if (playerSheetMounted) {
        Box(
            Modifier
                .fillMaxSize()
                .zIndex(10f)
                .graphicsLayer {
                    alpha = sheetAlpha
                    translationY = size.height * 0.08f * sheetSlide
                    // Hors écran + non interactif quand rétracté
                    if (!expanded) {
                        // clip n’empêche pas les hits : on shrink via alpha + ignore
                    }
                }
                .then(
                    if (!expanded) {
                        Modifier.offset { IntOffset(0, 100_000) } // hors hit-test
                    } else {
                        Modifier
                    },
                ),
        ) {
            NowPlayingScreen(
                player = player,
                ui = playerUi,
                container = container,
                likedIds = likedIds,
                onLikedChanged = { likedIds = it },
                onClose = onClosePlayer,
                onMore = { menuTrack = it; menuPlaylistId = null },
                onCast = { showCast = true },
                onOpenAddToPlaylist = { addToPlaylistTrack = it },
                onOpenArtist = ::openArtist,
                focusPlayerToken = playerFocusToken,
                sheetVisible = expanded,
            )
        }
    }

    if (showCast) {
        CastSheet(container = container, player = player, onDismiss = { showCast = false })
    }

    if (forceOnboarding) {
        Box(
            Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
                .zIndex(20f),
        ) {
            RecoPrefsScreen(
                container = container,
                forceOnboarding = true,
                onDone = {
                    forceOnboarding = false
                },
            )
        }
    }
    } // CompositionLocalProvider
}
