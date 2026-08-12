# TESTS_PROD — Session PROD (Nothing + web / API prod)

À lancer **uniquement** après LOCAL + DEV OK et déploiement VPS réussi (`dev` → `prod` + Pull Portainer).

| Surface | Cible |
|---------|--------|
| Web | https://ytmusic.delhomme.ovh |
| API | même origin `/api/health` |
| Nothing | APK **prod** (`DEVICE=192.168.1.44:5555 make android-prod`) |
| Samsung | smoke APK prod optionnel |
| Serveur | VPS / Portainer / volumes / cookies |

```bash
make adb-both
curl -sS https://ytmusic.delhomme.ovh/api/health | jq .
# appVersion / ref doivent matcher le commit déployé
DEVICE=192.168.1.44:5555 make android-prod
make link-home-stream   # si streams 502 (IP datacenter)
node scripts/test/smoke-load-test.mjs prod
```

Tracking : [`STATUS.md`](./STATUS.md) · [`ERRORS.md`](./ERRORS.md) · index [`TESTS.md`](./TESTS.md) (**R1–R12**).

### Journal sessions

| Date | Commit / version | Résultat | Notes |
|------|------------------|----------|-------|
| 2026-08-12 | `p+1.3.17` | **Samsung PROD smoke OK** (Nothing reporté) | APK `ovh.delhomme.ytmusic` ; login ; Accueil ; **Papaoutai PLAYING** ; Compte → passkey + `PROD · https://ytmusic.delhomme.ovh` ; stream 206 ~0,2 s ; gzip/head-cache **pas encore** sur VPS (attendre promo) |
| 2026-08-12 | (à venir) R1–R12 | À faire après promo | Passkeys, paroles, DL ack, À suivre, UI playlist, membership… |
| 2026-08-12 | `a481e3b` / `p+1.3.17` | Health OK ; streams 206 (tunnel) ; Nothing APK UP | E1–E5 ; warm ~16 s ; badge SW stale |

---

## P0 — Gate serveur (bloquant)

- [ ] DNS OK ; HTTPS valide
- [ ] `GET /api/health` → `ok`, `ref: prod` / `appEnv: production`
- [ ] `appVersion` = version attendue (pas une vieille `1.3.9` si on a livré plus récent)
- [ ] `playback.premiumRequired === false` ; `ytdlp: true`
- [ ] Conteneur Portainer **healthy** ; volumes non effacés
- [ ] Tunnel maison UP si requis (`make link-home-stream-status`)
- [ ] Image GHCR tag `:prod` / `:latest` digest récent
- [ ] WSS upgrade OK avec JWT
- [ ] `GET /.well-known/assetlinks.json` → package prod (+ fingerprints)

Si P0 KO → **stop** ([`DEPLOY.md`](./DEPLOY.md)).

---

## P1 — Auth (web + Nothing) — R7 / E7

- [ ] Login / mauvais mdp / logout / cold start session
- [ ] Inscription selon `allowRegister`
- [ ] Admin seulement pour admin
- [ ] Passkey web si configuré (Bitwarden / plateforme)
- [ ] Nothing : bouton passkey visible ; enroll + login Bitwarden / GPM / empreinte
- [ ] APK prod classée **Audio / Divertissement** (R11)

---

## P2 — Batterie & usage (Nothing)

- [ ] `make adb-wifi-doctor` → Nothing ✅
- [ ] 15–30 min usage réel (lecture + biblio + next)
- [ ] Optionnel : `INCLUDE_NOTHING=1 make battery-go-calm` (Nothing)
- [ ] Email rapport batterie

---

## P3 — Erreurs → email

- [ ] Erreur stream / crash → email reçu avec version **prod** + device Nothing
- [ ] Visible aussi dans admin outbox / logs serveur
- [ ] Pas de boucle mail

---

## P4 — Pages + scroll + progressif (web prod + Nothing) — R2, R3

### Accueil
- [ ] Accès rapide, mixes covers, shelves
- [ ] Playlists / cartes : **trackCount entier** — pas crash / texte views (R2)
- [ ] Podcasts / chips Albums·Livres·Podcasts (si déployé)
- [ ] Explorer : images + noms OK
- [ ] Prefetch scroll listes longues (R3)

