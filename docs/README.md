# Documentation PLM

| Document | Contenu |
|----------|---------|
| [backend/ARCHITECTURE.md](backend/ARCHITECTURE.md) | Backend API : modules, routes, schedulers, télémétrie, tables |
| [reco/ALGORITHMES.md](reco/ALGORITHMES.md) | Algorithmes de recommandation, ranking, radios, aléatoire, warm |
| [audits/CHECKLIST-AMELIORATIONS-2026-09-13.md](audits/CHECKLIST-AMELIORATIONS-2026-09-13.md) | Checklist améliorations UI / batterie |

## Digest chargement 12h30

Le serveur envoie chaque jour à **12h30 (Europe/Paris)** un mail listant les titres qui ont stallé / mis longtemps / cold next / prefetch miss (`api/src/platform/playbackDigest.ts`).

- Aperçu : `GET /api/admin/playback-digest`
- Envoi forcé : `POST /api/admin/playback-digest/send`
- Env : `PLAYBACK_DIGEST_TO`, `PLAYBACK_DIGEST_HOUR`, `PLAYBACK_DIGEST_MINUTE`
