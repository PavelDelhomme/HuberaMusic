# TESTS_PROD — campagne production (ultra)

À lancer **uniquement** après LOCAL + DEV OK et déploiement VPS réussi.

| Surface | Cible |
|---------|--------|
| Web | https://ytmusic.delhomme.ovh |
| API | même origin `/api/health` |
| Nothing | APK **prod** (`make android-prod`) |
| Samsung | smoke APK prod optionnel (dev reste LAN au quotidien) |
| Serveur | VPS / Portainer / Watchtower / cookies / volumes |

```bash
curl -sS https://ytmusic.delhomme.ovh/api/health | jq .
# version = commit déployé, premiumRequired false, ytdlp true
DEVICE=192.168.1.44:5555 make android-prod
```

---

## Phase 0 — Gate serveur (bloquant)

- [ ] DNS : `dig +short ytmusic.delhomme.ovh` → IP VPS
- [ ] HTTPS valide (pas d’avertissement certificat)
- [ ] `GET /api/health` → `ok`, `ref: prod`, `appEnv: production`
- [ ] `playback.premiumRequired === false` (pas de Premium YouTube requis)
- [ ] `ytdlp: true`
- [ ] Cookies YouTube : `youtubeCookies.configured` (anti-bot) — optionnel mais recommandé
- [ ] Conteneur Portainer **healthy** ; volumes **non** effacés au redeploy
- [ ] Image GHCR = tag attendu (`:latest` / digests récents après push `prod`)
- [ ] WebSockets NPM **ON** ; `wss://…/ws` upgrade OK avec JWT (pas de fail TCP)

Si Phase 0 KO → **stop** ; corriger ops ([`DEPLOY.md`](./DEPLOY.md)) avant UI.

---

## Phase 1 — Auth & comptes (web + Nothing)

- [ ] Login compte autorisé
- [ ] Compte non autorisé / mauvais mdp → erreur claire
- [ ] Inscription fermée si `allowRegister: false`
- [ ] Logout → login
- [ ] Reload / cold start app → session OK
- [ ] Admin (`/admin`) accessible seulement admin
- [ ] Passkey (si configuré) : enregistrement + login

---

## Phase 2 — Web prod (parcours complet)

### 2.1 Accueil & perf perçue
- [ ] Accès rapide → Mixés (covers) → shelves au scroll
- [ ] Pas d’erreur CSP fonts (self-host)
- [ ] Images mixes se peuplent (pas 4 carrés vides > 10 s)

### 2.2 Lecture
- [ ] Play titre / album / playlist / mix
- [ ] Reload mid-track → progression restaurée sans recliquer Play
- [ ] Seek, volume, molette / flèches (si dispo)
- [ ] File : insert À suivre, Déjà joués scrollable
- [ ] Similaires rapides + pagination scroll
- [ ] Radio blanc → rouge ; « Mix à partir de {titre} »
- [ ] Paroles temps réel
- [ ] Stream HTTP 206 sur `/api/stream/:id` (Range)
- [ ] Cast / sync multi-appareils (si `receiveRemoteSync` ON) — smoke

### 2.3 Bibliothèque & pins
- [ ] Titres / J’aime / Albums / Playlists / Mixes
- [ ] Overlay type sur covers
- [ ] Pin → aussi biblio (titre + album)
- [ ] Playlist UI empilée (Lecture / Aléatoire)

### 2.4 Offline web
- [ ] Download titre + progression
- [ ] `/offline` liste après chargement (spinner puis contenu)
- [ ] DevTools Offline → lecture cache

### 2.5 Erreurs web
- [ ] Console : pas de spam WS 4401 une fois loggé
- [ ] 502 / redeploy : backoff WS puis reconnexion
- [ ] Titre indisponible → message, pas page blanche

---

## Phase 3 — Nothing Phone (APK prod)

### 3.1 Install & boot
- [ ] `make android-prod` DEVICE Nothing
- [ ] API affichée / utilisée = `https://ytmusic.delhomme.ovh`
- [ ] Login → Accueil (pas d’écran noir au relaunch)

