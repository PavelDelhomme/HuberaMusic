package ovh.delhomme.ytmusic.ui.util

import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.platform.LocalConfiguration

/** Largeur courte (typ. paysage téléphone) — layouts côté à côté. */
@Composable
@ReadOnlyComposable
fun isLandscape(): Boolean =
    LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE

@Composable
@ReadOnlyComposable
fun screenHeightDp(): Int = LocalConfiguration.current.screenHeightDp

@Composable
@ReadOnlyComposable
fun screenWidthDp(): Int = LocalConfiguration.current.screenWidthDp