### Artiste / Album / Titres
- [ ] Cartes albums/singles ; état scroll ; perf
- [ ] Album DL progress live

### File — R1
- [ ] Auto + depuis album ; next/prev stables (20×)
- [ ] **À suivre** toujours visible ; autoplay OFF = stop fin de file user
- [ ] Suivant charge la suite ; préf `/api/prefs` sync multi-appareils
- [ ] À suivre / related : audio-first vs clips Officiel ; titres sans « Officiel » (R13)
- [ ] Fin de piste complète (pas de saut anticipé / erreurs spam) (R14)

### Playlists / Mixes — R4
- [ ] Play + Aléatoire + icône DL + menu ⋮ (télécharger tout, file, mix, rename/delete si à toi)
- [ ] Membership « déjà dans playlist » immédiat (R9 / E9)
- [ ] Mixes user + générés ; Mix Nouveauté ; mixes déjà écouté
- [ ] Mix depuis album / artiste / titre

### Pins / j’aime
- [ ] J’aime titre/album ; épingles Accès rapide

---

## P5 — Lecteur — R8, R10

- [ ] Play/pause/seek/next/prev ; NP scroll
- [ ] Paroles sync (~0,5 s d’avance max) ; Trop tôt / Trop tard
- [ ] Paroles Keny : *Capitale de la rupture* + *Vie d’artiste*
- [ ] Stream 206 `/api/stream/:id` (tunnel si besoin)
- [ ] Télécharger titre : pas hang 10–20 s en fin (E10)
- [ ] Cast / sync si activé (smoke)

---

## P6 — Bibliothèque

- [ ] Filtres + ✕ retour accueil biblio
- [ ] Titres chargement OK
- [ ] Téléchargés : Playlists → Albums → Titres ; lecture aléatoire titres only
- [ ] Podcasts / livres = ajoutés only
- [ ] Sheet biblio état rapide

---

## P7 — Téléchargements — R6, R10

- [ ] Titre + album (cas *Pandemonium*) progress non stuck
- [ ] Playlist entière
- [ ] Offline lecture OK
- [ ] Coupure réseau mid-DL → reprise au retour (R6)

---

## P8 — Connexion perdue

- [ ] Nav rapide multi-pages sans faux positifs
- [ ] Couper réseau → recovery
- [ ] Pendant redeploy court → backoff puis OK

---

## P9 — Réglages / logs

- [ ] Pages Crash/Perf/Logs scroll page + journal
- [ ] Layout réglages (espace haut)

---

## P10 — Appui long album

- [ ] Sheet complet ; j’aime tous titres ; pas de duplicata biblio

---

## P11 — Drawer web & multi-appareils (R5, R12)

- [ ] Drawer : playlists ≠ « 0 titres » si `trackCount` > 0 (E1)
- [ ] Playlist créée sur Nothing → visible drawer web sous ~8–20 s
- [ ] Autoplay prefs partagées web ↔ Nothing

---

## P12 — Smoke API prod

- [ ] `node scripts/test/smoke-load-test.mjs prod`
- [ ] Noter E2/E3/E4/E5/E6 encore open si constatés
- [ ] Badge version web cohérent avec `/api/health` (E6)

---

## Alternatives session PROD

| Alt | Action |
|-----|--------|
| Smoke web only | P0 + P1 + 1 play + 1 biblio sur desktop |
| Samsung APK prod | Install prod sur Samsung après Nothing OK |
| Dual parallel | Web prod + Nothing **et** notes divergences vs DEV local |

---

## Fin de session PROD

- [ ] Cocher STATUS → `✅` PROD pour IDs validés
- [ ] **R1–R12** OK sur web prod + Nothing
- [ ] Ouvrir / garder `⬜` pour régressions (E2…E6)
- [ ] Noter version APK + `appVersion` health dans le journal ci-dessus

Si KO majeur : hotfix branche `fix/…` depuis `dev`, rejouer DEV puis promo.
