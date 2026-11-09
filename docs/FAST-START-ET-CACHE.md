# Démarrage instantané & auto-heal global — Hubera Music

> Doc technique (compatible Hubera Docs). Version 1.3.414 · branche `feat/music-fast-start`.

## Problème traité

Un titre froid (jamais écouté) mettait plusieurs secondes — parfois ne démarrait
jamais : la résolution du flux traversait une cascade **en série** dont chaque
étape attendait son délai complet (relais maison → format 40 s → googlevideo 35 s
→ yt-dlp 75 s). Côté mobile, `ANDROID_COLD_DISK_WAIT_MS = 28 s` laissait
l'utilisateur sur un écran « ça charge », et le téléchargement disque n'était
lancé qu'en repli, trop tard.

## Réponse : trois leviers

```
                    ┌──────────────────────────────┐
   Recherche ──────►│ speculativePrewarm (8 titres)│──► files warm + disk
   Album/File ─────►└──────────────────────────────┘
                              │ (arrière-plan, après réponse HTTP)
                              ▼
   Clic ──────────►  cache RAM tête ?  ──oui──►  1ᵉʳ octet ~< 50 ms
                     │ non
                     ▼
                    .m4a disque ≥ 1 Mo ?  ──oui──►  1ᵉʳ octet ~< 50 ms
                     │ non
                     ▼
                    résolution format (course parallèle) ──► 1ᵉʳ octet < 4 s
                     │ échec
                     ▼
                    streamHealthHub.healTrackForEveryone()
                     ├─ ensurePlayableOnDisk (disque partagé)
                     ├─ remplaçant canonique (track_id_replacements)
                     ├─ re-warm ciblé
                     └─ streamIncident → Hubera Docs + mail ops
```

### 1. Préchargement agressif — `api/src/media/fastStart.ts`

- `speculativePrewarm(ids, { userId, source })` : appelé après l'envoi de la réponse
  HTTP (donc invisible pour l'utilisateur). Pousse la fenêtre visible (`FAST_START_PREWARM`,
  défaut 8) dans les files `warm` (format, bon marché) et `disk` (`.m4a`, limité à
  `FAST_START_PREWARM_DISK`, défaut 2). Ne remplit pas les slots `yt-dlp` si une
  écoute est déjà en cours (`isPlaybackHot`).
- `isInstantReady(id)` : disque ≥ 1 Mo ou tête RAM présente → rien à faire.
- `waitForInstantStart(id)` : attente bornée du premier octet.

### 2. Auto-heal global — `api/src/media/streamHealthHub.ts`

`healTrackForEveryone(videoId, { reason, userId, record })` :

1. dédupliqué (40 s par titre, `HEAL_COOLDOWN_MS`) et idempotent (`inflight`) ;
2. appelle `fastStart.healGlobally` → `ensurePlayableOnDisk` (disque partagé,
   remplaçant autorisé) ;
3. si l'id canonique change, `trackReplacement` persiste le mapping lu par **tous**
   les comptes au prochain play ;
4. remet le titre en file chaude + bump de priorité ;
5. consigne l'incident (`streamIncident`).

Déclenché par : la télémétrie client (`streamHeal`), les réponses 410/503 de
`handleStream` (`triggerGlobalHeal`), l'endpoint admin, les scripts QA.

### 3. Consignation — `api/src/media/streamIncident.ts`

- Tâche **Hubera Docs** : `POST /api/tasks` via `platform/docsTask` (projet `music`,
  catégorie `bug`), jeton de service depuis `DOCS_SERVICE_TOKEN`.
- **Mail ops** via `platform/mail.sendMail` (SMTP maison, outbox sinon).
- Déduplication 30 min (`STREAM_INCIDENT_DEDUP_MS`) et plafond 12/h
  (`STREAM_INCIDENT_MAX_PER_HOUR`) pour ne jamais boucler.
- Corps sans secret : id, titre, motif, via, durée, compte tronqué.

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `FAST_START_PREWARM` | 8 | titres pré-résolus devant une liste |
| `FAST_START_PREWARM_DISK` | 2 | `.m4a` complets préchargés |
| `FAST_START_FIRST_BYTE_MS` | 4000 | budget premier octet |
| `ANDROID_COLD_DISK_WAIT_MS` | 6000 | attente disque côté Android (était 28 000) |
| `HEAL_COOLDOWN_MS` | 40000 | anti-tempête réparation |
| `STREAM_INCIDENT_DEDUP_MS` | 1800000 | dédup incidents |
| `STREAM_INCIDENT_MAX_PER_HOUR` | 12 | plafond mails/h |
| `DOCS_SERVICE_TOKEN`, `DOCS_API_URL` | — | tâche Hubera Docs (skippée si absent) |
| `STREAM_INCIDENT_EMAIL` / `OPS_ALERT_EMAIL` | SMTP_REPLY_TO | destinataire mail ops |

## Endpoints

- `GET /api/admin/fast-start` (admin) — compteurs et échecs récents.
- `POST /api/admin/heal-track` (admin) — `{ videoId, title?, artist?, reason?, record? }`.

## Vérification

```bash
# API locale
npm run dev -w api
# E2E multi-profils + TTFB
node scripts/qa/fast-start-e2e.mjs --base http://127.0.0.1:8787
# Identifiants de test
node scripts/tests/generate-hubera-users.mjs
```

Résultat de référence (local) : **8/8**, premier octet 4 ms sur titre préchargé,
auto-heal titre mort ~8 s.

## Non couvert volontairement

- Pas de contournement de copyright : tout passe par YouTube Music / Innertube / yt-dlp.
- Pas de `docker compose down -v`, pas de renommage de volume.
- Le jeton Docs n'est jamais loggé ni commité.
