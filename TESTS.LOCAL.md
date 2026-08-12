# TESTS.LOCAL — validation locale (web + Android DEV)

À faire **avant** Session DEV complète et tout déploiement.  
Suite logique : [`TESTS_DEV.md`](./TESTS_DEV.md) → promo → [`TESTS_PROD.md`](./TESTS_PROD.md).  
Suivi : [`STATUS.md`](./STATUS.md) · [`ERRORS.md`](./ERRORS.md) · index [`TESTS.md`](./TESTS.md) (R1–R12).

Prérequis :

```bash
make adb-both            # Samsung + Nothing (Nothing optionnel ici)
make up-full             # API :8787 + Vite :5173 (Node local, pas docker)
make seed-users          # si besoin
```

| Cible | URL / API |
|-------|-----------|
| Web PC | http://localhost:5173 |
| API | http://127.0.0.1:8787 (PC) · `http://<LAN>:8787` (téléphones) |
| Samsung | APK **dev** → API LAN (`make android-install`) |
| Nothing | réserve **prod** ; smoke local seulement si besoin |

```bash
LAN=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}')
DEVICE=192.168.1.184:5555 API_BASE_URL=http://$LAN:8787 make android-install
```

Coche au fur et à mesure. Si un item échoue → symptôme + appareil + `make android-logs` / `make logs`.

> `make status` doit montrer **process locaux** UP. L’absence de conteneurs `ytmusic*` est **normale** hors `make docker-dev`.

---

## 0. Santé locale

- [ ] `curl -s http://127.0.0.1:8787/api/health` → `ok: true`, `ref: local`
- [ ] Web charge sans erreur console bloquante
- [ ] Login `SEED_EMAIL` / `SEED_PASSWORD` OK (web + Samsung)
- [ ] `GET /.well-known/assetlinks.json` → packages `ovh.delhomme.ytmusic` **et** `.dev`

---

## 1. Auth & session (R7)

### Web
- [ ] Login / logout / rechargement page → toujours connecté
- [ ] Session expire / token refresh (rester connecté après ~onglet en veille)
- [ ] Bouton **Continuer avec une passkey** visible si WebAuthn OK (Bitwarden / gestionnaire)
- [ ] Enregistrer passkey (Profil / offre post-login) → login passkey OK

### Samsung (APK local)
- [ ] Login écran → Accueil
- [ ] Bouton **Continuer avec une passkey** toujours visible (pas caché)
- [ ] Compte → Enregistrer une passkey → feuille Bitwarden / GPM / empreinte
- [ ] Logout → login passkey OK
- [ ] Kill app (récent) → relance → session conservée (pas d’écran noir long)
- [ ] Si API LAN down → message clair / bascule (pas freeze)
- [ ] APK listée en **Audio / Divertissement** (R11)

---

## 2. Accueil (R2)

### Web
- [ ] **Accès rapide** (pins) en premier si épingles
- [ ] **Mixés pour toi** : mosaïques images (pas carrés vides trop longtemps)
- [ ] Shelves : Écouté récemment puis suite au scroll
- [ ] Lecture rapide / play sur mix
- [ ] Playlists / cartes : **nombre de titres = entier** (pas « 180K views - 27 tracks… ») — pas de crash

### Samsung
- [ ] Accès rapide + Mixés + shelves
- [ ] Pull-to-refresh recharge l’accueil
- [ ] Playlists accueil : `trackCount` int → **pas de crash Moshi**
- [ ] **Mode avion** : pas de Mixés ; message hors ligne + accès Téléchargés
- [ ] Retour réseau + refresh Accueil → mixes / images revenus

---

## 3. Recherche

- [ ] Recherche titre → lecture au 1er clic
- [ ] Album / artiste / playlist → fiche détail
- [ ] Suggestions / historique recherche (si présent)
- [ ] Pas de crash clés dupliquées (liste)

*(Web + Samsung)*

---

## 4. Lecteur & file (R1, R3, R8, R9, R10)

### Commun web / mobile
- [ ] Play / pause / next / prev
- [ ] Seek barre (web) / scrub (mobile)
- [ ] Shuffle / repeat (off → all → one)
- [ ] File : Déjà joués / En cours / Ensuite / **À suivre**
- [ ] **À suivre** toujours affiché (suggestions) même si autoplay OFF (R1)
- [ ] Switch autoplay OFF = coupe **seulement** l’auto-avance ; fin de file user → **stop** (pas de suite auto)
- [ ] Autoplay OFF + bouton **Suivant** → charge la suite / suggestions
- [ ] Autoplay ON/OFF synchronisé via **`/api/prefs`** (changer sur web → visible sur Samsung après refresh / sync)
- [ ] Clic un titre **loin** dans À suivre → **insert après courant** (pas de saut qui « consomme » le milieu)
- [ ] Radio / mix depuis un titre : icône **blanche** par défaut, **rouge** si mix actif
- [ ] Label type « Mix à partir de {titre} » (pas « Lecture à partir de Mix »)
- [ ] Similaires : ~10 titres **rapides** au play ; scroll charge la suite
- [ ] Similaires / À suivre : **pas** de priorité aux clips « Officiel / Official Video » quand un titre audio existe (R13)
- [ ] Titres affichés **sans** suffixe « Officiel », « Clip officiel », « Official Video »
- [ ] Prefetch : scroller une longue liste → titres suivants démarrent vite (warm ~10 s viewport web / scroll Android) (R3)
- [ ] Fin de titre : **pas** de saut au suivant alors qu’il reste de l’audio ; pas d’erreur spam (R14)

