package ovh.delhomme.ytmusic.ui.search

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.os.Build
import android.speech.RecognizerIntent
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.IdentifySearchBody
import java.io.File
import java.util.Locale

/**
 * Lance la dictée Android (speech-to-text) pour remplir la barre de recherche.
 * [onResult] reçoit le premier texte reconnu.
 */
@Composable
fun rememberVoiceSearchLauncher(
    onResult: (String) -> Unit,
    onError: (String) -> Unit = {},
): () -> Unit {
    val context = LocalContext.current
    val speechLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val data = result.data
        val texts = data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
        val spoken = texts?.firstOrNull()?.trim().orEmpty()
        if (spoken.isNotEmpty()) onResult(spoken)
        else onError("Aucune parole détectée")
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            launchSpeechIntent(context, speechLauncher::launch, onError)
        } else {
            onError("Micro refusé — active l’autorisation micro")
        }
    }

    return {
        val ok = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (ok) {
            launchSpeechIntent(context, speechLauncher::launch, onError)
        } else {
            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }
}

private fun launchSpeechIntent(
    context: android.content.Context,
    launch: (Intent) -> Unit,
    onError: (String) -> Unit,
) {
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PROMPT, "Dis un titre, un artiste…")
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
        // FR + RU si dispo côté moteur appareil
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, Locale.getDefault().toLanguageTag())
    }
    if (intent.resolveActivity(context.packageManager) == null) {
        onError("Dictée indisponible sur cet appareil")
        return
    }
    launch(intent)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchIdentifySheet(
    container: AppContainer,
    onDismiss: () -> Unit,
    onQuery: (String) -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var mode by remember { mutableStateOf("listen") } // listen | hum
    var phase by remember { mutableStateOf("idle") } // idle | recording | uploading | done | error
    var message by remember { mutableStateOf<String?>(null) }
    var matched by remember { mutableStateOf<String?>(null) }
    var recorder by remember { mutableStateOf<MediaRecorder?>(null) }
    var outFile by remember { mutableStateOf<File?>(null) }

    fun stopRecorder() {
        runCatching {
            recorder?.apply {
                stop()
                release()
            }
        }
        recorder = null
    }

    DisposableEffect(Unit) {
        onDispose {
            stopRecorder()
            outFile?.delete()
        }
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            phase = "ready"
            message = null
        } else {
            phase = "error"
            message = "Micro refusé"
        }
    }

    fun startRecording() {
        val ok = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (!ok) {
            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        scope.launch {
            try {
                stopRecorder()
                val file = File(context.cacheDir, "identify-${System.currentTimeMillis()}.m4a")
                outFile = file
                val mr = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    MediaRecorder(context)
                } else {
                    @Suppress("DEPRECATION")
                    MediaRecorder()
                }
                mr.setAudioSource(MediaRecorder.AudioSource.MIC)
                mr.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                mr.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                mr.setAudioEncodingBitRate(128_000)
                mr.setAudioSamplingRate(44_100)
                mr.setOutputFile(file.absolutePath)
                mr.prepare()
                mr.start()
                recorder = mr
                phase = "recording"
                message = if (mode == "hum") {
                    "Fredonne le refrain (~10 s)…"
                } else {
                    "Écoute la musique autour de toi (~10 s)…"
                }
                delay(10_000)
                if (recorder != null) {
                    stopRecorder()
                    phase = "uploading"
                    message = "Analyse en cours…"
                    val slow = launch {
                        delay(8_000)
                        if (phase == "uploading") {
                            message = "L’analyse des paroles prend plus de temps que d’habitude. Ça continue."
                        }
                    }
                    val bytes = withContext(Dispatchers.IO) { file.readBytes() }
                    if (bytes.size < 800) {
                        phase = "error"
                        message = "Enregistrement trop court"
                        return@launch
                    }
                    val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                    val resp = withContext(Dispatchers.IO) {
                        container.ensureFreshToken()
                        container.api.identifySearch(
                            IdentifySearchBody(
                                audioBase64 = b64,
                                mimeType = "audio/mp4",
                                mode = mode,
                            ),
                        )
                    }
                    file.delete()
                    slow.cancel()
                    if (resp.ok && !resp.query.isNullOrBlank()) {
                        matched = listOfNotNull(resp.artist, resp.title)
                            .joinToString(" — ")
                            .ifBlank { resp.query }
                        phase = "done"
                        message = resp.hint
                        onQuery(resp.query!!)
                    } else {
                        phase = "error"
                        message = listOfNotNull(resp.error, resp.hint).joinToString("\n")
                            .ifBlank { "Aucun titre reconnu" }
                    }
                }
            } catch (e: Exception) {
                stopRecorder()
                phase = "error"
                message = e.message ?: "Échec enregistrement"
            }
        }
    }

    ModalBottomSheet(
        onDismissRequest = {
            stopRecorder()
            onDismiss()
        },
        sheetState = sheetState,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "Reconnaître un titre",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = {
                    stopRecorder()
                    onDismiss()
                }) {
                    Icon(Icons.Default.Close, contentDescription = "Fermer")
                }
            }
            Text(
                "Écoute ambiante ou fredonnement pour identifier un titre.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = mode == "listen",
                    onClick = { if (phase != "recording" && phase != "uploading") mode = "listen" },
                    label = { Text("Écouter") },
                    leadingIcon = { Icon(Icons.Default.GraphicEq, null, Modifier.size(18.dp)) },
                )
                FilterChip(
                    selected = mode == "hum",
                    onClick = { if (phase != "recording" && phase != "uploading") mode = "hum" },
                    label = { Text("Fredonner") },
                    leadingIcon = { Icon(Icons.Default.MusicNote, null, Modifier.size(18.dp)) },
                )
            }
            Spacer(Modifier.height(24.dp))

            val pulse = rememberInfiniteTransition(label = "pulse")
            val scale by pulse.animateFloat(
                initialValue = 1f,
                targetValue = 1.18f,
                animationSpec = infiniteRepeatable(
                    animation = tween(700, easing = LinearEasing),
                    repeatMode = RepeatMode.Reverse,
                ),
                label = "scale",
            )
            Box(
                Modifier
                    .size(112.dp)
                    .scale(if (phase == "recording") scale else 1f)
                    .clip(CircleShape)
                    .background(
                        when (phase) {
                            "recording" -> MaterialTheme.colorScheme.error
                            "uploading" -> MaterialTheme.colorScheme.primary.copy(alpha = 0.85f)
                            "done" -> Color(0xFF2E7D32)
                            "error" -> MaterialTheme.colorScheme.errorContainer
                            else -> MaterialTheme.colorScheme.primary
                        },
                    ),
                contentAlignment = Alignment.Center,
            ) {
                when (phase) {
                    "uploading" -> CircularProgressIndicator(
                        color = Color.White,
                        modifier = Modifier.size(36.dp),
                        strokeWidth = 3.dp,
                    )
                    else -> Icon(
                        if (mode == "hum") Icons.Default.MusicNote else Icons.Default.Mic,
                        contentDescription = null,
                        tint = if (phase == "error") MaterialTheme.colorScheme.onErrorContainer else Color.White,
                        modifier = Modifier.size(44.dp),
                    )
                }
            }

            Spacer(Modifier.height(16.dp))
            Text(
                when (phase) {
                    "idle", "ready" -> if (mode == "hum") "Appuie pour fredonner" else "Appuie pour écouter"
                    "recording" -> message ?: "Écoute…"
                    "uploading" -> message ?: "Analyse…"
                    "done" -> matched ?: "Trouvé !"
                    "error" -> message ?: "Erreur"
                    else -> message.orEmpty()
                },
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
            if (phase == "done" && !message.isNullOrBlank()) {
                Text(
                    message!!,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            if (phase == "error" && !message.isNullOrBlank() && matched == null) {
                Text(
                    message!!,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }

            Spacer(Modifier.height(20.dp))
            when (phase) {
                "idle", "ready", "error", "done" -> {
                    Button(
                        onClick = {
                            matched = null
                            message = null
                            startRecording()
                        },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp),
                    ) {
                        Text(if (phase == "done" || phase == "error") "Réessayer" else "Démarrer")
                    }
                }
                "recording" -> {
                    TextButton(onClick = {
                        stopRecorder()
                        phase = "idle"
                        message = null
                    }) { Text("Annuler") }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

/** Petits boutons trailing de la barre recherche. */
@Composable
fun SearchBarVoiceActions(
    onVoiceSearch: () -> Unit,
    onIdentify: () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onVoiceSearch) {
            Icon(
                Icons.Default.Mic,
                contentDescription = "Dictée vocale",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        IconButton(onClick = onIdentify) {
            Icon(
                Icons.Default.MusicNote,
                contentDescription = "Reconnaître un titre",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
