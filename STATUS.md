# STATUS — suivi PLM (features → tests → PR → prod)

> Source de vérité pour **ce qu’il reste à faire**.  
> Mis à jour à chaque session. Détail produit : [`docs/FEATURES-BACKLOG.md`](./docs/FEATURES-BACKLOG.md).  
> Campagnes : [`TESTS.md`](./TESTS.md).

**Branche courante** : `feat/ytm-google-one-tap`  
**Version APK / API locale** : `1.3.20` (`d+` / `p+`) · prod streams musicaux **206** (OAuth TV VPS connecté 17/08)  
**Dernière MAJ STATUS** : 2026-08-17  
**Erreurs ouvertes** : [`ERRORS.md`](./ERRORS.md) (E6 open · **E21** mails hors-ligne · **E22** play après kill · E14/E15–E20 à revalider Samsung)

---

## Pipeline (règle d’or)

Pour **chaque** item ci‑dessous, avancer dans cet ordre et ne jamais sauter une étape :

| Étape | Code | Surface | OK quand |
|-------|------|---------|----------|
| 1. Spec / backlog | `SPEC` | docs | Critères clairs dans STATUS + FEATURES-BACKLOG |
| 2. Fix / feature | `CODE` | api / web / android | Implémenté sur branche `feat/` ou `fix/` |
| 3. Tests locaux | `LOCAL` | web + API LAN + **Samsung DEV** | [`TESTS.LOCAL.md`](./TESTS.LOCAL.md) + cases liées |
| 4. Session DEV | `DEV` | Samsung DEV + web/API local | [`TESTS_DEV.md`](./TESTS_DEV.md) session dédiée |
| 5. PR → `dev` | `PR` | GitHub | Merge vers `dev`, image `:dev` si besoin |
| 6. Deploy prod | `DEPLOY` | VPS / Portainer | Image `:prod` / `:latest` à jour ([`DEPLOY.md`](./DEPLOY.md)) |
| 7. Session PROD | `PROD` | **Nothing PROD** + web/API prod | [`TESTS_PROD.md`](./TESTS_PROD.md) session dédiée |

**Appareils**

| Appareil | Rôle | Commande rapide |
|----------|------|-----------------|
| Samsung `R5CT7263YJL` / `192.168.1.184:5555` | **DEV** (API LAN) | `DEVICE=192.168.1.184:5555 API_BASE_URL=http://<LAN>:8787 make android-install` |
| Nothing `192.168.1.44:5555` | **PROD** | `DEVICE=192.168.1.44:5555 make android-prod` |

```bash
make adb-both          # reconnecte Samsung + Nothing
make status / status-watch
make up-full           # API+web Node local (PAS docker obligatoire)
```

> **Note ops** : `make up` / `up-full` = process Node locaux. Docker (`make docker-dev`) est **optionnel**.  
> Si les correctifs ne sont **pas** mergeés `dev` → `prod` + Pull Portainer, l’APK prod / le VPS restent sur l’ancienne image → les bugs « prod » persistent.

---

## Légende statut item

| Symbole | Sens |
|---------|------|
| `⬜` | Pas commencé |
| `🔧` | En cours (CODE) |
| `🧪` | À tester LOCAL/DEV |
| `📦` | PR / deploy en attente |
| `✅` | Validé PROD (Nothing + web) |
| `⛔` | Bloqué (dépendance / DRM / rate-limit YT) |

Colonnes pipeline : cocher uniquement l’étape atteinte (`SPEC` … `PROD`).

---

## Sprint prioritaire (session 2026-08-12)

Issues signalées après tests **prod** (Nothing) — rien de résolu côté UX utilisateur tant que non déployé.

### B1 — Bibliothèque : UX filtres & listes

