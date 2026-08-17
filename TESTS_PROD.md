# TESTS_PROD — Session PROD (Samsung + web / API prod)

À lancer **uniquement** après LOCAL + DEV OK et déploiement VPS réussi (`dev` → `prod` + Pull Portainer).

| Surface | Cible |
|---------|--------|
| Web | https://ytmusic.delhomme.ovh |
| API | même origin `/api/health` |
| Samsung | APK **prod** (`DEVICE=R5CT7263YJL make android-prod`) — cible actuelle (Nothing optionnel) |
| Nothing | APK **prod** si branché (`DEVICE=192.168.1.44:5555 make android-prod`) |
| Serveur | VPS / Portainer / volumes / cookies / **OAuth TV stream** |

```bash
make adb-both
curl -sS https://ytmusic.delhomme.ovh/api/health | jq .
# appVersion / ref doivent matcher le commit déployé
DEVICE=R5CT7263YJL make android-prod
# Nothing si dispo :
# DEVICE=192.168.1.44:5555 make android-prod
# OAuth TV obligatoire si streams 502 (pas de PC allumé) :
# docs/STREAM-VPS-OAUTH.md
node scripts/test/smoke-load-test.mjs prod
```

Tracking : [`STATUS.md`](./STATUS.md) · [`ERRORS.md`](./ERRORS.md) · index [`TESTS.md`](./TESTS.md) (**R1–R12**).

### Journal sessions

| Date | Commit / version | Résultat | Notes |
|------|------------------|----------|-------|
| 2026-08-14 | `p+1.3.18` / Nothing USB | **Nothing PROD OK** | Airplane Papaoutai+5 skips ; online 10 skips ; 19 DL ; 0 fatal ; `docs/reports/plm-nothing-tests-2026-08-14.json` |
| 2026-08-12 | `54f6aff` / `p+1.3.17` | **Samsung + Nothing PROD OK** | Deploy VPS + APK ; Papaoutai PLAYING des deux côtés ; gzip + streamHeadCache UP ; E13 (EOS≠réseau) mergé `prod` |
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

- [ ] Erreur stream / crash → email reçu avec version **prod** + **Pré-diagnostic** (famille 502/timeout/DNS)
- [ ] Hors-ligne puis retour réseau → **un** digest, pas une rafale de mails (E21 / R23)
- [ ] Visible aussi dans admin outbox / logs serveur
- [ ] Pas de boucle mail (throttle + compteur)
- [ ] 1er 502 de session → mail (E20)

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
- [ ] 2ᵉ tap = annuler DL + partiel supprimé (R20)
- [ ] Shuffle ne déclenche pas une file de 40 DL (E17)

---

## P8 — Connexion perdue

- [ ] Nav rapide multi-pages sans faux positifs
- [ ] Couper réseau → recovery
- [ ] Pendant redeploy court → backoff puis OK
- [ ] 502 prod : toast serveur audio, **pas** « Wi‑Fi HS » (R17)

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

## P13 — Reprise / shuffle / radio / 502 (R17–R22) — Samsung PROD

Cible : **Samsung** APK prod → `https://ytmusic.delhomme.ovh`. Nothing optionnel.

### Gate stream (E14)
- [ ] `curl -sI -H 'Range: bytes=0-1' https://ytmusic.delhomme.ovh/api/stream/dQw4w9WgXcQ` → 206
- [ ] Même chose sur un titre **musical** (ex. k1BneeJTDcU) : si **502**, OAuth TV pas validé → lecture prod cassée (pas un bug Samsung)
- [ ] DNS : `getent hosts ytmusic.delhomme.ovh` OK

### Relance (E15 / R18)
- [ ] Playlist ≥ 4 titres → force-stop → rouvrir → file présente
- [ ] Play = audio du **même** titre ; Suivant = audio du suivant (E22 / R24) — pas silence

### Shuffle / radio / biblio (E16–E19)
- [ ] Aléatoire biblio titres : 1er titre part ; suivants jouent
- [ ] Radio artiste : 1er titre immédiat
- [ ] Album depuis artiste : bouton biblio creux/plein distinct
- [ ] DL : 2ᵉ tap annule

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
- [ ] **R1–R22** OK sur web prod + Samsung PROD
- [ ] Ouvrir / garder `⬜` pour régressions (E14 OAuth TV si 502 persistants)
- [ ] Noter version APK + `appVersion` health dans le journal ci-dessus

Si KO majeur : hotfix branche `fix/…` depuis `dev`, rejouer DEV puis promo.
