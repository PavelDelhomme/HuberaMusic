package ovh.delhomme.ytmusic.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.LibraryAddCheck
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp

/**
 * Vignette titre / mix / playlist :
 * lire en bas à droite, ajouter à la bibliothèque en bas à gauche, plus en haut à droite.
 */
@Composable
fun BoxScope.VignetteChrome(
    saved: Boolean,
    onPlay: () -> Unit,
    onAdd: () -> Unit,
    onMore: () -> Unit,
    playEnabled: Boolean = true,
) {
    VignetteRoundButton(
        modifier = Modifier
            .align(Alignment.TopEnd)
            .padding(6.dp),
        icon = Icons.Default.MoreVert,
        description = "Plus",
        onClick = onMore,
    )
    VignetteRoundButton(
        modifier = Modifier
            .align(Alignment.BottomStart)
            .padding(6.dp),
        icon = if (saved) Icons.Default.LibraryAddCheck else Icons.Default.Add,
        description = if (saved) "Dans la bibliothèque" else "Ajouter à la bibliothèque",
        tint = if (saved) Color(0xFFFF0033) else Color.White,
        onClick = onAdd,
    )
    Box(
        Modifier
            .align(Alignment.BottomEnd)
            .padding(6.dp)
            .size(36.dp)
            .clip(CircleShape)
            .background(MaterialTheme.colorScheme.error)
            .clickable(enabled = playEnabled, onClick = onPlay),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            Icons.Default.PlayArrow,
            contentDescription = "Lire",
            tint = Color.White,
            modifier = Modifier.size(22.dp),
        )
    }
}

@Composable
private fun VignetteRoundButton(
    modifier: Modifier,
    icon: ImageVector,
    description: String,
    onClick: () -> Unit,
    tint: Color = Color.White,
) {
    Box(
        modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(Color.Black.copy(alpha = 0.72f))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            icon,
            contentDescription = description,
            tint = tint,
            modifier = Modifier.size(20.dp),
        )
    }
}
