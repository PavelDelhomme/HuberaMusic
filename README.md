# PLM — Pue La Merde

Client musique multi-plateforme (PLM) : **web**, **API**, **Android Kotlin**, **desktop Electron**.

## Structure

```
api/              Backend Express + SQLite + WS
web/              React / Vite / PWA
mobile-android/   App Android Kotlin (Compose + Media3)
desktop/          Electron
scripts/          seed, android, ops
docs/             Guides (Android, DNS, tests, auth…)
```

## Démarrage rapide

```bash
cp .env.example .env   # comptes de test : SEED_EMAIL / SEED_PASSWORD
make install           # ou npm install
make seed-users        # crée/maj comptes SEED_* du .env
make help
make dev               # API :8787 + Vite :5173
make android           # APK Kotlin sur device ADB (API LAN)
```

- Web / PWA : http://localhost:5173  
- API : http://localhost:8787  
- Prod : https://ytmusic.delhomme.ovh — DNS & install : [`docs/DNS-ET-INSTALL.md`](docs/DNS-ET-INSTALL.md)

## Tests manuels (ordre)

Ne pas tout enchaîner d’un coup. Suivi : [`STATUS.md`](STATUS.md).

1. [`TESTS.LOCAL.md`](TESTS.LOCAL.md) — local web + Samsung (API LAN)  
2. [`TESTS_DEV.md`](TESTS_DEV.md) — **session DEV** (Samsung + web/API local)  
3. Déploiement → [`DEPLOY.md`](DEPLOY.md)  
4. [`TESTS_PROD.md`](TESTS_PROD.md) — **session PROD** (Nothing + web/API prod)  

Index : [`TESTS.md`](TESTS.md) · résumé docs : [`docs/TESTING.md`](docs/TESTING.md) · backlog : [`docs/FEATURES-BACKLOG.md`](docs/FEATURES-BACKLOG.md)

```bash
make adb-both          # Samsung DEV + Nothing PROD
make status-watch      # process locaux + ADB (docker optionnel)
```

| Appareil | Mode | Commande |
|----------|------|----------|
| **Samsung** | Dev / LAN | `DEVICE=192.168.1.184:5555 API_BASE_URL=http://<LAN>:8787 make android-install` |
| **Nothing** | Prod | `DEVICE=192.168.1.44:5555 make android-prod` |

### Desktop

```bash
# Terminal 1
make dev

# Terminal 2
cd desktop && npm install && npm start
```

### Mobile

```bash
make mobile-hint   # guide Android / iPhone
make mobile-qr     # URLs LAN
make adb-wifi-ensure
```

1. Ouvre l’URL LAN ou le domaine prod sur le téléphone  
2. Bannière « Installer » / « Comment installer » (guide selon OS)  
3. Compte app → sync biblio entre appareils (sans pubs)

Détail Android natif : [`docs/ANDROID.md`](docs/ANDROID.md).

## Multi-appareils & Cast

1. Connecte-toi **avec le même compte** sur PC (web/desktop) et mobile  
2. Lance un album sur le PC → la file contient tout l’album  
3. Sur mobile : bouton **Cast** → choisis l’ordinateur → contrôle play/pause/suivant/file/volume  
4. **Mode TV** : ouvre `/tv` sur la télé (navigateur) → apparaît comme appareil « Télé / TV »  
5. **Chromecast** : bouton Cast Chromecast (Chrome) envoie le flux audio  

État synchronisé : titre en cours, file d’attente, position, shuffle, repeat.

## Google OAuth (optionnel)

1. Crée un client OAuth (type Web) dans Google Cloud Console  
2. Origines JS autorisées : `http://localhost:5173`  
3. Mets `GOOGLE_CLIENT_ID=...` dans `.env`  
4. Redémarre le serveur  

Sans Google : inscription email / mot de passe, ou mode invité local.

## Fonctionnalités

| Zone | Détail |
|------|--------|
| Comptes | Google, email, invité device |
| Sync | Bibliothèque SQLite par utilisateur |
| Bibliothèque | Titres aimés, playlists, albums, artistes, historique |
| Import | URL / ID / recherche → titres, albums, artistes, playlists |
| Playlists | Création, édition, ajout, suppression, j’aime playlists YT |
| Offline | Cache IndexedDB + téléchargements appareil + jobs album/playlist |
| Lecture | File, shuffle, repeat, paroles, Media Session (lockscreen / arrière-plan) |
| Clients | Web responsive, PWA mobile, Electron desktop |

## Scripts

```bash
npm run dev          # API + UI
npm run build        # build client
npm run start        # API seule (sert aussi le build client)
make android-prod    # APK → API prod + publish
```
