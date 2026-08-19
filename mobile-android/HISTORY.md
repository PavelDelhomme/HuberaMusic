# Historique — client Android PLM

## Nom du projet

- **PLM** : nom affiché partout côté utilisateur (launcher, web, PWA, notifications).  
- **PueLaMerde** : nom complet du projet — historique et documentation, pas en gros dans l’UI.  
- **YTMusic** : nom du dépôt Git et de l’infra (domaine, packages Docker) ; renommage repo prévu plus tard.

## Chronologie (résumé)

| Période | Étape |
|---------|--------|
| 2024–2025 | PWA web + API Express ; sync bibliothèque YouTube Music (import Google) |
| 2025 | Client Android natif Kotlin + Compose + Media3 (remplace WebView / Capacitor) |
| 2025–2026 | Flavors **prod** (`p+`) / **dev** (`d+`) ; Nothing = prod, Samsung = dev LAN |
| 2026 | OAuth TV VPS — flux audio sans PC local ; télémétrie mail **PLM** |
| 2026-08 | Stabilisation lecteur Nothing : EOS, prefetch non bloquant, offline sans saturer `/api/stream`, idle BG 20 min |

## Package Java `ovh.delhomme.ytmusic`

Conservé pour ne pas casser les installs existantes (`ovh.delhomme.ytmusic` / `.dev`).  
Le dossier source porte encore `ytmusic` dans le chemin ; voir [`docs/PLM.md`](../docs/PLM.md).

## Lecteur

Architecture détaillée : [`docs/ANDROID-PLAYER.md`](../docs/ANDROID-PLAYER.md).

Points sensibles testés sur **Nothing A059** (USB ADB) :

- Enchaînement fin de piste sans rebouclage coda  
- Handover Wi‑Fi ↔ 4G sans skip milieu piste  
- Pas de crash « Player wrong thread » (accès Exo depuis IO interdit)  
- Durées file d’attente hydratées depuis Exo quand le catalogue YTM est incomplet

## Build

```bash
# Dev → Samsung (API LAN)
make android-install

# Prod → Nothing
make android-prod
```

Version : fichier `VERSION` à la racine du monorepo → `p+1.3.34` en prod debug.
