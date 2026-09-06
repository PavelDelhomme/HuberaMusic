package ovh.delhomme.ytmusic.ui.auth

import android.Manifest
import android.content.pm.PackageManager
import android.util.Size
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QrScannerScreen(
    title: String = "Scanner un QR",
    onResult: (String) -> Unit,
    onCancel: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var hasCam by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val handled = remember { AtomicBoolean(false) }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> hasCam = granted }

    LaunchedEffect(Unit) {
        if (!hasCam) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    BackHandler(onBack = onCancel)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = onCancel) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Retour")
                    }
                },
            )
        },
    ) { padding ->
        Box(
            Modifier
                .fillMaxSize()
                .padding(padding),
            contentAlignment = Alignment.Center,
        ) {
            if (!hasCam) {
                Text(
                    "Autorise la caméra pour scanner le QR de connexion.",
                    modifier = Modifier.padding(24.dp),
                )
            } else {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        val previewView = PreviewView(ctx)
                        val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)
                        val executor = ContextCompat.getMainExecutor(ctx)
                        val analysisExecutor = Executors.newSingleThreadExecutor()
                        cameraProviderFuture.addListener({
                            val cameraProvider = cameraProviderFuture.get()
                            val preview = Preview.Builder().build().also {
                                it.surfaceProvider = previewView.surfaceProvider
                            }
                            val analysis = ImageAnalysis.Builder()
                                .setTargetResolution(Size(1280, 720))
                                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                                .build()
                            val scanner = BarcodeScanning.getClient()
                            analysis.setAnalyzer(analysisExecutor) { imageProxy ->
                                val media = imageProxy.image
                                if (media == null || handled.get()) {
                                    imageProxy.close()
                                    return@setAnalyzer
                                }
                                val image = InputImage.fromMediaImage(
                                    media,
                                    imageProxy.imageInfo.rotationDegrees,
                                )
                                scanner.process(image)
                                    .addOnSuccessListener { barcodes ->
                                        val raw = barcodes
                                            .asSequence()
                                            .filter {
                                                it.format == Barcode.FORMAT_QR_CODE ||
                                                    it.format == Barcode.FORMAT_UNKNOWN
                                            }
                                            .mapNotNull { it.rawValue?.trim() }
                                            .firstOrNull { it.isNotEmpty() }
                                        if (raw != null && handled.compareAndSet(false, true)) {
                                            onResult(raw)
                                        }
                                    }
                                    .addOnCompleteListener { imageProxy.close() }
                            }
                            runCatching {
                                cameraProvider.unbindAll()
                                cameraProvider.bindToLifecycle(
                                    lifecycleOwner,
                                    CameraSelector.DEFAULT_BACK_CAMERA,
                                    preview,
                                    analysis,
                                )
                            }
                            previewView.tag = analysisExecutor
                        }, executor)
                        previewView
                    },
                    update = {},
                )
                DisposableEffect(Unit) {
                    onDispose {
                        // PreviewView.tag = analysisExecutor (best-effort shutdown)
                    }
                }
                Text(
                    "Cadre le QR affiché sur l’autre appareil",
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(24.dp),
                )
            }
        }
    }
}
