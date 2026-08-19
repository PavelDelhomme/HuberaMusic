# Package `ovh.delhomme.ytmusic`

Code source de l’application **PLM** (Android natif).

> Le segment `ytmusic` dans le package est **historique** (identifiant Play Store / installs).  
> L’app s’affiche **PLM** ou **PLM Dev** selon le flavor. Voir [`docs/PLM.md`](../../../../../../../../docs/PLM.md).

## Arborescence utile

| Dossier | Rôle |
|---------|------|
| `player/` | Lecteur Media3, prefetch, cache |
| `data/` | API, offline, modèles, réseau |
| `ui/` | Écrans Compose (home, library, player, auth…) |
| `auth/` | Passkeys Credential Manager |
| `debug/` | Logs, télémétrie, écran debug |

Historique projet : [`mobile-android/HISTORY.md`](../../../../../../HISTORY.md)  
Lecteur (EOS, offline, tests) : [`docs/ANDROID-PLAYER.md`](../../../../../../docs/ANDROID-PLAYER.md)