| ID | Demande | SPEC | CODE | LOCAL | DEV | PR | DEPLOY | PROD |
|----|---------|:----:|:----:|:-----:|:---:|:--:|:------:|:----:|
| B1.1 | Chargement / affichage titres biblio plus rapide + fiable | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B1.2 | Accueil biblio OK ; clic filtre (Titres/Albums/…) = vue filtrée **avec ✕** pour revenir à l’accueil biblio | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B1.3 | Même pattern ✕ pour **tous** les filtres (Playlists, Mixes, Téléchargés, Podcasts, Livres…) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B1.4 | **Mixes** : mixes user **+** mixes générés (biblio / humeur / habitudes) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B1.5 | Page **playlist** : retirer boutons « Tout lire » / « Aléatoire » (inutiles ici) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B1.6 | Playlist : bouton **Télécharger toute la playlist** | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B1.7 | **Téléchargés** : ordre Playlists DL → Albums DL → Titres DL ; Tout lire / Aléatoire **uniquement** sur titres | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B1.8 | État biblio (ajouter / retirer) dans sheet actions : **instantané** (cache local, pas d’attente API) | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B1.9 | **Podcasts** biblio = uniquement ceux **ajoutés** par l’user | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B1.10 | **Livres audio** biblio = uniquement ajoutés ; le reste → section Accueil | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

### B2 — Accueil

| ID | Demande | SPEC | CODE | LOCAL | DEV | PR | DEPLOY | PROD |
|----|---------|:----:|:----:|:-----:|:---:|:--:|:------:|:----:|
| B2.1 | Section **Podcasts** sur Accueil | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B2.2 | Section / chips navigables Accueil : Albums, Livres audio, Podcasts (style filtres biblio) | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B2.3 | **Explorer** : covers vides + noms chelous → fix images + libellés | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B2.4 | Mixes Accueil : vignettes/noms **rapides** (cache + chargement sélectif premier visible) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B2.5 | Mix **Nouveauté** ne marche pas → diagnostiquer + corriger | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B2.6 | Mixes : nouveautés **et** mixes basés sur déjà écouté / artistes suivis | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

### B3 — Téléchargements

| ID | Demande | SPEC | CODE | LOCAL | DEV | PR | DEPLOY | PROD |
|----|---------|:----:|:----:|:-----:|:---:|:--:|:------:|:----:|
| B3.1 | Progress DL parfois bloqué / bleu (ex. album *Pandemonium* Heaven Pierce Her) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B3.2 | Progress album page détail : reste à **2 %** — refresh live | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B3.3 | DL beaucoup plus rapide + stockage optimisé (sans perte) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B3.4 | Annuler un DL (2ᵉ tap) + supprimer le `.part` ; pas de faux DL sur shuffle | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

### B4 — Lecteur / stabilité

| ID | Demande | SPEC | CODE | LOCAL | DEV | PR | DEPLOY | PROD |
|----|---------|:----:|:----:|:-----:|:---:|:--:|:------:|:----:|
| B4.1 | « Titre suivant » crash / fail intermittent | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.2 | Toute erreur app → email + pré-diag FR (**hors-ligne → digest B4.22**, pas drop) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.3 | Erreurs « connexion perdue » au chargement pages / 502 stream → cause + fix | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.5 | Clic zone vide barre noire lecteur **web** → toggle expand / collapse Now Playing (hors play/pause/next/seek) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.6 | Web : retry « Lecture impossible / nouvel essai auto » **ne boucle pas** ; message clair + bouton après N essais ; détecter 502 stream | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.8 | Android : toast clair si lecture bloquée pendant **appel** (`MODE_IN_CALL`) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.9 | Web refresh biblio lent → playlists light API + cache localStorage | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.10 | Emails télémétrie : 5xx dès streak=1, pré-diag, throttle 90s + compteur | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.11 | « À suivre » toujours visible ; auto OFF = stop fin de file ; Suivant charge ; sync préf devices | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.12 | Prefetch listes longues (viewport / scroll) web+Android ~10 s tête | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.13 | Crash `trackCount` string YTM → int (Ambiance Chill etc.) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.14 | Playlist hero : play / shuffle / DL icône+progress + menu ⋮ (rename/delete/mix/offline) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.15 | Sync playlists mobile→web drawer (poll 20s + refresh focus 8s) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.16 | Drawer web : compter `trackCount` (pas `tracks.length`) — régression playlists light | ✅ | ✅ | 🧪 | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.17 | Restore file après kill sans 502 qui vide Exo ; skip reconstruit la file (E15) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.18 | Shuffle biblio fluide + retries rapides 5xx puis skip (E16) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.19 | Radio artiste : seed immédiat + append mix (E18) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.20 | Boutons booléens plein vs creux (biblio / follow / ⋮) (E19) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.21 | OAuth TV VPS pour tuer les 502 prod (E14) — **ops admin** (google.com/device) | ✅ | ✅ | ✅ | ⬜ | ✅ | ✅ | 🧪 |
| B4.22 | Télémétrie hors-ligne : **file compacte** → **un** digest dès que le réseau revient (E21) | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.23 | Force-stop → rouvrir → file visible mais **Play / Suivant ne lancent pas** l’audio (E22) | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.24 | Inscription prod ouverte → **liaison Google** (compte gratuit, pas Premium) pour signer les streams user (E14) | ✅ | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