### 3.2 Lecture & file
- [ ] Play / skip / seek / lockscreen
- [ ] File + À suivre (insert)
- [ ] Similaires préchargés
- [ ] Radio / mix labels
- [ ] Paroles

### 3.3 Biblio & offline
- [ ] Filtre défaut Titres
- [ ] Télécharger avec progress
- [ ] Téléchargés : spinner puis liste
- [ ] Mode avion → pas Mixés ; lecture DL OK
- [ ] Retour online → refresh Accueil OK

### 3.4 Stabilité
- [ ] 15 min lecture continue (pas de crash)
- [ ] Kill + relaunch → file / titre cohérents
- [ ] Logs : `make android-logs DEVICE=…` si anomalie

---

## Phase 4 — Samsung smoke prod (optionnel)

Samsung reste **dev/LAN** au quotidien. Smoke prod seulement pour valider le binaire :

```bash
DEVICE=192.168.1.184:5555 make android-prod   # temporaire
# puis rebasculer en LAN :
DEVICE=192.168.1.184:5555 API_BASE_URL=http://<LAN>:8787 make android-install
```

- [ ] Login prod + 1 play + 1 download
- [ ] Remettre APK **dev** après le smoke

---

## Phase 5 — Base de données & données utilisateur

- [ ] Après redeploy : playlists / pins / likes **toujours là** (volume SQLite)
- [ ] Nouveau pin web → visible Nothing (même compte) après refresh
- [ ] Pas de wipe accidentel (`Remove volumes` jamais coché)
- [ ] Backup : copie volume / fichier DB hors VPS (procédure ops documentée ou snapshot)

---

## Phase 6 — Ops & préproduction

- [ ] Branche `prod` = commit attendu (`git log origin/prod -1`)
- [ ] Workflow GitHub Actions Docker **vert** sur push `prod`
- [ ] Watchtower ou redeploy SSH a bien tiré la **nouvelle** digest (pas « Up 3 days » sans pull)
- [ ] Variables Portainer : `APP_URL`, `JWT_SECRET`, SMTP, `AUTH_*` cohérents
- [ ] SMTP test admin (si mails utilisés)
- [ ] `/api/auth/config` : privateMode / allowRegister attendus
- [ ] Cookies YouTube : test stream après rotation cookies ([`scripts/push-youtube-cookies.sh`](./scripts/push-youtube-cookies.sh))

---

## Phase 7 — Performances & batterie

- [ ] Web : skip ×20 fluide ; pas de fuite onglet (Task Manager mémoire raisonnable)
- [ ] Nothing : session batterie **mixte** (lecture + UI) — `make battery-help` / `scripts/battery-session.sh`
- [ ] Réseau : pas de boucle related/stream en erreur (logcat)
- [ ] Thermique : 20 min lecture casque, pas de thermal throttle extrême

Critères indicatifs (à calibrer) : session mixte ~ quelques %/h ; stress UI bien plus élevé — noter le contexte (USAGE).

---

## Phase 8 — Sécurité & conformité légère

- [ ] CSP : pas d’inline script dangereux ajouté ; fonts self-host
- [ ] Pas de token JWT dans logs publics / URLs partagées
- [ ] Admin non accessible anonymement
- [ ] Health n’expose pas de secrets

---

## Phase 9 — Recette « GO prod »

| Statut | Condition |
|--------|-----------|
| **GO** | Phases 0–3 + 5 OK ; 6–8 sans bloquant |
| **NO-GO** | Health KO, stream systématique fail, wipe data, crash boot Nothing |

Après GO : tag release / note version (`p+x.y.z`) ; garder Samsung en **dev LAN**.

---

## Liens

- Index : [`TESTS.md`](./TESTS.md)
- Local : [`TESTS.LOCAL.md`](./TESTS.LOCAL.md)
- Session : [`TESTS_DEV.md`](./TESTS_DEV.md)
- Deploy : [`DEPLOY.md`](./DEPLOY.md)
- Android : [`docs/ANDROID.md`](./docs/ANDROID.md)
