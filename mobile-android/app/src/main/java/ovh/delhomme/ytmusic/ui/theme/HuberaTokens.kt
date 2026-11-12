package ovh.delhomme.ytmusic.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Tokens du design system Hubera (voir `Hubera/platform/design-tokens/tokens.json`).
 * Objectif : aligner l'écran Compte / Paramètres sur les autres apps Hubera.
 * Additif — n'altère pas le thème Material3 existant.
 */
object HuberaTokens {
    // Couleurs (thème sombre Hubera)
    val bgDark = Color(0xFF0F1419)
    val surfaceDark = Color(0xFF1A222C)
    val surface2Dark = Color(0xFF243040)
    val textDark = Color(0xFFE8EEF4)
    val textMutedDark = Color(0xFF93A4B8)
    val accent = Color(0xFF3D9CF0)
    val accent2 = Color(0xFF2EC9A3)
    val danger = Color(0xFFEF5B5B)
    val warning = Color(0xFFF0B429)
    val ok = Color(0xFF3DCC8C)
    val borderDark = Color(0xFF2D3B4C)

    // Rayons
    val radiusSm: Dp = 6.dp
    val radiusMd: Dp = 10.dp
    val radiusLg: Dp = 16.dp

    // Espacements
    val space1: Dp = 4.dp
    val space2: Dp = 8.dp
    val space3: Dp = 12.dp
    val space4: Dp = 16.dp
    val space6: Dp = 24.dp
    val space8: Dp = 32.dp

    val cardShape = RoundedCornerShape(radiusLg)
    val rowShape = RoundedCornerShape(radiusMd)
}
