# TESTS — carte des campagnes manuelles PLM

Index des checklists utilisateurs. **Ne pas tout faire d’un coup** : suivre l’ordre ci‑dessous.

| Étape | Fichier | Quand |
|-------|---------|--------|
| **1. Local** | [`TESTS.LOCAL.md`](./TESTS.LOCAL.md) | Avant toute promo : API + web PC + Samsung (API LAN) |
| **2. Dev / session** | [`TESTS_DEV.md`](./TESTS_DEV.md) | Ce que tu dois valider **maintenant** (features récentes) |
| **3. Prod poussée** | [`TESTS_PROD.md`](./TESTS_PROD.md) | Après déploiement VPS + APK prod (Nothing) |

Compléments ops / perf :

| Sujet | Où |
|-------|-----|
| Déploiement VPS / Portainer | [`DEPLOY.md`](./DEPLOY.md) |
| Android (make android / android-prod) | [`docs/ANDROID.md`](./docs/ANDROID.md) |
| Batterie / smoke ADB | `make battery-help` · `scripts/battery-suite.sh` |
| Auth / SMTP | [`docs/AUTH-EMAIL.md`](./docs/AUTH-EMAIL.md) · [`docs/SMTP-MAILY.md`](./docs/SMTP-MAILY.md) |
| DNS / première install | [`docs/DNS-ET-INSTALL.md`](./docs/DNS-ET-INSTALL.md) |
| Backlog produit | [`docs/FEATURES-BACKLOG.md`](./docs/FEATURES-BACKLOG.md) |

## Environnements

| Env | Web | API | Samsung | Nothing |
|-----|-----|-----|---------|---------|
| **Local** | `http://localhost:5173` | `http://192.168.x.x:8787` (LAN) | APK **dev** → API LAN | optionnel |
| **Prod** | `https://ytmusic.delhomme.ovh` | même origin | APK **prod** (smoke) | APK **prod** (cible principale) |

Convention du projet :

- **Samsung** = appareil de **développement** (API locale / LAN).
- **Nothing** = appareil de **production** (API `ytmusic.delhomme.ovh`).

```bash
# Samsung → local
DEVICE=192.168.1.184:5555 API_BASE_URL=http://$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1);exit}}'):8787 make android-install

# Nothing → prod
DEVICE=192.168.1.44:5555 make android-prod
```

## Ordre de validation (règle d’or)

```
TESTS.LOCAL  →  OK
     ↓
TESTS_DEV    →  OK (features de la branche / session)
     ↓
merge → deploy prod (admin-deploy / push prod)
     ↓
TESTS_PROD   →  OK
     ↓
APK prod sur Nothing (+ smoke Samsung prod si besoin)
```

Si une étape échoue : **ne pas déployer** ; corriger, rejouer LOCAL puis DEV.

## Couverture globale (rappel)

Chaque campagne doit au minimum toucher :

1. **Auth** — login, session, logout, refresh
2. **Accueil** — accès rapide, mixes, shelves, scroll
3. **Recherche** — titres / albums / artistes / playlists
4. **Lecture** — play, pause, seek, next/prev, file, autoplay, radio
5. **Bibliothèque** — titres, j’aime, albums, playlists, mixes, téléchargés
6. **Hors‑ligne** — download, lecture sans réseau
7. **Sync multi‑appareils** — même compte (optionnel si sync off)
8. **Erreurs** — API down, stream fail, toast / retry
9. **Perf** — batterie (suite dédiée), pas de freeze UI
10. **Ops** — health, cookies stream (prod), backup DB (prod)

Détail des cases → fichiers `TESTS_*.md` / `TESTS.LOCAL.md`.