### B5 — Réglages / logs

| ID | Demande | SPEC | CODE | LOCAL | DEV | PR | DEPLOY | PROD |
|----|---------|:----:|:----:|:-----:|:---:|:--:|:------:|:----:|
| B5.1 | Pages Crash / Perf / Logs : **page entière scrollable** + journal scrollable (zone trop petite) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B5.2 | Page Réglages trop basse — récupérer l’espace en haut | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

### B6 — Page artiste / albums

| ID | Demande | SPEC | CODE | LOCAL | DEV | PR | DEPLOY | PROD |
|----|---------|:----:|:----:|:-----:|:---:|:--:|:------:|:----:|
| B6.1 | Listes albums / singles / playlists artiste en **cartes** + perf | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B6.2 | Garder l’état scroll / listes quand on quitte / revient page artiste | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B6.3 | Chargement page artiste trop lent → cache + chargement sélectif | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B6.4 | Appui long **album** = même sheet que titre : biblio album, écouter album, j’aime tous les titres (cœur plein/vide), ajout titres individuels sans duplicata biblio | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

### B7 — Cache / perf globale

| ID | Demande | SPEC | CODE | LOCAL | DEV | PR | DEPLOY | PROD |
|----|---------|:----:|:----:|:-----:|:---:|:--:|:------:|:----:|
| B7.1 | Chargements sélectifs + cache vignettes partout (accueil, mixes, listes) | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B7.2 | Radio artiste `/api/artist/:id/radio` trop lente (50–75 s) → preview + fill async | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B7.3 | `POST /api/stream/warm` sous charge trop lent (~16 s) → file + timeout | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

### B8 — Ops / status / devices (infra locale)

| ID | Demande | SPEC | CODE | LOCAL | DEV | PR | DEPLOY | PROD |
|----|---------|:----:|:----:|:-----:|:---:|:--:|:------:|:----:|
| B8.1 | `make status` : process locaux + ADB Samsung/Nothing attendus | ✅ | ✅ | 🧪 | ⬜ | ⬜ | — | — |
| B8.2 | `make adb-both` reconnect rapide dual devices | ✅ | ✅ | 🧪 | ⬜ | ⬜ | — | — |
| B8.3 | Docs STATUS + backlog + sessions tests DEV/PROD | ✅ | ✅ | ⬜ | ⬜ | ⬜ | — | — |
| B8.4 | Promo fixes stream/playlist déjà commités → `dev` puis `prod` + Pull | ✅ | ✅ | ✅ | ⬜ | ✅ | ✅ | 🧪 |
| B8.5 | Badge version web / SW parfois stale vs `/api/health` | ✅ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

---

## Déjà livré (rappel — à revalider PROD)

| Sujet | Note | PROD ? |
|-------|------|--------|
| Dual APK `dev`/`prod` flavors | packages séparés | ⬜ revalider |
| Layout paysage NP / home | | ⬜ |
| Streams anonymes (sans cookies browser) | image VPS peut être ancienne | ⬜ deploy |
| Playlist biblio UUID (0 titres) | fix API + mobile | ⬜ deploy |
| Skip silence via durée/paroles (pas probe Exo) | | ⬜ |
| Emails crash/télémétrie (partiel) | à renforcer → B4.2 | ⬜ |

