# STATUS — suivi PLM (features → tests → PR → prod)

> Source de vérité pour **ce qu’il reste à faire**.  
> Mis à jour à chaque session. Détail produit : [`docs/FEATURES-BACKLOG.md`](./docs/FEATURES-BACKLOG.md).  
> Campagnes : [`TESTS.md`](./TESTS.md). Erreurs : [`ERRORS.md`](./ERRORS.md).

**Branche courante** : `fix/ota-cross-channel-199`  
**Version** : `1.3.199` · E36 OTA d+/p+ package  
**Dernière MAJ STATUS** : 2026-09-10  
**Erreurs ouvertes** : E33–E35 livrés · **E36** OTA cross-canal (en cours)

---

## Session 2026-09-10 — diag Nothing + fix skip

### Constat (logs Nothing, compte `dev@`, API prod)

| Item | Réalité |
|------|---------|
| Version Nothing | **`p+1.3.184`** (pas à jour — OTA 193–195 jamais installée) |
| Version Samsung | `p+1.3.195` |
| Crash | **Aucun** — `I/crash: UncaughtExceptionHandler installé` = handler boot, pas un crash |
| « skip tick » | = OfflineKeeper **repousse DL opportuniste** (lecture / BatterySaver) — **pas** un skip de titre |
| « transport change » | Wi‑Fi (1) ↔ cellulaire (2) — bruyant, debounce ajouté en 196 |
| Incident 15:18 | `http=503` mid-piste `Ux4nz42lIns` pos≫dur Exo → titre suivant |
| Mail auto | Oui pour `android.player` **error** (5xx dès streak=1) ; throttle 5 min côté serveur ; **pas** de mail pour OfflineKeeper / transport / buffer stuck seul |

### Actions

| ID | Demande | SPEC | CODE | LOCAL | DEV | PR | DEPLOY | PROD |
|----|---------|:----:|:----:|:-----:|:---:|:--:|:------:|:----:|
| E33 | Skip mid-song 503 + durée Exo fausse + buffer-stuck pendant recovery | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🔧 |
| E34 | Durée Exo trop courte vs catalogue → barre / near-end / seek | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| M1 | Mini-lecteur réduit : swipe H = next/prev (comme NP) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| U1 | Mettre à jour Nothing → dernière APK prod (était coincé 184) | ✅ | — | — | — | — | 🔧 | ⬜ |
| U2 | Smoke lecture Samsung (API prod, même compte `dev@`) | ✅ | — | 🔧 | ⬜ | — | — | — |
| 2FA | Web : setup TOTP déjà dans Profil · Android : login accepte code, **pas d’UI enable** dans Compte | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

### 2FA — état

| Surface | État |
|---------|------|
| API `/api/auth/2fa/setup|enable|disable` | ✅ existe |
| Web Profil | ✅ Activer / désactiver 2FA |
| Android login | ✅ champ code si `2FA_REQUIRED` |
| Android Compte | ⬜ pas d’écran enable (à faire si on veut parité) |
| Obligation login | Opt-in user (totp_enabled) — **pas forcé** pour tout le monde |

### Pipeline (rappel)

Local → Samsung → `dev` → Nothing → preprod → prod.  
Gate Samsung `R5CT7263YJL`. Nothing = Asteroids `A059` (wireless ADB). Blackview = ne pas toucher sauf demande.

```bash
# Logs Nothing
DEVICE=adb-00145153K001434-qJCQnH._adb-tls-connect._tcp make android-logs

# Install prod Samsung only
DEVICE=R5CT7263YJL make android-prod
```

---

## Vague récente livrée (prod)

| Ver | Thème | Samsung | Nothing |
|-----|--------|---------|---------|
| 1.3.193 | Lecteur / offline / DL | ✅ | ❌ resté 184 |
| 1.3.194 | Accueil / Compte / BatterySaver | ✅ | ❌ |
| 1.3.195 | Aide / haptic / reprise réseau | ✅ | ❌ |
| **1.3.196** | **Fix E33 skip 503** | 🔧 | 🔧 à installer |

---

## Sprint prioritaire (anciens B* — encore ouverts / partiellement livrés)

Beaucoup d’items B1–B4 ont du **CODE** depuis les vagues 187–195 mais STATUS n’était plus à jour (dernière MAJ 2026-08-17).  
Priorité immédiate = **E33 + MAJ Nothing**, puis reprise backlog Accueil chips / 2FA mobile.

Voir historique détaillé dans git / `VERSION_NOTES.json`.
