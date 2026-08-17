# TESTS_DEV — Session DEV (Samsung + web / API local)

**Appareil** : Samsung (`192.168.1.184:5555` ou USB `R5CT7263YJL`) — APK **dev** → API LAN.  
**Web** : `http://localhost:5173` · **API** : `http://127.0.0.1:8787` / `http://<LAN>:8787`.  
**Tracking** : [`STATUS.md`](./STATUS.md) · [`ERRORS.md`](./ERRORS.md) · index [`TESTS.md`](./TESTS.md) (**R1–R22**).

### Journal sessions

| Date | Commit / version | Résultat | Notes |
|------|------------------|----------|-------|
| 2026-08-14 | `c18724a` / `d+1.3.18` | **Samsung DEV OK** | Offline airplane Mix+5 skips ; online 10 skips ; 95 DL ; 0 fatal ; rapport `docs/reports/plm-samsung-tests-2026-08-14.json` |
| 2026-08-12 | `54f6aff` / `d+1.3.17` | **Samsung DEV OK** | APK réinstallé post-E13 ; API LAN ; fix EOS≠réseau + ROOT yt-dlp |
| 2026-08-12 | WIP / `d+1.3.17` | **Samsung DEV OK** | APK `ovh.delhomme.ytmusic.dev` → LAN ; login seed ; Accueil/Biblio ; **Papaoutai PLAYING** ; Compte → passkey visible ; gzip + stream RAM **2–3 ms** après warm ; related audio-first (0 « Officiel ») ; fix ROOT post-réorg (`yt-dlp`/`data/`) |
| 2026-08-12 | (WIP) R1–R12 / E7–E10 | À revalider | À suivre, trackCount, prefetch, UI playlist, drawer, DL ack, passkeys, paroles, membership |
| 2026-08-12 | (branche) sync paroles E8 | À revalider | Lead 0,5 s · align LRCLIB · Trop tôt/tard |
| 2026-08-12 | `a481e3b` / `d+1.3.17` | Smoke API OK ; apps UP ; logcat clean | E1 drawer ; E2 radio lente ; E3 chill vide |

Prérequis :

```bash
make adb-both
make up-full
LAN=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}')
DEVICE=192.168.1.184:5555 API_BASE_URL=http://$LAN:8787 make android-install
node scripts/test/smoke-load-test.mjs local
# login : make adb-login DEVICE=…  (si dispo) ou manuel
```

Règle : un bloc parent n’est **OK** que si **toutes** ses cases enfants sont cochées.  
Parallèle recommandé : web PC **et** Samsung pour chaque sous-catégorie.

---

## D0 — Gate local

- [ ] `make status` : API UP, Vite UP, process locaux UP, Samsung ✅ (Nothing optionnel)
- [ ] `curl -s http://127.0.0.1:8787/api/health` → `ok`, `ref: local`, version attendue
- [ ] Pas de conteneur docker **requis** (message « aucun — normal si stack Node »)
- [ ] `GET /.well-known/assetlinks.json` → prod + `.dev`

---

## D1 — Auth (web + Samsung) — R7 / E7

### Web
- [ ] Connexion compte seed / autorisé
- [ ] Mauvais mdp → erreur claire
- [ ] Inscription (si ouverte) + validation email
- [ ] Logout → login
- [ ] Reload / onglet veille → session OK
- [ ] Passkey : bouton visible ; enroll + login (Bitwarden / plateforme)

### Samsung DEV
- [ ] Login → Accueil
- [ ] **Continuer avec une passkey** toujours visible
- [ ] Compte → Enregistrer passkey → Bitwarden / GPM / empreinte
- [ ] Login passkey après logout
- [ ] Kill app → relance → session conservée
- [ ] API LAN down → message clair (pas freeze)
- [ ] APK en catégorie **Audio / Divertissement** (R11)

---

## D2 — Batterie & usage

- [ ] `make adb-wifi-doctor` (Samsung OK)
- [ ] Smoke usage 10 min lecture + scroll Accueil / Biblio (notes janks)
- [ ] Session calme optionnelle : `make battery-go-calm` ou `DURATION=600 make battery-go`
- [ ] Rapport email batterie reçu / lisible (si SMTP OK)

---

## D3 — Erreurs → email / télémétrie

