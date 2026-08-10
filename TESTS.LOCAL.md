# TESTS.LOCAL — validation locale (web + Android)

À faire **avant** tout déploiement. Serveur local + appareils physiques (ou émulateur).

Prérequis :

```bash
make adb-wifi-ensure
make ensure-api          # API :8787
# autre terminal :
cd web && npm run dev    # Vite :5173
make seed-users          # si besoin
```

| Cible | URL / API |
|-------|-----------|
| Web PC | http://localhost:5173 |
| API | http://127.0.0.1:8787 (PC) · `http://<LAN>:8787` (téléphones) |
| Samsung | APK **dev** → API LAN (`make android-install`) |
| Nothing | optionnel en local ; sinon réserve pour prod |

```bash
LAN=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}')
DEVICE=192.168.1.184:5555 API_BASE_URL=http://$LAN:8787 make android-install
```

Coche au fur et à mesure. Si un item échoue → note le symptôme + appareil + logs (`make android-logs`).

---

## 0. Santé locale

- [ ] `curl -s http://127.0.0.1:8787/api/health` → `ok: true`, `ref: local`
- [ ] Web charge sans erreur console bloquante
- [ ] Login `SEED_EMAIL` / `SEED_PASSWORD` OK (web + Samsung)

---

## 1. Auth & session

### Web
- [ ] Login / logout / rechargement page → toujours connecté
- [ ] Session expire / token refresh (rester connecté après ~onglet en veille)

### Samsung (APK local)
- [ ] Login écran → Accueil
- [ ] Kill app (récent) → relance → session conservée (pas d’écran noir long)
- [ ] Si API LAN down → message clair / bascule (pas freeze)

---

## 2. Accueil

### Web
- [ ] **Accès rapide** (pins) en premier si épingles
- [ ] **Mixés pour toi** : mosaïques images (pas carrés vides trop longtemps)
- [ ] Shelves : Écouté récemment puis suite au scroll
- [ ] Lecture rapide / play sur mix

### Samsung
- [ ] Accès rapide + Mixés + shelves
- [ ] Pull-to-refresh recharge l’accueil
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

## 4. Lecteur & file

### Commun web / mobile
- [ ] Play / pause / next / prev
- [ ] Seek barre (web) / scrub (mobile)
- [ ] Shuffle / repeat (off → all → one)
- [ ] File : Déjà joués / En cours / Ensuite / À suivre
- [ ] Clic un titre **loin** dans À suivre → **insert après courant** (pas de saut qui « consomme » le milieu)
- [ ] Autoplay ON/OFF
- [ ] Radio / mix depuis un titre : icône **blanche** par défaut, **rouge** si mix actif sur ce titre
- [ ] Label type « Mix à partir de {titre} » (pas « Lecture à partir de Mix »)
- [ ] Similaires : ~10 titres **rapides** au play ; scroll charge la suite
- [ ] Paroles : sync proche du chant (pas d’avance nette)

### Web seul
- [ ] Reload mid-track → barre de **progression** déjà à la bonne place **sans** recliquer Play
- [ ] Swipe / fermeture Now Playing → barre du bas **reste** (ne vide pas la lecture)
- [ ] File scrollable (Déjà joués accessible)
- [ ] Media Session OS (play/pause clavier / notif)

### Samsung seul
- [ ] Lockscreen / notification média
- [ ] Passage app arrière-plan → audio continue
- [ ] Ouverture/fermeture Now Playing → **pas** de rebuffer du titre

---

## 5. Bibliothèque

- [ ] Onglet défaut = **Titres** (Android)
- [ ] Filtres : Titres, J’aime, Albums, Playlists, Mixes, Téléchargés…
- [ ] Covers : overlay type (album / playlist / mix) visible (web)
- [ ] Ajouter / retirer titre biblio (sans casser J’aime)
- [ ] Playlist locale : créer, ajouter titre, lire, aléatoire
- [ ] Fiche playlist : titre + N titres empilés ; Lecture / Aléatoire empilés
- [ ] Album : retour / artiste / année lisibles (gros)

*(Web + Samsung)*

---

## 6. Accès rapide (pins)

- [ ] Épingler un **titre** → apparaît Accueil + **aussi en biblio**
- [ ] Épingler un **album** → idem biblio albums
- [ ] Désépingler → retire accès rapide (biblio reste)

---

## 7. Téléchargements / hors ligne

### Web (`/offline` ou menu ⋯)
- [ ] Télécharger un titre → **cercle %** visible (sheet ne se ferme pas trop tôt)
- [ ] Liste « Disponibles hors ligne » après reload (pas « aucun » pendant le chargement)
- [ ] Mode offline navigateur (DevTools) → lecture cache OK

### Samsung
- [ ] ⋯ → Télécharger → icône progression → « Sur l’appareil »
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

---

## 10. Perf locale (léger)

- [ ] Skip rapide 10× → UI réactive, pas de silence long
- [ ] Accueil scroll fluide
- [ ] Optionnel : `make battery-session` court sur Samsung (pas obligatoire à chaque feature)

---

## Fin LOCAL

Quand **tout ce qui est coché** passe sur **web local + Samsung LAN** :

1. Enchaîner [`TESTS_DEV.md`](./TESTS_DEV.md) (focus session).
2. Seulement ensuite déployer prod → [`TESTS_PROD.md`](./TESTS_PROD.md).
3. Installer Nothing en prod : `DEVICE=192.168.1.44:5555 make android-prod`.

Retour index : [`TESTS.md`](./TESTS.md).
