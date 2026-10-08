package cloud.hubera.chrome

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Charte Hubera Docs — teal / orange, pas une 3ᵉ palette. */
val HuberaTeal = Color(0xFF0E4D5C)
val HuberaOrange = Color(0xFFC9782A)
val HuberaBg = Color(0xFFF4F7F8)
val HuberaInk = Color(0xFF1A2330)

private val huberaScheme = lightColorScheme(
    primary = HuberaTeal,
    onPrimary = Color.White,
    secondary = HuberaOrange,
    onSecondary = Color.White,
    background = HuberaBg,
    onBackground = HuberaInk,
    surface = Color.White,
    onSurface = HuberaInk,
    surfaceVariant = Color(0xFFEEF3F5),
    onSurfaceVariant = Color(0xFF5A6878),
    error = Color(0xFFB42318),
    outline = Color(0xFFDCE6EA),
)

@Composable
fun HuberaTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = huberaScheme, content = content)
}
