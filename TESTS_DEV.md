# TESTS_DEV — Session DEV (Samsung + web / API local)

**Appareil** : Samsung (`192.168.1.184:5555` ou USB `R5CT7263YJL`) — APK **dev** → API LAN.  
**Web** : `http://localhost:5173` · **API** : `http://127.0.0.1:8787` / `http://<LAN>:8787`.  
**Tracking** : [`STATUS.md`](./STATUS.md) · erreurs : [`ERRORS.md`](./ERRORS.md).

### Journal sessions

| Date | Commit / version | Résultat | Notes |
|------|------------------|----------|-------|
| 2026-08-12 | `a481e3b` / `d+1.3.17` | Smoke API OK ; apps UP ; logcat clean | E1 drawer 0 titres (fix Layout) ; E2 radio artiste 50–75 s ; E3 reco chill vide — voir ERRORS.md |

Prérequis :

```bash
make adb-both
make up-full
LAN=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}')
DEVICE=192.168.1.184:5555 API_BASE_URL=http://$LAN:8787 make android-install
node scripts/smoke-load-test.mjs local
# login : make adb-login DEVICE=…  (si dispo) ou manuel
```

Règle : un bloc parent n’est **OK** que si **toutes** ses cases enfants sont cochées.  
Parallèle recommandé : web PC **et** Samsung pour chaque sous-catégorie.

---

## D0 — Gate local

- [ ] `make status` : API UP, Vite UP, process locaux UP, Samsung ✅ (Nothing optionnel)
- [ ] `curl -s http://127.0.0.1:8787/api/health` → `ok`, `ref: local`, version attendue
- [ ] Pas de conteneur docker **requis** (message « aucun — normal si stack Node »)

---

## D1 — Auth (web + Samsung)

### Web
- [ ] Connexion compte seed / autorisé
- [ ] Mauvais mdp → erreur claire
- [ ] Inscription (si ouverte) + validation email
- [ ] Logout → login
- [ ] Reload / onglet veille → session OK

### Samsung DEV
- [ ] Login → Accueil
- [ ] Kill app → relance → session conservée
- [ ] API LAN down → message clair (pas freeze)

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
- [ ] Email d’alerte reçu (admin / outbox) avec contexte (device, version, stack)
- [ ] Pas de spam email en boucle sur la même erreur

---

## D4 — Chargement pages + scroll + progressif

Pour **chaque** page : ouvrir, scroller, vérifier skeleton → contenu, pas de freeze, pas de « connexion perdue » injustifiée.

### Accueil
- [ ] Accès rapide, mixes (covers), shelves au scroll
- [ ] Section / chips Podcasts · Albums · Livres (si livré — sinon noter STATUS B2.*)
- [ ] Explorer : images + noms OK (pas carrés vides / libellés chelous)

### Artiste
- [ ] Hero + listes albums / singles / playlists
- [ ] Scroll fluide ; retour page = **état scroll conservé** (si livré)
- [ ] Chargement raisonnable (< ~3 s perçu avec cache)

### Album
- [ ] Titres listés ; play album ; progress DL live si téléchargement

### Titres artiste / titres album
- [ ] Pagination / scroll progressif
- [ ] ⋮ actions ; état biblio **rapide**

### File d’attente
- [ ] Auto-remplie depuis lecture
- [ ] Depuis album (Tout lire) + insert À suivre
- [ ] Next / prev stables (pas de crash — STATUS B4.1)

### Playlists
- [ ] Liste biblio ; ouvrir playlist (titres)
- [ ] **Pas** de boutons Tout lire / Aléatoire sur header playlist (si livré B1.5)
- [ ] Bouton télécharger **toute** la playlist (si livré B1.6)
- [ ] Ajout playlist / ajout titre

### Mixes
- [ ] Mixes user + générés visibles
- [ ] Mix depuis album / artiste / titre
- [ ] Mix Nouveauté fonctionne
- [ ] Mixes « déjà écouté » / artistes suivis

### J’aime / pins
- [ ] J’aime titre ; j’aime album (tous titres) — cœur plein/vide
- [ ] Épingler artiste / titre / album / son → Accès rapide

---

## D5 — Lecteur multimédia

- [ ] Play / pause / seek
- [ ] Next / prev (répéter 20× sur playlist longue — noter crashes)
- [ ] NP scroll file ; paysage OK
- [ ] Paroles si dispo
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

---

## D7 — Téléchargements

- [ ] Titre : progress % réel, pas bloqué bleu
- [ ] Album (ex. *Pandemonium* / Heaven Pierce Her) : progress live (pas stuck 2 %)
- [ ] Playlist entière DL
- [ ] Hors‑ligne : lecture OK
- [ ] Fermer sheet pendant DL → continue

---

## D8 — Connexion perdue / stabilité

- [ ] Naviguer 10 pages rapidement → pas de faux « connexion perdue »
- [ ] Couper Wi‑Fi 5 s → message ; revenir → recovery
- [ ] API restart (`make restart-api`) → clients récupèrent

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

## Fin de session DEV

- [ ] Notes dans STATUS (IDs concernés → `🧪` ou `✅` LOCAL/DEV)
- [ ] Bugs nouveaux ouverts en lignes STATUS
- [ ] **Ne pas** merger prod tant que D0–D8 critiques KO

Session suivante : promo puis [`TESTS_PROD.md`](./TESTS_PROD.md) sur **Nothing**.
