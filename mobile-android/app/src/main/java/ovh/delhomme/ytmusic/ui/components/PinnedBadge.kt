package ovh.delhomme.ytmusic.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Badge épingle toujours visible (accès rapide) — cliquable pour retirer. */
@Composable
fun PinnedBadge(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    size: Dp = 32.dp,
) {
    Box(
        modifier = modifier
            .size(size)
            .clip(CircleShape)
            .background(Color(0xFFFF0033))
            .then(
                if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            Icons.Default.PushPin,
            contentDescription = "Épinglé — retirer de l'accès rapide",
            tint = Color.White,
            modifier = Modifier.size(size * 0.55f),
        )
    }
}
