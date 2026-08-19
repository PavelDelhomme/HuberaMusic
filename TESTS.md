# TESTS — carte des campagnes PLM

Index. **Ne pas tout faire d’un coup**. Suivre le pipeline [`STATUS.md`](./STATUS.md).  
Erreurs : [`ERRORS.md`](./ERRORS.md).  
**Sessions dédiées (prod / DEV / local / alt)** : [`docs/TESTS-SESSIONS.md`](./docs/TESTS-SESSIONS.md).

| Étape | Fichier | Device | API | Quand |
|-------|---------|--------|-----|--------|
| **0. Local stack** | [`TESTS.LOCAL.md`](./TESTS.LOCAL.md) | Samsung DEV | LAN `:8787` | Avant toute promo |
| **1. Session DEV** | [`TESTS_DEV.md`](./TESTS_DEV.md) | Samsung DEV + web local | LAN | Features / fixes de la branche |
| **2. Promo** | merge `dev` → `prod` + Pull Portainer | — | VPS | Après DEV OK |
| **3. Session PROD** | [`TESTS_PROD.md`](./TESTS_PROD.md) | Nothing PROD + web prod | `ytmusic.delhomme.ovh` | Après deploy |

Compléments :

| Sujet | Où |
|-------|-----|
| **Erreurs ouvertes / fixed** | [`ERRORS.md`](./ERRORS.md) (`E1`…`E20`) |
| Suivi features / bugs | [`STATUS.md`](./STATUS.md) |
| Backlog produit | [`docs/FEATURES-BACKLOG.md`](./docs/FEATURES-BACKLOG.md) |
| Déploiement | [`DEPLOY.md`](./DEPLOY.md) |
| Android / passkeys | [`docs/ANDROID.md`](./docs/ANDROID.md) |
| Batterie (reporté — voir [`docs/TESTS-SESSIONS.md`](docs/TESTS-SESSIONS.md)) | `make battery-help` · **plus tard** `make battery-go` (Wi‑Fi ADB, débranché) |
| Auth / SMTP | [`docs/AUTH-EMAIL.md`](./docs/AUTH-EMAIL.md) · [`docs/SMTP-MAILY.md`](./docs/SMTP-MAILY.md) |
| Smoke API charge | `node scripts/test/smoke-load-test.mjs both` → `logs/smoke-*.json` |

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

## Correctifs récents à revalider (checklist transversale)

Tout ce qui suit doit être **coché** dans LOCAL puis DEV puis PROD (cases détaillées dans chaque fichier).