- [ ] Forcer une erreur visible (stream fail / API stop 5 s) → toast clair
- [ ] Crash / erreur non fatale → entrée dans **Réglages → Logs / Crash**
- [ ] Email d’alerte reçu (admin / outbox) avec **Pré-diagnostic** (famille, cause, actions) + stack
- [ ] 502 / timeout : mail dès la 1ʳᵉ occurrence (pas seulement streak≥2) (E20)
- [ ] Pas de spam email en boucle sur la même erreur (throttle + compteur dans le mail suivant)

---

## D4 — Chargement pages + scroll + progressif (R2, R3)

Pour **chaque** page : ouvrir, scroller, vérifier skeleton → contenu, pas de freeze, pas de « connexion perdue » injustifiée.

### Accueil
- [ ] Accès rapide, mixes (covers), shelves au scroll
- [ ] Playlists / cartes : **trackCount entier** — pas de crash / texte views (R2)
- [ ] Section / chips Podcasts · Albums · Livres (si livré — sinon noter STATUS B2.*)
- [ ] Explorer : images + noms OK (pas carrés vides / libellés chelous)
- [ ] Prefetch : scroll longue shelf → play suivant fluide (R3)

### Artiste
- [ ] Hero + listes albums / singles / playlists
- [ ] Scroll fluide ; retour page = **état scroll conservé** (si livré)
- [ ] Chargement raisonnable (< ~3 s perçu avec cache)

### Album
- [ ] Titres listés ; play album ; progress DL live si téléchargement

### Titres artiste / titres album
- [ ] Pagination / scroll progressif
- [ ] ⋮ actions ; état biblio **rapide**

### File d’attente — R1
- [ ] Auto-remplie depuis lecture
- [ ] Depuis album (Tout lire) + insert À suivre
- [ ] **À suivre** toujours visible ; switch autoplay ne masque pas les suggestions
- [ ] À suivre / related : audio-first (pas clips Officiel en priorité) ; titres propres (R13)
- [ ] Autoplay OFF → fin de file user = **stop** ; Suivant charge la suite
- [ ] Préf autoplay sync `/api/prefs` (web ↔ Samsung)
- [ ] Next / prev stables (pas de crash — STATUS B4.1)
- [ ] Fin de piste complète : pas de skip anticipé (R14 / E12)

### Playlists — R4
- [ ] Liste biblio ; ouvrir playlist (titres)
- [ ] Hero : **Play** + **Aléatoire** + icône **DL** (progress → coche)
- [ ] Menu ⋮ : télécharger tout, file, mix, renommer/supprimer si propriétaire, hors-ligne
- [ ] Ajout playlist / ajout titre
- [ ] Membership « déjà dedans » immédiat dans ⋮ titre (R9 / E9)

### Mixes
- [ ] Mixes user + générés visibles
- [ ] Mix depuis album / artiste / titre
- [ ] Mix Nouveauté fonctionne
- [ ] Mixes « déjà écouté » / artistes suivis

### J’aime / pins
- [ ] J’aime titre ; j’aime album (tous titres) — cœur plein/vide
- [ ] Épingler artiste / titre / album / son → Accès rapide

---

## D5 — Lecteur multimédia (R8, R10)

- [ ] Play / pause / seek
- [ ] Next / prev (répéter 20× sur playlist longue — noter crashes)
- [ ] NP scroll file ; paysage OK
- [ ] Paroles : sync ≈ chant (~0,5 s d’avance) ; pas 1–2 lignes (E8)
- [ ] Paroles : Trop tôt / Trop tard mémorisé par titre
- [ ] Paroles Keny : *Capitale de la rupture* + *Vie d’artiste*
- [ ] Menu ⋮ : déjà dans playlist fiable (E9)
- [ ] Téléchargement titre : pas de spinner bloqué 10–20 s (E10)
- [ ] Media keys / barre OS (web)

---

## D6 — Bibliothèque (focus sprint)

- [ ] Accueil biblio OK
- [ ] Clic filtre Titres / Albums / … → vue filtrée + **✕** revient à l’accueil biblio
- [ ] Même pattern pour tous les chips
- [ ] Titres : affichage / chargement améliorés
- [ ] Mixes biblio = user + générés
- [ ] Téléchargés : Playlists → Albums → Titres ; Tout lire / Aléatoire **seulement** titres
- [ ] Podcasts = uniquement ajoutés
- [ ] Livres audio = uniquement ajoutés
- [ ] Sheet ⋮ : état biblio quasi immédiat
- [ ] Prefetch warm au scroll listes longues (R3)

