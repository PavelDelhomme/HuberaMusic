# Changelog — Hubera Music

Toutes les évolutions notables de l'application. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; versions = `VERSION`.

## [1.3.416] — 2026-11-11 — Vérification de mise à jour réparée (« apk/info indisponible »)

### 🔴 Correctif critique OTA
La MAJ système échouait **toujours** (`apk/info indisponible`) même quand la
requête serveur réussissait (HTTP 200). Cause : dans
`ApkUpdateManager.fetchApkInfo`, le bloc `coroutineScope` se terminait par un
`return@coroutineScope` **suivi d'un `throw IOException` inconditionnel** — la
valeur de succès était jetée puis l'exception levée systématiquement.

- la valeur du `coroutineScope` est désormais renvoyée par la fonction ;
- timeouts client OTA élargis (connect 8 s / read 20 s / call 25 s) ;
- journalise la cause par host en cas d'échec réel.

Vérifié sur Nothing Phone (3a), Samsung S21 FE, BlackView : `ui_message`
= « Application à jour — p+1.3.416 », `ui_phase` = `UpToDate`, aucune erreur.

### ✅ Accès rapide (épingler / désépingler)
Vérifié de bout en bout sur l'appareil : `POST /api/pins` → 200 (épingler),
`DELETE /api/pins/<id>` → 200 (désépingler), indicateur de carte
« Épinglé — retirer de l'accès rapide » affiché immédiatement.

## [1.3.414] — 2026-11-10 — Incident prod résolu + démarrage instantané & auto-heal global

### 🔴 Incident de production (corrigé le 10/11)

Le conteneur `ytmusic` était **`Up (unhealthy)` avec 26 redémarrages** : la prod
tournait l'image `ytmusic:search-durable` (**build du 30/10**) sans le correctif
`9ff0929` (1.3.413).

- `RangeError: Maximum call stack size exceeded` en boucle dans `api/src/media/stream.ts`
- `Health check exceeded timeout (5s)` × 5
- `plm.delhomme.ovh/api/health` → timeout · `music.hubera.cloud/api/health` → 404

**Cause** : dans `handleStream`, le repli DASH lançait `downloadTrack(...)` de façon
synchrone alors que la réponse était déjà en cours → ré-entrée récursive →
stack overflow → `PromiseRejectCallback` en boucle.

**Correctif** : image `ytmusic:1.3.414` (depuis `dev`) +
`docker-compose.override.yml` basculé + `docker compose up -d --no-deps --force-recreate`.
Volume `ytmusic_ytmusic_data` (20,6 Go) **jamais touché**.

| Indicateur | Avant | Après |
|---|---|---|
| Status | unhealthy | **healthy** |
| Restarts | 26 | **0** |
| RangeError | en boucle | **0** |
| `/api/health` (2 domaines) | timeout / 404 | **200 / 200** |

### Ajouté

- **`api/src/media/fastStart.ts`** — préchargement agressif et cache instantané :
  - `speculativePrewarm()` : dès qu'une liste est vue (recherche, album, playlist,
    file), les formats des N premiers titres sont résolus en arrière-plan et les
    premiers `.m4a` téléchargés — sans bloquer la réponse HTTP.
  - `waitForInstantStart()` : attente bornée du premier octet (`FAST_START_FIRST_BYTE_MS`,
    défaut 4 s).
  - `healGlobally()` : réparation d'un titre pour **tous** les comptes.
  - `isInstantReady()`, `forceDiskPrepare()`, `notePlaybackFailure()`.
- **`api/src/media/streamHealthHub.ts`** — point d'entrée unique « un son plante » :
  `healTrackForEveryone()` (réparation globale + remise en file chaude + incident),
  `healManyForEveryone()` (lots), déduplication 40 s par titre.
- **`api/src/media/streamIncident.ts`** — consignation d'incident : tâche **Hubera Docs**
  (projet `music`, catégorie `bug`) + **mail ops**, dédupliquée 30 min, plafonnée 12/h.
- **Endpoints admin** :
  - `GET /api/admin/fast-start` → compteurs `fastStart`, `healthHub`, `incidents`, échecs récents.
  - `POST /api/admin/heal-track` → réparation à la demande d'un `videoId` pour tout le monde.
- **Tests** : `scripts/qa/fast-start-e2e.mjs` (E2E multi-profils + TTFB),
  `scripts/tests/generate-hubera-users.mjs`, `user-cases.json`.

### Modifié
- **`playbackPolicy.ts`** — `ANDROID_COLD_DISK_WAIT_MS` : 28 s → **6 s**
  (le titre est désormais chaud à l'arrivée ; réglable par env).
- **`stream.ts`** — `sendStreamUnavailable` / `sendStreamRetryLater` déclenchent
  l'auto-heal global (`triggerGlobalHeal`) : 410/503 ne repartent plus jamais sans réparation.
- **`streamHeal.ts`** — la télémétrie passe par `streamHealthHub` : la réparation
  met à jour le disque partagé + le mapping canonique de **tous** les comptes
  (avant : remappage local uniquement), et consigne l'incident.
- **`index.ts`** — `/api/search` déclenche `speculativePrewarm` sur toute la fenêtre visible.

### Mesuré (local, test E2E `8/8`)
- Premier octet : **4–20 ms** sur titre préchargé (HTTP 206).
- Préchargement : **+8 titres** chauffés après une recherche.
- Auto-heal : titre mort réparé en ~8 s, remplacement canonique trouvé automatiquement.

### Notes d'exploitation
- Env utiles : `FAST_START_PREWARM` (8), `FAST_START_PREWARM_DISK` (2),
  `FAST_START_FIRST_BYTE_MS` (4000), `ANDROID_COLD_DISK_WAIT_MS` (6000),
  `STREAM_DASH_RELAY_FALLBACK`, `HEAL_COOLDOWN_MS` (40000),
  `STREAM_INCIDENT_DEDUP_MS` (1 800 000), `STREAM_INCIDENT_MAX_PER_HOUR` (12),
  `DOCS_SERVICE_TOKEN` + `DOCS_API_URL` (sinon la tâche Docs est skippée),
  `STREAM_INCIDENT_EMAIL` / `OPS_ALERT_EMAIL` (sinon mail ops skippé).
- Aucun secret en clair : jetons lus depuis l'environnement serveur uniquement.
