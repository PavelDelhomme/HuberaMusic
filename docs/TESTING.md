# Guide des tests manuels PLM

Checklists à la **racine** :

| Fichier | Rôle |
|---------|------|
| [`../STATUS.md`](../STATUS.md) | Suivi features / bugs (pipeline SPEC→PROD) |
| [`../ERRORS.md`](../ERRORS.md) | **Erreurs constatées** à résoudre (smoke + manuels) |
| [`../TESTS.md`](../TESTS.md) | Index + alternatives |
| [`../TESTS.LOCAL.md`](../TESTS.LOCAL.md) | Local (web + Samsung LAN) |
| [`../TESTS_DEV.md`](../TESTS_DEV.md) | **Session DEV** Samsung + web/API local |
| [`../TESTS_PROD.md`](../TESTS_PROD.md) | **Session PROD** Nothing + web/API prod |
| [`../docs/FEATURES-BACKLOG.md`](./FEATURES-BACKLOG.md) | Backlog produit UX |

## Smoke API automatisé (charge légère)

```bash
# Local + prod (SEED_EMAIL / SEED_PASSWORD dans .env)
node scripts/smoke-load-test.mjs both
# Rapport JSON → logs/smoke-*.json + logs/smoke-latest.json
# Toute anomalie → noter dans ERRORS.md
```

Couverture : health, login, home, library, search×5 artistes, artist+radio, related×5 titres, streams parallel, warm, playlists `trackCount`, reco.

## Appareils

| Appareil | Rôle | Commande |
|---------|------|----------|
| Samsung | **DEV** → API LAN | `DEVICE=192.168.1.184:5555 API_BASE_URL=http://<LAN>:8787 make android-install` |
| Nothing | **PROD** → VPS | `DEVICE=192.168.1.44:5555 make android-prod` |

```bash
make adb-both          # reconnect rapide dual
make status-watch      # process locaux + ADB (docker optionnel)
make link-home-stream  # streams prod si IP VPS bloquée YT
```

Voir [`ANDROID.md`](./ANDROID.md).

## Perf / batterie

```bash
make battery-help
make adb-both
# sessions : battery-go / battery-suite
```
