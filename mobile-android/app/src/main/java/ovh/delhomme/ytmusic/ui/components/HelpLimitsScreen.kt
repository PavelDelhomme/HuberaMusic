package ovh.delhomme.ytmusic.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * Notes importantes : limites, incidents fréquents, où regarder.
 * Accessible depuis Compte — rappelée à l’inscription.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HelpLimitsScreen(onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    Scaffold(
        contentWindowInsets = WindowInsets.safeDrawing,
        topBar = {
            TopAppBar(
                title = { Text("Aide & limites") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Retour")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item {
                Text(
                    "Lis cette page une fois — elle explique pourquoi certains titres mettent du temps, " +
                        "et ce que PLM peut (ou ne peut pas) garantir.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item { SectionTitle("Comment marche la lecture") }
            item {
                Bullet(
                    "Le son passe par notre serveur (proxy), pas directement depuis YouTube sur le téléphone. " +
                        "Le premier démarrage d’un titre rarement écouté peut prendre plusieurs secondes " +
                        "(résolution du flux côté serveur).",
                )
            }
            item {
                Bullet(
                    "En Wi‑Fi, PLM précharge ~5 secondes de beaucoup de titres de ta bibliothèque. " +
                        "Un titre déjà préchargé démarre plus vite ; un titre « froid » (peu ou jamais joué) " +
                        "peut patienter.",
                )
            }
            item {
                Bullet(
                    "Pendant le chargement, le mini-lecteur affiche « Chargement… ». " +
                        "Si ça dure trop, un message apparaît — tu peux passer au titre suivant.",
                )
            }
            item { HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f)) }
            item { SectionTitle("Problèmes fréquents") }
            item {
                Bullet(
                    "Titre de la file qui ne démarre pas / long silence : souvent un flux lent ou " +
                        "indisponible temporairement (YouTube / serveur). Attends quelques secondes, " +
                        "ou saute au suivant. PLM essaie aussi de reprendre automatiquement après ~8 s bloqués.",
                )
            }
            item {
                Bullet(
                    "Son qui coupe au milieu : fichier hors-ligne abîmé, ou coupure réseau. " +
                        "PLM peut basculer en streaming ; un toast l’indique.",
                )
            }
            item {
                Bullet(
                    "Versions Compte « installée » vs « serveur » : le catalogue APK Admin doit être " +
                        "republie après chaque release. Si tu es plus à jour que le serveur, tu es bien à jour " +
                        "sur le téléphone — le QR/Admin rattrape après publication.",
                )
            }
            item {
                Bullet(
                    "Hors-ligne : seuls les titres téléchargés (Téléchargements / aimés gardés) jouent. " +
                        "Le reste nécessite Internet.",
                )
            }
            item { HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f)) }
            item { SectionTitle("Limites à connaître") }
            item {
                Bullet(
                    "PLM n’est pas YouTube Music officiel : disponibilité des titres dépend de YouTube " +
                        "et de notre proxy. Certains titres régionaux ou restreints peuvent échouer.",
                )
            }
            item {
                Bullet(
                    "Pas de pubs dans le flux PLM, mais la qualité / latence dépend du réseau et de la charge serveur.",
                )
            }
            item {
                Bullet(
                    "Données mobiles : le préchargement massif de la bibliothèque est limité " +
                        "(économie forfait). Préfère le Wi‑Fi pour chauffer beaucoup de titres.",
                )
            }
            item {
                Bullet(
                    "Cast / lecteur système : les actions (j’aime, playlist, paroles) dépendent du téléphone ; " +
                        "tout n’est pas toujours visible selon le constructeur.",
                )
            }
            item { HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f)) }
            item { SectionTitle("Où regarder en cas de souci") }
            item {
                Bullet("Compte → Aide & limites (cette page).")
            }
            item {
                Bullet("Compte → Mise à jour : vérifier que l’app est à jour.")
            }
            item {
                Bullet("Compte → API & logs : diagnostics (réseau, erreurs) si on te le demande.")
            }
            item {
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.primary,
    )
}

@Composable
private fun Bullet(text: String) {
    Text(
        "• $text",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurface,
    )
}
