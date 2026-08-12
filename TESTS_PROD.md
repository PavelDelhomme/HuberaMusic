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
```

Tracking : [`STATUS.md`](./STATUS.md) colonnes `DEPLOY` + `PROD`.

---

## P0 — Gate serveur (bloquant)

- [ ] DNS OK ; HTTPS valide
- [ ] `GET /api/health` → `ok`, `ref: prod` / `appEnv: production`
- [ ] `appVersion` = version attendue (pas une vieille `1.3.9` si on a livré plus récent)
- [ ] `playback.premiumRequired === false` ; `ytdlp: true`
- [ ] Conteneur Portainer **healthy** ; volumes non effacés
- [ ] Image GHCR tag `:prod` / `:latest` digest récent
- [ ] WSS upgrade OK avec JWT

Si P0 KO → **stop** ([`DEPLOY.md`](./DEPLOY.md)).

---

## P1 — Auth (web + Nothing)

- [ ] Login / mauvais mdp / logout / cold start session
- [ ] Inscription selon `allowRegister`
- [ ] Admin seulement pour admin
- [ ] Passkey si configuré

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

## P4 — Pages + scroll + progressif (web prod + Nothing)

Même grille que DEV :

### Accueil
- [ ] Accès rapide, mixes covers, shelves
- [ ] Podcasts / chips Albums·Livres·Podcasts (si déployé)
- [ ] Explorer : images + noms OK

### Artiste / Album / Titres
- [ ] Cartes albums/singles ; état scroll ; perf
- [ ] Album DL progress live

### File
- [ ] Auto + depuis album ; next/prev stables (20×)

### Playlists / Mixes
- [ ] Playlist sans Tout lire/Aléatoire ; DL playlist entière
- [ ] Mixes user + générés ; Mix Nouveauté ; mixes déjà écouté
- [ ] Mix depuis album / artiste / titre

### Pins / j’aime
- [ ] J’aime titre/album ; épingles Accès rapide

---

## P5 — Lecteur

- [ ] Play/pause/seek/next/prev ; NP scroll ; paroles
- [ ] Stream 206 `/api/stream/:id`
- [ ] Cast / sync si activé (smoke)

---

## P6 — Bibliothèque

- [ ] Filtres + ✕ retour accueil biblio
- [ ] Titres chargement OK
- [ ] Téléchargés : Playlists → Albums → Titres ; lecture aléatoire titres only
- [ ] Podcasts / livres = ajoutés only
- [ ] Sheet biblio état rapide

---

## P7 — Téléchargements

- [ ] Titre + album (cas *Pandemonium*) progress non stuck
- [ ] Playlist entière
- [ ] Offline lecture OK

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

## Alternatives session PROD

| Alt | Action |
|-----|--------|
| Smoke web only | P0 + P1 + 1 play + 1 biblio sur desktop |
| Samsung APK prod | Install prod sur Samsung après Nothing OK |
| Dual parallel | Web prod + Nothing **et** notes divergences vs DEV local |

---

## Fin de session PROD

- [ ] Cocher STATUS → `✅` PROD pour IDs validés
- [ ] Ouvrir / garder `⬜` pour régressions
- [ ] Noter version APK + `appVersion` health dans le commit / issue

Si KO majeur : hotfix branche `fix/…` depuis `dev`, rejouer DEV puis promo.