---

## D7 — Téléchargements (R6, R10)

- [ ] Titre : progress % réel, pas bloqué bleu / hang final
- [ ] Album (ex. *Pandemonium* / Heaven Pierce Her) : progress live (pas stuck 2 %)
- [ ] Playlist entière DL
- [ ] Hors‑ligne : lecture OK
- [ ] Fermer sheet pendant DL → continue
- [ ] Couper réseau mid-DL → reprise au retour (R6)
- [ ] 2ᵉ tap pendant DL = **annuler** + `.part` disparu (R20 / E17)
- [ ] Shuffle playlist **ne** met pas tous les titres en icône DL (E17)

---

## D8 — Connexion perdue / stabilité

- [ ] Naviguer 10 pages rapidement → pas de faux « connexion perdue »
- [ ] Couper Wi‑Fi 5 s → message ; revenir → recovery
- [ ] API restart (`make restart-api`) → clients récupèrent
- [ ] Toast 502 ≠ « plus de connexion / Wi‑Fi » (R17 / E14)

---

## D9 — Réglages / logs UI

- [ ] Crash / Perf / Logs : **page entière** scrollable + journal scrollable
- [ ] Réglages : pas de trou / page trop basse (espace haut OK)

---

## D10 — Appui long album (si livré B6.4)

- [ ] Même sheet que titre
- [ ] Écouter album ; ajouter album biblio ; j’aime tous titres
- [ ] Ajout titres individuels sans duplicata si album déjà en biblio

---

## D11 — Drawer web & multi-appareils (R5, R12)

- [ ] Drawer : compteurs playlists = `trackCount` (pas 0) (E1)
- [ ] Créer / renommer playlist sur Samsung → apparaît sur web sous ~8–20 s (focus + poll)
- [ ] Autoplay prefs partagées web ↔ Samsung (`/api/prefs`)

---

## D12 — Smoke API local (optionnel mais recommandé)

- [ ] `node scripts/test/smoke-load-test.mjs local` → pas de régression majeure
- [ ] Noter E2/E3/E4/E5 si encore open dans [`ERRORS.md`](./ERRORS.md)

---

## D13 — Reprise / shuffle / radio / états on-off (R17–R22) — Samsung DEV

Appareil : **Samsung** USB `R5CT7263YJL` · APK **dev** · API LAN. Nothing non requis.

### Relance app (E15 / R18)
- [ ] Lancer une playlist (≥ 4 titres), pause, **force-stop** l’app, rouvrir → file + mini-lecteur présents
- [ ] Play reprend **le même titre** (pas une erreur connexion)
- [ ] Suivant joue le titre suivant **avec du son** (pas « Chargement des suggestions… » puis silence)
- [ ] Freeze perçu (titre ne lit pas) → fermer / rouvrir → skip OK

### Shuffle biblio titres (E16 / R19)
- [ ] Bibliothèque → Titres → Aléatoire : 1er titre part en &lt; ~2 s (LAN)
- [ ] Suivant ×5 : chaque titre **joue**, pas bloqué « chargement »
- [ ] Si 1er titre lent : retries rapides visibles (pas 20 s de vide)

### Radio artiste (E18 / R21)
- [ ] Page artiste → Radio : 1er titre **immédiat**
- [ ] File se remplit ensuite ; pas d’échec silencieux

### Boutons on/off (E19 / R22)
- [ ] Album ouvert depuis un artiste : biblio **creux** si pas enregistré, **plein rouge** si déjà en biblio
- [ ] Artiste : Biblio + Suivre même logique plein/creux
- [ ] ⋮ titre : LibraryAdd outlined vs check

### DL (E17 / R20)
- [ ] Ne pas voir 20 spinners DL après un shuffle
- [ ] Lancer un DL → retaper = annulation + pas de fichier partiel lisible

---

## Fin de session DEV

- [ ] Notes dans STATUS (IDs concernés → `🧪` ou `✅` LOCAL/DEV)
- [ ] Bugs nouveaux ouverts en lignes STATUS / ERRORS
- [ ] **R1–R22** tous OK sur web + Samsung
- [ ] **Ne pas** merger prod tant que D0–D8 / D11 / D13 critiques KO

Session suivante : promo puis [`TESTS_PROD.md`](./TESTS_PROD.md) sur **Samsung PROD** (Nothing optionnel).
