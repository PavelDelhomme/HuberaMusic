# Documentation backend PLM (`api/`)

**Date :** 2026-09-14  
**Périmètre :** serveur Node/Express dans `api/src/`  
**Note sur « chaque ligne » :** documenter *littéralement* chaque ligne de code dans les sources serait illisible et se périmerait à chaque commit. Ici : **carte complète de chaque fichier**, rôle, dépendances, points d’entrée, et comportement des fonctions importantes — l’équivalent utile d’une doc ligne-par-ligne.

---

## 1. Vue d’ensemble

```
Client Android / Web
        │  HTTPS + JWT / cookie
        ▼
┌───────────────────────────────┐
│  api/src/index.ts             │  Express + WebSocket
│  auth → library → media → reco│
└───────────────┬───────────────┘
                │
     ┌──────────┼──────────┐
     ▼          ▼          ▼
  SQLite/PG   cache/     yt-dlp /
  (db.ts)     stream     Innertube
```

- **Runtime :** Node 22+, TypeScript compilé / `tsx` en local.
- **HTTP :** Express (`cors`, cookies, `authOptional` global).
- **Temps réel :** WebSocket `/ws` (session multi-appareils côté web).
- **Mail :** `platform/mail.ts` → outbox SQLite + SMTP.
- **Schedulers au boot :** library health, taste warm, **playback digest 12h30**.

---

## 2. Arborescence `api/src/` (fichier par fichier)

### Racine

| Fichier | Rôle |
|---------|------|
| `index.ts` | Composition de l’app : middlewares, **toutes les routes HTTP**, WS, handlers fatals, démarrage schedulers. Point d’entrée unique du serveur. |

### `auth/` — identité et sessions

| Fichier | Rôle |
|---------|------|
| `auth.ts` | Login email/mdp, register (si autorisé), refresh tokens, `authOptional` / `requireAuth`, hash mots de passe, seed sync. |
| `sessions.ts` | État lecteur multi-appareils (`PUT /api/session/state`), soft devices, active player. |
| `passkeys.ts` | WebAuthn / passkeys. |
| `totp.ts` | 2FA TOTP. |
| `deviceLogin.ts` | Login TV / device code + poll. |

### `library/` — données utilisateur et catalogue

| Fichier | Rôle |
|---------|------|
| `db.ts` | Abstraction SQLite (`better-sqlite3`) ou PostgreSQL (`DATABASE_URL`). Helpers `prepare` / `exec`. |
| `library.ts` | CRUD biblio : likes, songs, albums, artists, playlists, history ; `getFullLibrary` / light. |
| `prefs.ts` | Schéma reco (`user_prefs`, `listen_events`, `pins`, `reco_weights`, feedback), getters poids hybridRank. |
| `shuffleHeads.ts` | Lot rotatif ~100 têtes « Aléatoire » + warm stream/disk. |
| `mixCache.ts` | Cache des mixes radio construits. |
| `offline.ts` | Jobs téléchargement offline (collections). |
| `ytmSync.ts` / liés | Sync compte YouTube Music si configuré. |

### `media/` — flux audio/vidéo, santé, warm

| Fichier | Rôle |
|---------|------|
| `stream.ts` | Cœur stream : resolve format, proxy ranges, warm queue, disk cache `.m4a`, budgets concurrence. |
| `streamHeal.ts` | Sur stall/cold/miss télémétrie → re-warm (cooldown 8 min, bump priority). |
| `streamLog.ts` | Journal `stream_log` des réponses HTTP stream. |
| `streamHeadCache.ts` | Têtes RAM (~1 Mo) pour démarrage chaud. |
| `tasteWarmScheduler.ts` | Prefetch prédictif goûts (intervalle ~12 min). |
| `libraryHealth.ts` | Balayage titres morts / remplacement + mail de cycle. |
| `trackReplacement.ts` | Trouve un ID de remplacement si vidéo indisponible. |
| `visualResolve.ts` | Résolution clip vidéo (official / VEVO) pour mode Vidéo. |
| `img.ts` | Proxy images `/api/img` + cache disque. |
| `ytDlpGate.ts` | Plafond processus yt-dlp + cooldown bot. |
| `import.ts` | Import par URL / kind. |

### `platform/` — ops, mails, télémétrie

| Fichier | Rôle |
|---------|------|
| `platform.ts` | Schéma `telemetry_events`, `mail_outbox` ; `insertTelemetry`, `listTelemetry`, `telemetryStats`. |
| `mail.ts` | `sendMail`, config SMTP, parsing From. |
| `telemetryAlert.ts` | Mails immédiats error/fatal/stall (throttle fingerprint). |
| `telemetryTracks.ts` | Extraction trackId + résolution titre (oembed / getTrack). |
| `telemetryDiagnose.ts` | Diagnostic textuel pour incidents. |
| `incidentReport.ts` | Rapports d’incident riches (PDF/texte). |
| `batteryReport.ts` | Mail optimisation batterie (POST client). |
| `playbackDigest.ts` | **Digest quotidien 12h30** stalls / cold / miss. |
| `textPdf.ts` | Génération PDF texte simple. |
| `admin.ts` / `adminUsers.ts` | Helpers admin. |
| `apkTickets.ts` | Tickets téléchargement APK. |
| `rateLimit.ts` | Rate limit basique. |
| `runtimeSettings.ts` | Settings runtime admin. |
| `deployRemote.ts` | Déploiement distant. |
| `log.ts` | Logging léger. |