---

## Sessions de test (voir fichiers)

| Session | Fichier | Device | API |
|---------|---------|--------|-----|
| Local stack | `TESTS.LOCAL.md` | Samsung | LAN `:8787` |
| DEV feature | `TESTS_DEV.md` | Samsung | LAN |
| PROD gate | `TESTS_PROD.md` | Nothing | `ytmusic.delhomme.ovh` |
| Alternative local→prod | `TESTS.md` §Alternatives | mixte | mixte |

Chaque session a des **sous-catégories** : Auth, Batterie, Pages/scroll, Lecteur, Biblio, Mixes, Downloads, Erreurs/emails, Explorer, etc.

---

## Spec courte — items 17/08 (à coder ensuite, pas maintenant)

### B4.22 / E21 — mails d’erreur si l’appareil est hors-ligne

Aujourd’hui `TelemetryReporter` POST tout de suite ; si ça échoue, **l’événement est perdu** (pas de mail).

| Règle | Détail |
|-------|--------|
| Persister | Disque (prefs / petit fichier), **pas** une file de coroutines en RAM |
| Soft | Invisible : pas de toast, pas de notif, pas de job qui se réveille toutes les 30 s |
| Pas la file N×1 | **Interdit** d’enchaîner N envois qui s’attendent. Au retour réseau : **un** flush |
| Budget | Ring **≤ 20** events, fichier **≤ ~64 Ko**, coalescer `kind+trackId+http` → `count++` ; drop oldest |
| Payload flush | Digest compact (ts, kind, message court, ids) + **au plus 1** stack récente — pas 20 dumps AppLog |
| Serveur | Un POST batch → **un** mail « N erreurs cumulées hors-ligne » (pas N mails) |
| Déclencheur | WorkManager `NetworkType.CONNECTED` **unique** (ou ConnectivityManager one-shot), pas une chaîne |

### B4.23 / E22 — kill app → Play ne part pas

La file **est** déjà dans `LocalPlaybackStore` (mini-lecteur + titres OK). Le trou : après force-stop, Play (titre courant) **et** Suivant **ne lancent pas** l’audio. À tester Samsung DEV puis PROD (R18 / D13 / P13). Piste : restore `autoplay=false` sans MediaItems Exo / `Holder.queue` vs UI.

### B4.24 — inscription prod + Google (pas Premium)

Quand `AUTH_ALLOW_REGISTER=1` sur le **conteneur prod** : après création de compte PLM, demander la **liaison Google** (OAuth appareil, compte **gratuit**) pour que YouTube ne voie pas les streams comme anonymes depuis l’IP VPS. Voir [`docs/STREAM-VPS-OAUTH.md`](./docs/STREAM-VPS-OAUTH.md) §Inscription. **Ce n’est pas YouTube Premium.**

---

## Prochaine action recommandée

1. **B4.23 / E22** — repro + fix Play après force-stop (Samsung)  
2. **B4.22 / E21** — file télémétrie compacte + mail digest  
3. **B4.24** — onboarding liaison Google si inscription prod ouverte  
4. Revalider **E14** lecture musicale Samsung PROD (OAuth VPS déjà `connected`, curl 206)  

**Smoke charge** : `node scripts/test/smoke-load-test.mjs both` (rapport `logs/smoke-*.json`).

---

## Plus tard — toute fin (ne pas faire maintenant)

| ID | Sujet | Notes |
|----|-------|-------|
| Z99 | **Rebrand install / domaines PLM** | UI web + mobile + PWA → **PLM** (fait en 1.3.34 : manifests, titres, thèmes Android `Theme.PLM`). Domaines `plm.delhomme.ovh` / redirect OK. **Reste** : renommer repo Git `YTMusic` quand prod stable. Voir [`docs/PLM.md`](docs/PLM.md). |
