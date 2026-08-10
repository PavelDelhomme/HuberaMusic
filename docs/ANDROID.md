# Application Android native (Kotlin)

Client **Kotlin + Jetpack Compose + Media3/ExoPlayer** — pas de WebView.

Sources : `mobile-android/` · Package : `ovh.delhomme.ytmusic`

## Structure monorepo

| Dossier | Rôle |
|---------|------|
| `api/` | Backend Express + SQLite + WebSocket |
| `web/` | Front React / Vite / PWA |
| `mobile-android/` | App Android Kotlin native |
| `desktop/` | Electron (optionnel) |

## Convention appareils

| Appareil | Rôle | API |
|----------|------|-----|
| **Samsung** | Développement | LAN `http://<IP-PC>:8787` |
| **Nothing** | Production | `https://ytmusic.delhomme.ovh` |

## Installer

```bash
make adb-wifi-ensure

# Samsung → DEV (API locale)
LAN=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}')
DEVICE=192.168.1.184:5555 API_BASE_URL=http://$LAN:8787 make android-install

# Nothing → PROD
DEVICE=192.168.1.44:5555 make android-prod

# Forcer une API
API_BASE_URL=http://192.168.x.x:8787 make android-install
make seed-users
```

> **Important** : sur un téléphone physique, `http://127.0.0.1:8787` pointe vers le téléphone
> (erreur « Failed to connect to /127.0.0.1:8787 »). Le script d’install utilise l’**IP LAN**
> de la machine + `adb reverse` en secours. Définis `ANDROID_API_BASE_URL` dans `.env` si besoin.

## Tests

Ordre : [`TESTS.LOCAL.md`](../TESTS.LOCAL.md) → [`TESTS_DEV.md`](../TESTS_DEV.md) → deploy → [`TESTS_PROD.md`](../TESTS_PROD.md).  
Index : [`TESTS.md`](../TESTS.md) · [`TESTING.md`](./TESTING.md).

## Auth

- Email / mot de passe préremplis depuis `.env` (`SEED_EMAIL` / `SEED_PASSWORD`)
- Passkeys via **Credential Manager** (Biblio → Enregistrer une passkey)
- Asset links : `GET /.well-known/assetlinks.json`

## Legacy Capacitor

`make android-capacitor` → `web/android/` (WebView, déconseillé).
