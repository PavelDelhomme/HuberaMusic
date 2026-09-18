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
 * Clic court → [onClick] (skip).
 * Appui long → seek répété via [onHoldTick] dans le titre courant.
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
    var suppressClick by remember { mutableStateOf(false) }

    LaunchedEffect(pressed, enabled) {
        if (!pressed || !enabled) return@LaunchedEffect
        suppressClick = false
        delay(320)
        if (!isActive) return@LaunchedEffect
        suppressClick = true
        while (isActive) {
            onHoldTick()
            delay(280)
        }
    }

    IconButton(
        onClick = {
            if (suppressClick) {
                suppressClick = false
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
