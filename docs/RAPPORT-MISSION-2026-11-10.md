# Rapport de mission — Hubera Music (10 nov. 2026)

> Protocole demandé : tests E2E → Docs/Issues → Git → Déploiement → rapport.
> Ce document est la trace persistante du rapport envoyé par e-mail (PDF).

## 0. Résumé

| Élément | Valeur |
|---|---|
| Application | Hubera Music (`YTMusic`) |
| Version livrée | `1.3.414` (image), API interne `1.3.413` |
| Branche | `feat/music-fast-start` → mergée dans `dev` |
| Commits | `112f040`, `8201a5a`, `01a45b1` |
| Issues | #519 (bug), #520 (enhancement) |
| Email PDF | envoyé à `paul@delhomme.ovh`, `dev@delhomme.ovh` |

## 1. Incident de production (découvert + résolu)

**État initial** : conteneur `ytmusic` `Up (unhealthy)`, **26 redémarrages**,
`RangeError: Maximum call stack size exceeded` en boucle dans `stream.ts`,
`/api/health` injoignable (timeout / 404).

**Cause racine** : repli DASH récursif (`downloadTrack` synchrone pendant l'écriture
de la réponse) — corrigé par `9ff0929` (1.3.413), **absent de l'image du 30/10**.

**Correctif déployé** : image `ytmusic:1.3.414` + override compose + recréation
du conteneur, volume `ytmusic_ytmusic_data` (20,6 Go) intact.

**État final** : `healthy`, `restarts=0`, endpoints **200/200/200**, aucun nouveau
`RangeError` (928 lignes de logs normaux depuis le redémarrage).

Détail complet : `docs/INCIDENT-2026-11-10-PROD.md`.

## 2. Étape 1 — Tests E2E multi-profils

| Test | Résultat |
|---|---|
| `scripts/qa/fast-start-e2e.mjs` (Admin + Standard + TTFB + heal) | **8/8** |
| `scripts/qa/admin-aggregates-check.mjs` (user-cases + bugs + permissions) | **4/4** |
| Navigateur Playwright — panneau User cases + Mermaid | **SVG 276 nœuds, 18 apps** |
| Compte Admin `dev@delhomme.ovh` | 200, back-office |
| Compte Standard `bin@delhomme.ovh` | 200, admin refusé **403** |

⚠️ **Non réalisé** : le parcours **ADB mobile** complet (4 appareils détectés :
`EEA9700PRO0014587`, `R5CT7263YJL` + 2 sans fil) — non exécuté dans cette passe.

## 3. Étape 2 — Hubera Docs, e-mails, GitHub Issues

| Source | Résultat |
|---|---|
| Hubera Docs API | 200 (conteneur `Up 4 days`) |
| Création de tâches Docs | **non effectuée** — `DOCS_SERVICE_TOKEN` absent |
| E-mails Himalaya | config TOML **corrigée** (v1 → v2.2.1) ; IMAP filtré sur ce réseau |
| Issue #519 | créée (bug — crash prod) |
| Issue #520 | créée (enhancement — fastStart) |

## 4. Étape 3 — Git & branches

- Branche de travail : `feat/music-fast-start` (issue de `dev`) ✅
- Merge `--no-ff` dans `dev` : `8201a5a` ✅
- Push `origin/dev` : `9d4cc5b..8201a5a` puis `01a45b1` ✅
- **Sécurité** : `hubera-users.json` était **non ignoré** sur un dépôt **public** →
  corrigé (`112f040`) avant tout push. Vérifié : aucun secret dans le diff.
- `gitleaks` en CI : **succès**.

## 5. Étape 4 — CI/CD & déploiement

| Élément | État |
|---|---|
| GitHub Actions `docker.yml` (Build & Push GHCR) | déclenché automatiquement par le push sur `dev` |
| GitHub Actions `gitleaks.yml` | **succès** |
| Conteneur prod | `ytmusic:1.3.414`, healthy, 0 restart |
| Volume | intact |
| `plm.delhomme.ovh/api/health` | **200** |
| `music.hubera.cloud/api/health` | **200** |
| `docs.hubera.cloud/api/health` | **200** |
| Canal OTA (APK) | endpoint actif — APK `p+1.3.413` (vc 10713), **pas de rebuild** dans cette passe |

## 6. Hors périmètre / à faire

1. **Tests ADB mobiles** complets (parcours tactile + logcat).
2. **`DOCS_SERVICE_TOKEN`** à définir pour l'automatisation des tâches Docs.
3. **Rebuild APK** si une nouvelle version mobile est nécessaire.
4. **Bump `VERSION`** : l'image est taguée `1.3.414` mais l'API annonce `1.3.413`.
5. Portée aux autres apps (Fuel, Jobs, Maps) : squelettes `user-cases.json` fournis.
