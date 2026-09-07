# Suite après seek/pins (dev)

## Fait
- `fix/seek-and-pins-order` → mergé dans `dev` (#392 + #393 / 1.3.177)
- Branche courante : `feat/library-shuffle-prefetch`

## Décisions prefetch aléatoire (user 2026-09-07)
- Serveur : ~100 têtes compressées (débuts de flux) tirées de la biblio, shuffle **faux-aléatoire** (seed par créneau).
- **Rotation plusieurs dizaines de fois / jour** (créneaux ~30 min ≈ 48×/j) pour ne pas figer les mêmes titres.
- Priorité warm proxy/disk côté serveur ; Android ne tire que ce batch (warm léger).
- Anti-récent : exclure les ~400 derniers écoutés du pool tête.

## Reco (accueil / similaires) — même lot
- Renforcer le poids des prefs onboarding (genres / artistes / ambiances) sur `homeReco` + `similarForUser`.
- Continuer feedback skip/complete déjà en place.

## Ensuite
- Test `:dev` (Samsung → Nothing) puis promo prod via `DEPLOY_SSH` / `DEPLOY_SSH_CMD`.