### Paroles (R8 / E8)
- [ ] Sync ≈ chant avec **~0,5 s d’avance** max (pas 1–2 lignes d’avance)
- [ ] Boutons **Trop tôt / Trop tard** (±0,5 s) mémorisés pour le titre
- [ ] Changer de titre → sync du nouveau titre (pas d’ancien offset collé)
- [ ] *Capitale de la rupture* (Keny Arkana) : pas d’avance nette
- [ ] *Vie d’artiste* (Keny Arkana) : paroles présentes (texte ou timed)

### Menu ⋮ titre (R9 / E9, R10 / E10)
- [ ] « Déjà dans playlist » fiable **immédiatement** (pas faux « pas dedans »)
- [ ] Télécharger un titre : progress avance **sans** rester bloqué ~10–20 s en fin

### Web seul
- [ ] Reload mid-track → barre de **progression** déjà à la bonne place **sans** recliquer Play
- [ ] Swipe / fermeture Now Playing → barre du bas **reste**
- [ ] File scrollable (Déjà joués accessible)
- [ ] Media Session OS (play/pause clavier / notif)
- [ ] Drawer : playlists montrent `trackCount` réel (pas « 0 titres ») (R12 / E1)
- [ ] Créer playlist sur Samsung → drawer web se met à jour (~8–20 s) (R5)

### Samsung seul
- [ ] Lockscreen / notification média
- [ ] Passage app arrière-plan → audio continue
- [ ] Ouverture/fermeture Now Playing → **pas** de rebuffer du titre

---

## 5. Bibliothèque & playlists (R4)

- [ ] Onglet défaut = **Titres** (Android)
- [ ] Filtres : Titres, J’aime, Albums, Playlists, Mixes, Téléchargés…
- [ ] Covers : overlay type (album / playlist / mix) visible (web)
- [ ] Ajouter / retirer titre biblio (sans casser J’aime)
- [ ] Playlist locale : créer, ajouter titre, lire, aléatoire
- [ ] Fiche playlist : **Play** + **Aléatoire** + icône **DL** (progress → coche) (R4)
- [ ] Menu ⋮ playlist : télécharger tout, ajouter à la file, mix, renommer/supprimer si à toi, hors-ligne (R4)
- [ ] Album : retour / artiste / année lisibles (gros)

*(Web + Samsung)*

---

## 6. Accès rapide (pins)

- [ ] Épingler un **titre** → apparaît Accueil + **aussi en biblio**
- [ ] Épingler un **album** → idem biblio albums
- [ ] Désépingler → retire accès rapide (biblio reste)

---

## 7. Téléchargements / hors ligne (R6, R10)

### Web (`/offline` ou menu ⋯)
- [ ] Télécharger un titre → **cercle %** visible (sheet ne se ferme pas trop tôt)
- [ ] Liste « Disponibles hors ligne » après reload (pas « aucun » pendant le chargement)
- [ ] Mode offline navigateur (DevTools) → lecture cache OK

### Samsung
- [ ] ⋯ → Télécharger → icône progression → « Sur l’appareil » **sans hang final 10–20 s**
- [ ] Couper Wi‑Fi pendant DL → file conservée ; retour réseau → **reprise auto** (R6)
- [ ] Biblio → Téléchargés : spinner puis liste (pas vide silencieux)
- [ ] Mode avion → lecture d’un titre téléchargé

---

## 8. Gestes & UI mobile

- [ ] Onglets Accueil / Recherche / Biblio
- [ ] Sheets ⋯ (toutes actions principales cliquables)
- [ ] Swipe / pull Now Playing sans perte de titre
- [ ] Rotation / multi-fenêtre (smoke rapide)

---

## 9. Erreurs & résilience locale

- [ ] Stop API (`kill` :8787) → message « serveur » / retry, pas crash
- [ ] Titre stream impossible → toast / retry, file continue
- [ ] Console web : pas d’erreur CSP fonts ; WS se connecte une fois loggé
- [ ] Toast / message clair si téléphone en appel (MODE_IN_CALL) si testable

---

## 10. Perf locale (léger)

- [ ] Skip rapide 10× → UI réactive, pas de silence long
- [ ] Accueil scroll fluide
- [ ] Optionnel : `make battery-session` court sur Samsung
- [ ] Optionnel : `node scripts/test/smoke-load-test.mjs local`

---

## Fin LOCAL

Quand **tout ce qui est coché** passe sur **web local + Samsung LAN** (surtout **R1–R12**) :

1. Enchaîner [`TESTS_DEV.md`](./TESTS_DEV.md) (focus session).
2. Seulement ensuite déployer prod → [`TESTS_PROD.md`](./TESTS_PROD.md).
3. Installer Nothing en prod : `DEVICE=192.168.1.44:5555 make android-prod`.

Retour index : [`TESTS.md`](./TESTS.md).