### `reco/` — recommandations (détail : `docs/reco/ALGORITHMES.md`)

| Fichier | Rôle |
|---------|------|
| `reco.ts` | `hybridRank`, `homeReco`, `radioForUser`, `similarForUser`, explore, suggest. |
| `searchRank.ts` | Score résultats recherche + filtres musique. |
| `trackFeatures.ts` | Embeddings tags/énergie (similarité cosine). |
| `searchHits.ts` | Cache clics / hits search pour personalize. |

### `youtube/` — sources YouTube / YTM

| Fichier | Rôle |
|---------|------|
| `yt.ts` | Client Innertube / yt-dlp : getTrack, search, related, formats, lyrics. |
| `mappers.ts` | Mapping payloads → `Track` PLM. |
| `youtubeCookies.ts` | Cookies session anti-bot. |
| `streamAuth.ts` | Auth streams. |
| `ytm-account.ts` / `ytm-sync*` | Compte YTM. |
| `lyrics*` | Paroles. |
| `youtubeProxy.ts` | Stats / proxy éventuel. |

---

## 3. Cycle de vie d’une requête « lecture »

1. Client appelle `GET /api/stream/:id` (souvent après `POST /api/stream/warm`).
2. `stream.ts` : format cache → disque `.m4a` → Innertube/yt-dlp.
3. Ranges HTTP servis ; tête éventuellement en RAM (`streamHeadCache`).
4. Si le client stalle : `POST /api/telemetry` kind `android.player.stall` → `insertTelemetry` → `healTrackFromTelemetry` → warm.
5. Chaque jour à **12h30 Paris** : `playbackDigest` relit `telemetry_events` 24 h et maille le bilan.

---

## 4. Schedulers (processus longue durée)

| Scheduler | Fichier | Rythme | Effet |
|-----------|---------|--------|-------|
| Library health | `libraryHealth.ts` | tick 5 s (idle 30 min) | Probe titres, remplacements, mail de cycle |
| Taste warm | `tasteWarmScheduler.ts` | ~12 min | Prefetch goûts globaux |
| **Playback digest** | `playbackDigest.ts` | **12h30 Europe/Paris** | Mail problèmes chargement |
| Shuffle heads | à la demande + client ~90 s | Rotatif 30 min serveur | Têtes aléatoire |

Désactivation digest : `PLAYBACK_DIGEST_DISABLE=1`.

---

## 5. Tables clés (persistantes)

| Table | Usage |
|-------|-------|
| `users`, refresh tokens | Auth |
| `liked_tracks`, `library_*`, `history` | Biblio |
| `listen_events`, `user_prefs`, `pins`, `reco_weights` | Reco |
| `telemetry_events` | Stalls, crashes, diagnostics (rétention ~14 j) |
| `stream_log` | Journal HTTP stream |
| `track_health` | Santé / remplacements |
| `mail_outbox` | Historique mails |
| Cache fichiers | `data/cache/*.m4a`, heads RAM |

---

## 6. Routes admin utiles

| Route | Usage |
|-------|-------|
| `GET /api/admin/telemetry` | Liste + stats |
| `GET /api/admin/playback-digest` | Aperçu digest 24 h |
| `POST /api/admin/playback-digest/send` | Envoi forcé du mail |
| `GET /api/admin/library-health` | État balayage |
| `POST /api/admin/taste-warm` | Warm goûts immédiat |
| `GET /api/admin/smtp` / `POST .../test` | SMTP |

---

## 7. Variables d’environnement (extrait)

Voir `.env.example` :

- SMTP : `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- Alertes : `TELEMETRY_ALERT_TO`, `BATTERY_REPORT_TO`, `LIBRARY_HEALTH_REPORT_TO`
- Digest : `PLAYBACK_DIGEST_TO`, `PLAYBACK_DIGEST_HOUR`, `PLAYBACK_DIGEST_MINUTE`, `PLAYBACK_DIGEST_TZ`
- Stream : `STREAM_WARM_CONCURRENCY`, `YTDLP_MAX_CONCURRENT`, `YTDLP_BOT_COOLDOWN_MS`
- Auth : `ADMIN_EMAILS`, `AUTH_ALLOWED_EMAILS`, `JWT_SECRET`

---

## 8. Conventions de code backend

1. **Pas de secrets dans Git** — `.env` / Bitwarden.
2. **Heal / warm** : toujours throttlés (cooldown, concurrence).
3. **Mails** : passent par `sendMail` → outbox (traçabilité).
4. **Fatals process** : insert télémétrie + alerte (`uncaughtException`).
5. **Nouveaux modules** : un fichier = un domaine ; exposer via `index.ts` seulement les routes nécessaires.

---

## 9. Comment étendre

| Besoin | Où |
|--------|-----|
| Nouveau kind télémétrie | Client Android → `insertTelemetry` ; ajouter au filtre `playbackDigest` si pertinent |
| Nouvelle shelf Accueil | `homeReco` dans `reco.ts` |
| Nouveau signal ranking | `hybridRank` + éventuellement `reco_weights` |
| Nouveau mail planifié | Pattern `playbackDigest.ts` (délai jusqu’à heure Paris + `setTimeout` chaîné) |

---

## 10. Lien avec la doc algos

Les algorithmes de recommandation, ranking, radio, similar, shuffle-heads et taste-warm sont détaillés dans :

**[`docs/reco/ALGORITHMES.md`](../reco/ALGORITHMES.md)**
