# Lecteur Android PLM (Media3 / ExoPlayer)

Sources : `mobile-android/app/src/main/java/ovh/delhomme/ytmusic/player/`

## Composants

| Fichier | Rôle |
|---------|------|
| `PlaybackService.kt` | FGS, EOS, erreurs stream, autoplay service, promote offline |
| `PlayerController.kt` | UI state, file, sleep timer, sync durée Exo → queue |
| `StreamPrefetcher.kt` | Têtes HTTP / warm, circuit-breaker `isStreamDown()` |
| `PlaybackIdleGuard.kt` | Arrêt service ~20 min idle arrière-plan |
| `PlayerCache.kt` | Cache disque Exo |

Téléchargements : `data/OfflineDownloadManager.kt`, `LocalOfflineStore.kt`, `OfflineKeeper.kt`.

## Fin de morceau (EOS)

**Règle** : seule la durée **Exo** (conteneur réel) déclenche l’enchaînement automatique.

- `STATE_ENDED` → `handleNaturalEnd` : titre suivant ou fin de file user  
- Erreur réseau en fin de fichier → `nearExoEnd` (≥ 96 % ou ≤ 2,5 s restantes) — **pas** la durée catalogue YTM (souvent plus courte → skip prématuré corrigé en 1.3.34)  
- Stream tronqué milieu piste → `maybeRecoverEarlyEnd` (retour + 1 retry URL fraîche)  
- Boucle coda Nothing : retry désactivé si `mediaItemActuallyEnded` ou ratio Exo ≥ 85 %

## Skip « fin vide »

`PlayerController.maybeSkipTrailingSilence` : très conservateur (≥ 92 % du flux, ≤ 2 s restantes, padding meta explicite). Pas de skip sur fin de paroles seule.

## Prefetch vs offline complet

| Mode | Pendant lecture | Objectif |
|------|-----------------|----------|
| Têtes cache Exo (`prefetchUpcomingHeadsTiered`, `prefetchAroundIndex`) | **Oui** | Transition sans coupure |
| DL offline `.m4a` (`enqueueAhead`) | **Non** | Pas de 502 / saturation proxy |

- Titre suivant : tête plus grosse (~2,6 Mo Wi‑Fi) ; suite : ~3 s  
- Clic loin dans la file : prefetch ±2 titres autour de la cible  
- Cache LRU 64–160 Mo ; biblio : `warmHeads3s` au scroll  

## Offline / 502

Même route `/api/stream` que la lecture → risque saturation proxy.

| Garde-fou | Comportement |
|-----------|--------------|
| `StreamPrefetcher.markStreamDown(120s)` | Après 502/503/504 |
| `LocalOfflineStore.download` | Max 2 tentatives ; échec immédiat sur 5xx |
| `OfflineDownloadManager.enqueue` | Attend fin lecture + stream OK avant DL |
| Pas de `warmStream` si `isPlaybackActiveSafe()` | Évite ExoPlayer wrong thread |

## Durées dans la file

Exo ne fige pas `durationMs` dans `MediaItem` (écart catalogue vs flux).  
`PlayerController.syncFrom` enrichit le `TrackDto` courant via `withKnownDurationMs` → affichage `durationLabel()` dans la file.

## Tests automatisés (Nothing USB)

Les scripts ADB mettent `STREAM_MUSIC` à **0** par confort (nuit, open space) — **pas obligatoire** ; le volume n’impacte quasi pas la conso vs décodage + réseau. Voir § Volume & batterie en tête de ce fichier.

```bash
DEVICE=00145153K001434 NO_CHAOS=1 TRACKS=4 python3 scripts/android/nothing-eos-chain.py
DEVICE=00145153K001434 python3 scripts/android/nothing-usb-retest.py
DEVICE=R5CT7263YJL python3 scripts/android/samsung-network-handover.py
```

Rapports : `docs/reports/nothing-eos-*`, `nothing-usb-*`.

## Version de référence

Correctifs lecteur : **p+1.3.35** (`VERSION` à la racine).
