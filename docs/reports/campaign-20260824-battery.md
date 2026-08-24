# Campagne tests 2026-08-24 (18h21–)

## Appareils (ADB Wi‑Fi OK)

| Appareil | Transport | APK prod | Charge | Rôle campagne |
|----------|-----------|----------|--------|----------------|
| Samsung S21 FE | `192.168.1.184:5555` | p+1.3.68 | **débranché** ~76 % | Endurance batterie/perf **20 min** (en cours) |
| Nothing Phone 3a | `192.168.1.44:40969` | p+1.3.68 | **débranché** 100 % | Endurance batterie/perf **20 min** (en cours, décalé 15 s) |
| Blackview BV9700 | `192.168.1.12:5555` | p+1.3.68 | USB (branché) | Smoke fonctionnel uniquement |

Scripts : `scripts/battery/multi-device-campaign.sh` · `scripts/battery/parallel-endurance.sh` · `scripts/android/prod-endurance-1h.py`

---

## Blackview — smoke fonctionnel

Rapport : `docs/reports/dual-smoke-20260824-182200/report.json`

| Check | Résultat |
|-------|----------|
| En ligne / APK | OK |
| Démarrage lecture | FAIL (état ERROR au 1er play — faux négatif possible) |
| Progression 4 titres | OK (pos ~90 s) |
| early_end | OK (delta=0) |

**Action** : état ERROR Exo alors que la position avance → assouplir le critère `playback:active` dans le smoke.

---

## Samsung — pilote 3 min (validé)

Rapport : `logs/endurance/20260824-182842-192_168_1_184_5555/report.json`

| Métrique | Valeur |
|----------|--------|
| Lecture | PLAYING stable |
| PSS pic / moy | **187 MB / 181 MB** |
| CPU (top) | ~25–43 % en lecture |
| Transitions autoplay | 1 |
| Exo errors | 0 |
| ok | **true** |

---

## Nothing — pilote 5 min

Rapport : `logs/endurance/20260824-183557-192_168_1_44_40969/report.json`

| Métrique | Valeur |
|----------|--------|
| Lecture | **PAUSED** bloqué (pos figée 200732) |
| PSS pic / moy | **~285 MB / ~210 MB** |
| Transitions | 0 |
| ok | **false** |

**Action** : `ensure_playing()` renforcé (reprise auto si PAUSED) — session 20 min relancée.

---

## Sessions 20 min en cours

Logs : `logs/campaigns/20260824-184200-night/{samsung,nothing}.log`

Fin attendue ~**19:02** (UTC+2). Rapports JSON : `logs/endurance/20260824-1842*-*/report.json`

---

## Premières décisions (provisoires)

| Signal | Piste d’amélioration |
|--------|----------------------|
| PSS Nothing > Samsung en pause | Vérifier fuites / cache Exo si PAUSED prolongé ; merge #149 stream |
| Samsung ~180 MB PSS en lecture | Acceptable ; surveiller pic > 350 MB |
| Blackview ERROR + pos OK | Parser media_session AOSP 9 ; ne pas alarmer sur ERROR seul |
| Nothing reste PAUSED | Auto-resume dans endurance + test manuel bouton play |
| Offline / batterie longue | Prochaine phase : `battery-suite.sh` 45 min écran OFF après merge prod |

---

## Suite Nothing (hors-ligne)

Quand le téléphone est chargé **et** débranché : script ADB coupure Wi‑Fi/mobile temporaire + `android-battery-offline-check.sh` (pas lancé aujourd’hui — branché en charge).
