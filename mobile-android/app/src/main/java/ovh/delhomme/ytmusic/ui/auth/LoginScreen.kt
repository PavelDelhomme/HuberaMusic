package ovh.delhomme.ytmusic.ui.auth

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fingerprint
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import ovh.delhomme.ytmusic.auth.DeviceLoginQr
import ovh.delhomme.ytmusic.data.AppContainer

@Composable
fun LoginScreen(
    container: AppContainer,
    onLoggedIn: () -> Unit,
    vm: AuthViewModel = viewModel(factory = AuthViewModel.factory(container)),
) {
    val state by vm.state.collectAsState()
    var passwordVisible by remember { mutableStateOf(false) }
    var showScanner by remember { mutableStateOf(false) }
    val context = LocalContext.current
    LaunchedEffect(state.loggedIn) {
        if (state.loggedIn) onLoggedIn()
    }
    if (state.loggedIn) return

    if (showScanner) {
        QrScannerScreen(
            title = "Scanner l’invite QR",
            onCancel = { showScanner = false },
            onResult = { raw ->
                showScanner = false
                vm.claimFromScannedQr(raw)
            },
        )
        return
    }

    if (state.offerPasskey) {
        AlertDialog(
            onDismissRequest = { /* forcer un choix */ },
            icon = { Icon(Icons.Default.Fingerprint, contentDescription = null) },
            title = { Text("Connexion rapide ?") },
            text = {
                Text(
                    "Enregistre une passkey (Bitwarden, Google Password Manager, empreinte…) " +
                        "pour te reconnecter sans mot de passe. Sinon tu pourras le faire plus tard dans Compte.",
                )
            },
            confirmButton = {
                Button(
                    onClick = { vm.enrollPasskey(context) },
                    enabled = !state.loading,
                ) {
                    if (state.loading) CircularProgressIndicator(modifier = Modifier.height(18.dp))
                    else Text("Enregistrer")
                }
            },
            dismissButton = {
                TextButton(
                    onClick = vm::dismissPasskeyOffer,
                    enabled = !state.loading,
                ) {
                    Text("Plus tard")
                }
            },
        )
        state.error?.let {
            Text(
                it,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(16.dp),
            )
        }
        return
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            "PLM",
            style = MaterialTheme.typography.headlineLarge,
            fontWeight = FontWeight.Bold,
            color = MaterialTheme.colorScheme.primary,
        )
        Text(
            "Musique sans pubs",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (container.apiEnvKind() == "prod") {
            Text(
                "PROD · plm (défaut) + ytmusic",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Text(
                container.apiEnvLabel(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            container.resolvedApiBase(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(modifier = Modifier.height(20.dp))

        if (!state.registerMode && !state.forgotMode) {
            Text(
                "Connexion rapide (QR)",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(modifier = Modifier.height(8.dp))
            val approveUrl = state.deviceApproveUrl
            if (!approveUrl.isNullOrBlank()) {
                val bmp = remember(approveUrl) { DeviceLoginQr.bitmap(approveUrl, 512) }
                Image(
                    bitmap = bmp.asImageBitmap(),
                    contentDescription = "QR de connexion",
                    modifier = Modifier.size(180.dp),
                )
            } else {
                CircularProgressIndicator(modifier = Modifier.size(36.dp))
            }
            Text(
                when (state.deviceQrStatus) {
                    "expired" -> "QR expiré — nouveau en cours…"
                    else -> "Scanne avec un appareil déjà connecté (app ou site)."
                },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
            )
            OutlinedButton(
                onClick = { showScanner = true },
                enabled = !state.loading,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Default.QrCodeScanner, contentDescription = null)
                Text("  Scanner un QR d’invite")
            }
            Text(
                "Ou scanne le QR affiché dans Compte sur ton autre appareil.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp, bottom = 12.dp),
            )
        }

        if (state.registerMode) {
            OutlinedTextField(
                value = state.name,
                onValueChange = vm::updateName,
                label = { Text("Nom") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(modifier = Modifier.height(10.dp))
            Text(
                "Important : après connexion, ouvre Compte → Aide & limites. " +
                    "Ça explique le chargement des titres, le hors-ligne et les limites de PLM.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 10.dp),
            )
        }
        OutlinedTextField(
            value = state.email,
            onValueChange = vm::updateEmail,
            label = { Text("Email") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth(),
        )
        if (!state.forgotMode) {
            Spacer(modifier = Modifier.height(10.dp))
            OutlinedTextField(
                value = state.password,
                onValueChange = vm::updatePassword,
                label = { Text("Mot de passe") },
                singleLine = true,
                visualTransformation = if (passwordVisible) {
                    VisualTransformation.None
                } else {
                    PasswordVisualTransformation()
                },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                trailingIcon = {
                    IconButton(onClick = { passwordVisible = !passwordVisible }) {
                        Icon(
                            imageVector = if (passwordVisible) {
                                Icons.Default.VisibilityOff
                            } else {
                                Icons.Default.Visibility
                            },
                            contentDescription = if (passwordVisible) {
                                "Masquer le mot de passe"
                            } else {
                                "Afficher le mot de passe"
                            },
                        )
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (state.needs2fa && !state.forgotMode) {
            Spacer(modifier = Modifier.height(10.dp))
            OutlinedTextField(
                value = state.totp,
                onValueChange = vm::updateTotp,
                label = { Text("Code 2FA") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        state.error?.let {
            Spacer(modifier = Modifier.height(10.dp))
            Text(it, color = MaterialTheme.colorScheme.error)
        }
        state.info?.let {
            Spacer(modifier = Modifier.height(10.dp))
            Text(it, color = MaterialTheme.colorScheme.primary)
        }
        Spacer(modifier = Modifier.height(18.dp))
        Button(
            onClick = vm::submit,
            enabled = !state.loading,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (state.loading) CircularProgressIndicator(modifier = Modifier.height(20.dp))
            else Text(
                when {
                    state.forgotMode -> "Envoyer le lien"
                    state.registerMode -> "Créer un compte"
                    else -> "Se connecter"
                },
            )
        }
        if (!state.registerMode && !state.forgotMode) {
            Spacer(modifier = Modifier.height(6.dp))
            TextButton(onClick = vm::openForgotPassword, enabled = !state.loading) {
                Text("Mot de passe oublié ?")
            }
            Spacer(modifier = Modifier.height(4.dp))
            OutlinedButton(
                onClick = { vm.loginWithPasskey(context) },
                enabled = !state.loading,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Default.Fingerprint, contentDescription = null)
                Text("  Continuer avec une passkey")
            }
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                "Bitwarden / GPM / empreinte — active le fournisseur de passkeys dans les Réglages Android.",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        TextButton(
            onClick = {
                if (state.forgotMode) vm.cancelForgotPassword() else vm.toggleMode()
            },
            enabled = state.forgotMode || state.allowRegister || state.registerMode,
        ) {
            Text(
                when {
                    state.forgotMode -> "Retour à la connexion"
                    state.registerMode -> "Déjà un compte ? Connexion"
                    !state.allowRegister -> "Inscription fermée"
                    else -> "Créer un compte"
                },
            )
        }
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            "Email / 2FA / Passkey / QR appareil.",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
