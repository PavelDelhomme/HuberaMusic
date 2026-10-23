package ovh.delhomme.ytmusic.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cloud.hubera.chrome.HuberaAccountButton
import coil.compose.AsyncImage
import ovh.delhomme.ytmusic.R

/**
 * En-tête commun Accueil / Bibliothèque.
 * Accueil : logo + « PLM » · avatar
 * Biblio : « Bibliothèque » · historique + avatar
 */
@Composable
fun AppTopBar(
    title: String,
    showBrandLogo: Boolean = false,
    userPictureUrl: String? = null,
    onAccountClick: () -> Unit,
    onMenuClick: (() -> Unit)? = null,
    onHistoryClick: (() -> Unit)? = null,
    onBrandClick: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .statusBarsPadding()
            .padding(horizontal = 4.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (onMenuClick != null) {
            IconButton(onClick = onMenuClick) {
                Icon(
                    Icons.Default.Menu,
                    contentDescription = "Menu",
                    tint = MaterialTheme.colorScheme.onSurface,
                )
            }
        } else if (showBrandLogo) {
            Image(
                painter = painterResource(R.drawable.ic_brand),
                contentDescription = "Apps Hubera",
                modifier = Modifier
                    .padding(start = 8.dp)
                    .size(32.dp)
                    .clip(CircleShape)
                    .then(
                        if (onBrandClick != null) Modifier.clickable(onClick = onBrandClick)
                        else Modifier,
                    ),
                contentScale = ContentScale.Crop,
            )
            Spacer(Modifier.width(4.dp))
        } else {
            Spacer(Modifier.width(8.dp))
        }
        Text(
            title,
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.weight(1f),
        )
        if (onHistoryClick != null) {
            IconButton(onClick = onHistoryClick) {
                Icon(
                    Icons.Default.History,
                    contentDescription = "Historique",
                    tint = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
        HuberaAccountButton(
            onClick = onAccountClick,
            userPicture = if (!userPictureUrl.isNullOrBlank()) {
                {
                    AsyncImage(
                        model = userPictureUrl,
                        contentDescription = "Compte",
                        contentScale = ContentScale.Crop,
                        modifier = Modifier
                            .size(32.dp)
                            .clip(CircleShape),
                    )
                }
            } else {
                null
            },
        )
    }
}
