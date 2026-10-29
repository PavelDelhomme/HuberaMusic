package ovh.delhomme.ytmusic.ui.components

import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

/**
 * Clic court → [onClick] (skip Next/Prev).
 * Appui long → seek répété via [onHoldTick] dans le titre courant.
 *
 * Seuil volontairement large (~520 ms) : un tap un peu lent ne doit **pas**
 * être pris pour un hold (sinon Précédent/Suivant semblent cassés — le clic
 * est avalé et seul un seek −2 s a lieu).
 */
@Composable
fun HoldSeekIconButton(
    onClick: () -> Unit,
    onHoldTick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    var heldSeek by remember { mutableStateOf(false) }

    LaunchedEffect(pressed, enabled) {
        if (!pressed || !enabled) {
            // Relâchement : ne pas laisser heldSeek coincé si le delay n’a pas fini.
            return@LaunchedEffect
        }
        heldSeek = false
        delay(HOLD_THRESHOLD_MS)
        if (!isActive || !pressed) return@LaunchedEffect
        heldSeek = true
        while (isActive) {
            onHoldTick()
            delay(HOLD_TICK_MS)
        }
    }

    IconButton(
        onClick = {
            if (heldSeek) {
                // Fin d’un vrai appui long : pas de skip.
                heldSeek = false
                return@IconButton
            }
            onClick()
        },
        enabled = enabled,
        modifier = modifier,
        interactionSource = interaction,
        content = content,
    )
}

/** Avant ce délai, tout relâchement = clic skip (Next/Prev). */
internal const val HOLD_THRESHOLD_MS = 520L
internal const val HOLD_TICK_MS = 280L
