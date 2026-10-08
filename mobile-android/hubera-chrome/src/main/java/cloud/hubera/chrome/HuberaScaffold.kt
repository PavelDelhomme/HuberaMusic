package cloud.hubera.chrome

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

@Composable
fun HuberaAccountButton(
    onClick: () -> Unit,
    userPicture: @Composable (() -> Unit)? = null,
) {
    IconButton(onClick = onClick) {
        if (userPicture != null) {
            userPicture()
        } else {
            Box(
                Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.surfaceVariant),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Default.Person,
                    contentDescription = "Compte",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HuberaTopBar(
    title: String,
    onMenuClick: () -> Unit,
    onAccountClick: () -> Unit,
    extraActions: @Composable RowScope.() -> Unit = {},
    userPicture: @Composable (() -> Unit)? = null,
) {
    TopAppBar(
        title = {
            Text(
                title,
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        navigationIcon = {
            IconButton(onClick = onMenuClick) {
                Icon(Icons.Default.Menu, contentDescription = "Menu")
            }
        },
        actions = {
            extraActions()
            HuberaAccountButton(onClick = onAccountClick, userPicture = userPicture)
        },
        windowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top),
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = MaterialTheme.colorScheme.surface,
            titleContentColor = MaterialTheme.colorScheme.onSurface,
        ),
    )
}

@Composable
fun HuberaDrawerContent(
    current: HuberaProduct,
    versionLabel: String,
    onAccountClick: () -> Unit,
    userEmail: String? = null,
    extra: @Composable ColumnScope.() -> Unit = {},
) {
    val context = LocalContext.current
    Column(
        Modifier
            .fillMaxHeight()
            .verticalScroll(rememberScrollState()),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(4.dp)
                .background(HuberaOrange),
        )
        Row(
            Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(HuberaTeal.copy(alpha = 0.12f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(current.icon, contentDescription = null, tint = HuberaTeal)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text("Hubera ${current.title}", fontWeight = FontWeight.Bold)
                Text(
                    userEmail?.takeIf { it.isNotBlank() } ?: "Compte Hubera",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Text(
            "Apps Hubera",
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
        LazyVerticalGrid(
            columns = GridCells.Fixed(4),
            modifier = Modifier
                .fillMaxWidth()
                .height(240.dp)
                .padding(horizontal = 8.dp),
            userScrollEnabled = true,
            verticalArrangement = Arrangement.spacedBy(4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            items(HuberaProduct.suite) { app ->
                val selected = app == current
                Column(
                    Modifier
                        .clip(MaterialTheme.shapes.medium)
                        .background(
                            if (selected) HuberaTeal.copy(alpha = 0.12f)
                            else MaterialTheme.colorScheme.surfaceVariant,
                        )
                        .clickable(enabled = !selected) { HuberaAppLauncher.openOrWeb(context, app.id) }
                        .padding(8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(app.icon, contentDescription = app.title, tint = HuberaTeal, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.height(4.dp))
                    Text(
                        app.title,
                        style = MaterialTheme.typography.labelSmall,
                        textAlign = TextAlign.Center,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        extra()
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(onClick = onAccountClick)
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Person, contentDescription = null)
            Spacer(Modifier.width(12.dp))
            Text("Compte")
        }
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Info, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(12.dp))
            Text(
                versionLabel,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
fun HuberaBottomNav(
    items: List<HuberaNavItem>,
    selectedId: String?,
    onSelect: (String) -> Unit,
) {
    if (items.isEmpty()) return
    NavigationBar(
        containerColor = MaterialTheme.colorScheme.surface,
        windowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom),
    ) {
        items.forEach { item ->
            NavigationBarItem(
                selected = item.id == selectedId,
                onClick = { onSelect(item.id) },
                icon = { Icon(item.icon, contentDescription = item.label) },
                label = { Text(item.label) },
                alwaysShowLabel = true,
            )
        }
    }
}

/**
 * Squelette Google-like : hamburger à gauche, titre, compte à droite, drawer suite, nav bas.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HuberaScaffold(
    title: String,
    current: HuberaProduct,
    versionLabel: String,
    onAccountClick: () -> Unit,
    navItems: List<HuberaNavItem>,
    selectedNavId: String?,
    onNavSelect: (String) -> Unit,
    userEmail: String? = null,
    extraActions: @Composable RowScope.() -> Unit = {},
    extraDrawer: @Composable ColumnScope.() -> Unit = {},
    userPicture: @Composable (() -> Unit)? = null,
    floatingActionButton: @Composable () -> Unit = {},
    snackbarHost: @Composable () -> Unit = {},
    bottomBarExtra: @Composable () -> Unit = {},
    hideBottomNav: Boolean = false,
    hideTopBar: Boolean = false,
    content: @Composable (PaddingValues) -> Unit,
) {
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet(
                windowInsets = WindowInsets.safeDrawing,
            ) {
                HuberaDrawerContent(
                    current = current,
                    versionLabel = versionLabel,
                    onAccountClick = {
                        scope.launch { drawerState.close() }
                        onAccountClick()
                    },
                    userEmail = userEmail,
                    extra = extraDrawer,
                )
            }
        },
    ) {
        Scaffold(
            topBar = {
                if (!hideTopBar) {
                    HuberaTopBar(
                        title = title,
                        onMenuClick = { scope.launch { drawerState.open() } },
                        onAccountClick = onAccountClick,
                        extraActions = extraActions,
                        userPicture = userPicture,
                    )
                }
            },
            bottomBar = {
                Column {
                    bottomBarExtra()
                    if (!hideBottomNav) {
                        HuberaBottomNav(navItems, selectedNavId, onNavSelect)
                    }
                }
            },
            contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal),
            floatingActionButton = floatingActionButton,
            snackbarHost = snackbarHost,
            content = content,
        )
    }
}
