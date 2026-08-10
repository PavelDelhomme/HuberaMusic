# Guide des tests manuels PLM

Les checklists utilisateurs sont à la **racine** du dépôt :

| Fichier | Rôle |
|---------|------|
| [`../TESTS.md`](../TESTS.md) | Index / ordre des campagnes |
| [`../TESTS.LOCAL.md`](../TESTS.LOCAL.md) | Local (web + Samsung LAN) |
| [`../TESTS_DEV.md`](../TESTS_DEV.md) | À faire maintenant (features session) |
| [`../TESTS_PROD.md`](../TESTS_PROD.md) | Prod poussée (web + VPS + Nothing) |

## Appareils

| Appareil | Rôle | Commande typique |
|---------|------|------------------|
| Samsung | **Dev** → API LAN | `DEVICE=…:5555 API_BASE_URL=http://<LAN>:8787 make android-install` |
| Nothing | **Prod** → VPS | `DEVICE=…:5555 make android-prod` |

Voir aussi [`ANDROID.md`](./ANDROID.md).

## Perf / batterie

```bash
make battery-help
make adb-wifi-ensure
# sessions : scripts/battery-session.sh , scripts/battery-suite.sh
```

Notes UI / perf code : [`UI-MALLEABILITY-PERF.md`](./UI-MALLEABILITY-PERF.md).