| # | Sujet | Attendu | ERRORS |
|---|--------|---------|--------|
| R1 | **À suivre** | Suggestions toujours visibles ; switch = coupe seulement l’auto-avance ; fin de file user → **stop** ; Suivant charge la suite ; préf sync `/api/prefs` multi-appareils | — |
| R2 | **Crash playlist / trackCount** | Accueil / biblio : `trackCount` = **entier** (pas texte « 180K views… ») ; pas de crash Moshi Android | — |
| R3 | **Prefetch listes longues** | Web : warm ~10 s dès qu’une ligne entre dans le viewport ; Android : warm autour du scroll biblio / playlists | — |
| R4 | **UI playlist** | Play + Aléatoire + icône DL (progress → coche) + menu ⋮ (télécharger tout, file, mix, renommer/supprimer si à toi, hors-ligne) | — |
| R5 | **Drawer web sync** | Refresh focus ~8 s + poll 20 s → playlist créée sur mobile apparaît vite sur web | E1 |
| R6 | **DL hors-ligne réseau** | Enfilé ; coupure Wi‑Fi → reprend dès retour réseau | E10 |
| R7 | **Passkeys Android** | Bouton toujours visible ; Bitwarden / GPM / empreinte ; enregistrer puis login passkey (Samsung + Nothing) | E7 |
| R8 | **Paroles sync** | ~0,5 s d’avance max ; Trop tôt / Trop tard ; Keny (*Capitale* / *Vie d’artiste*) | E8 |
| R9 | **Menu ⋮ playlist membership** | « Déjà dans playlist » fiable **immédiatement** (pas faux négatif) | E9 |
| R10 | **DL spinner** | Progress avance ; **pas** bloqué 10–20 s en fin (ack serveur) | E10 |
| R11 | **APK catégorie** | Audio / Divertissement (pas apps génériques) | — |
| R12 | **Drawer compteurs** | Playlists affichent `trackCount` réel (pas « 0 titres ») | E1 |
| R13 | **Audio-first suggestions** | « À suivre » / related : préfère titres audio (ATV) aux clips « Officiel » ; titres nettoyés | E11 |
| R14 | **Pas de saut anticipé** | Le titre va jusqu’à la fin (silence skip conservateur + retry si stream coupe tôt) | E12 |
| R15 | **Gzip JSON + têtes stream** | `Content-Encoding: gzip` sur JSON ; warm → Range 206 `X-PLM-Stream-Cache: ram` ≪ 100 ms ; pas de gzip sur `/api/stream` | — |
| R16 | **Fin de titre ≠ panne réseau** | À ~fin de piste : enchaîne le suivant **sans** toast « connexion perdue / réseau instable » ; mid-piste = reprise flux, pas skip | E13 |
| R17 | **502 / timeout stream ≠ Wi‑Fi** | Toast « serveur audio 502 » (pas connexion) ; mail **Pré-diagnostic** ; OfflineKeeper s’arrête ; `curl -I /api/stream/:id` | E14 E20 |
| R18 | **Reprise file après kill / freeze** | Relancer l’app → mini-lecteur + file visible ; Play reprend ; Suivant **joue** le titre suivant (pas « chargement de suggestion » vide) | E15 |
| R19 | **Shuffle biblio / playlist fluide** | 1er titre &lt; ~2 s perçu (LAN) ; suivants se préparent ; 2–3 retries rapides si 5xx puis skip | E16 |
| R20 | **DL : pas de faux « en cours » + cancel** | Shuffle **ne** met pas tous les titres en DL ; 2ᵉ tap = annuler + `.part` disparu ; Range parallèle | E17 |
| R21 | **Radio artiste** | 1er titre immédiat ; mix s’ajoute ensuite ; pas d’écran bloqué « Radio… » | E18 |
| R22 | **Boutons on/off plein vs creux** | Album (depuis artiste) biblio filled/hollow ; follow artiste ; ⋮ titre LibraryAdd outlined vs check | E19 |
| R23 | **Télémétrie hors-ligne → digest** | Mode avion → provoquer 2–3 erreurs → reconnecter → **un** mail digest (pas N mails, pas de UI) ; fichier local reste petit | E21 |
| R24 | **Play après force-stop** | File visible OK ; **Play** = audio du titre courant ; **Suivant** = audio du suivant (pas silence / pas nouvelles suggestions) | E22 |

---

## Deux sessions principales

### Session DEV (Samsung + web/API local)

Fichier : **[`TESTS_DEV.md`](./TESTS_DEV.md)** — blocs **D0–D12** (auth → fixes récents).

### Session PROD (Nothing + web/API prod)

Fichier : **[`TESTS_PROD.md`](./TESTS_PROD.md)** — blocs **P0–P12** + gate serveur.

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
TESTS.LOCAL  → OK  (incl. R1–R12)
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

1. Auth — login, session, logout, refresh, **passkey**, inscription si ouverte  
2. Accueil — accès rapide, mixes, explorer, podcasts, chips, **trackCount playlists**  
3. Recherche — titres / albums / artistes / playlists  
4. Lecture — play, pause, seek, next/prev, file, **À suivre audio-first**, autoplay, radio/mix, **paroles**, **fin de piste complète**  
5. Bibliothèque — filtres ✕, titres, j’aime, albums, playlists (**UI play/shuffle/DL/⋮**), mixes, DL, podcasts, livres  
6. Hors‑ligne — download progress (**pas stuck**), reprise réseau, lecture sans réseau  
7. Erreurs — email crash/télémétrie, **digest si hors-ligne** (R23), toast connexion perdue  
7b. Relance — force-stop → Play + Suivant **avec audio** (R18 / R24)  
8. Perf — batterie, prefetch scroll, pas de freeze  
9. Ops — health local + prod, version déployée  
10. Multi-appareils — `/api/prefs` autoplay ; drawer sync playlists  

Détail des cases → `TESTS_*.md` / `TESTS.LOCAL.md`.  
IDs produit → `STATUS.md` (`B1.*` …).  
IDs erreurs → `ERRORS.md` (`E1`…`E10`).
