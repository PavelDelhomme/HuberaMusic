# TESTS — carte des campagnes PLM

Index. **Ne pas tout faire d’un coup**. Suivre le pipeline [`STATUS.md`](./STATUS.md).

| Étape | Fichier | Device | API | Quand |
|-------|---------|--------|-----|--------|
| **0. Local stack** | [`TESTS.LOCAL.md`](./TESTS.LOCAL.md) | Samsung DEV | LAN `:8787` | Avant toute promo |
| **1. Session DEV** | [`TESTS_DEV.md`](./TESTS_DEV.md) | Samsung DEV + web local | LAN | Features / fixes de la branche |
| **2. Promo** | merge `dev` → `prod` + Pull Portainer | — | VPS | Après DEV OK |
| **3. Session PROD** | [`TESTS_PROD.md`](./TESTS_PROD.md) | Nothing PROD + web prod | `ytmusic.delhomme.ovh` | Après deploy |

Compléments :

| Sujet | Où |
|-------|-----|
| Suivi features / bugs | [`STATUS.md`](./STATUS.md) |
| Backlog produit | [`docs/FEATURES-BACKLOG.md`](./docs/FEATURES-BACKLOG.md) |
| Déploiement | [`DEPLOY.md`](./DEPLOY.md) |
| Android | [`docs/ANDROID.md`](./docs/ANDROID.md) |
| Batterie | `make battery-help` · `make battery-go` |
| Auth / SMTP | [`docs/AUTH-EMAIL.md`](./docs/AUTH-EMAIL.md) · [`docs/SMTP-MAILY.md`](./docs/SMTP-MAILY.md) |

---

## Environnements & appareils

| Env | Web | API | Samsung | Nothing |
|-----|-----|-----|---------|---------|
| **Local / DEV** | `http://localhost:5173` | `http://<LAN>:8787` | APK **dev** → LAN | optionnel smoke |
| **Prod** | `https://ytmusic.delhomme.ovh` | même origin | smoke APK prod | APK **prod** (cible) |

```bash
make adb-both                 # Samsung + Nothing reconnect
make status / status-watch    # process locaux + ADB attendus (pas besoin docker)

# Samsung → DEV local
LAN=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}')
DEVICE=192.168.1.184:5555 API_BASE_URL=http://$LAN:8787 make android-install

# Nothing → PROD
DEVICE=192.168.1.44:5555 make android-prod
```

> Stack local = **Node** (`make up-full`). Docker optionnel (`make docker-dev`).  
> Si un bug « marche en local mais pas en prod » → vérifier image Portainer / APK version (`/api/health` + `VERSION`).

---

## Deux sessions principales

### Session DEV (Samsung + web/API local)

Fichier : **[`TESTS_DEV.md`](./TESTS_DEV.md)**

Sous-catégories obligatoires :

1. Auth (connexion / inscription / session)
2. Batterie & usage
3. Erreurs → email / télémétrie
4. Chargement pages + scroll + progressif (Accueil, Artiste, Album, Titres, File, Playlists, Mixes…)
5. Lecteur (play/pause/next/prev, file auto / depuis album)
6. Bibliothèque (filtres ✕, mixes, playlists, téléchargés, podcasts, livres)
7. Pins / j’aime / épingles
8. Downloads (progress live, album, playlist entière)
9. Explorer / mixes nouveauté
10. Connexion perdue / stabilité

### Session PROD (Nothing + web/API prod)

Fichier : **[`TESTS_PROD.md`](./TESTS_PROD.md)**

Mêmes sous-catégories + gate serveur (health, cookies, conteneur, image).

---

## Alternatives (sessions croisées)

| Alt | But | Comment |
|-----|-----|---------|
| **A1 Local → smoke prod web** | Vérifier API prod sans APK | Après LOCAL OK : ouvrir web prod, auth, 1 play, 1 biblio |
| **A2 Samsung prod APK** | Smoke APK prod sur device DEV | `make android-prod` sur Samsung **après** session Nothing |
| **A3 Nothing → API LAN** | Rare (debug) | Seulement si besoin ; sinon Nothing = prod only |
| **A4 Dual parallel** | Web local + Samsung DEV **et** web prod + Nothing | Deux checklists en parallèle, noter divergences version |

---

## Ordre de validation

```
make adb-both + make up-full
        ↓
TESTS.LOCAL  → OK
        ↓
TESTS_DEV (Samsung) → OK  (+ cocher STATUS CODE→DEV)
        ↓
PR → merge dev → (optionnel image :dev)
        ↓
merge / promo prod + Pull Portainer
        ↓
TESTS_PROD (Nothing) → OK  (+ cocher STATUS PROD)
```

Si une étape échoue : **ne pas déployer** ; corriger ; rejouer LOCAL puis DEV.

---

## Couverture minimale (rappel)

1. Auth — login, session, logout, refresh, inscription si ouverte  
2. Accueil — accès rapide, mixes, explorer, podcasts, chips  
3. Recherche — titres / albums / artistes / playlists  
4. Lecture — play, pause, seek, next/prev, file, autoplay, radio/mix  
5. Bibliothèque — filtres ✕, titres, j’aime, albums, playlists, mixes, DL, podcasts, livres  
6. Hors‑ligne — download progress, lecture sans réseau  
7. Erreurs — email crash/télémétrie, toast connexion perdue  
8. Perf — batterie, pas de freeze, cache vignettes  
9. Ops — health local + prod, version déployée  

Détail des cases → `TESTS_*.md` / `TESTS.LOCAL.md`.  
IDs produit → `STATUS.md` (`B1.*` …).
