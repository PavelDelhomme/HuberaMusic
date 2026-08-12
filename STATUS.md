# STATUS — suivi PLM (features → tests → PR → prod)

> Source de vérité pour **ce qu’il reste à faire**.  
> Mis à jour à chaque session. Détail produit : [`docs/FEATURES-BACKLOG.md`](./docs/FEATURES-BACKLOG.md).  
> Campagnes : [`TESTS.md`](./TESTS.md).

**Branche courante** : `fix/ux-similar-offline-radio`  
**Version APK / API locale** : `1.3.17` (`d+` / `p+`) · prod live `a481e3b`  
**Dernière MAJ STATUS** : 2026-08-12  
**Erreurs ouvertes** : [`ERRORS.md`](./ERRORS.md)

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
| B2.1 | Section **Podcasts** sur Accueil | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B2.2 | Section / chips navigables Accueil : Albums, Livres audio, Podcasts (style filtres biblio) | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B2.3 | **Explorer** : covers vides + noms chelous → fix images + libellés | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B2.4 | Mixes Accueil : vignettes/noms **rapides** (cache + chargement sélectif premier visible) | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B2.5 | Mix **Nouveauté** ne marche pas → diagnostiquer + corriger | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B2.6 | Mixes : nouveautés **et** mixes basés sur déjà écouté / artistes suivis | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

### B3 — Téléchargements

| ID | Demande | SPEC | CODE | LOCAL | DEV | PR | DEPLOY | PROD |
|----|---------|:----:|:----:|:-----:|:---:|:--:|:------:|:----:|
| B3.1 | Progress DL parfois bloqué / bleu (ex. album *Pandemonium* Heaven Pierce Her) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B3.2 | Progress album page détail : reste à **2 %** — refresh live | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B3.3 | DL beaucoup plus rapide + stockage optimisé (sans perte) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

### B4 — Lecteur / stabilité

| ID | Demande | SPEC | CODE | LOCAL | DEV | PR | DEPLOY | PROD |
|----|---------|:----:|:----:|:-----:|:---:|:--:|:------:|:----:|
| B4.1 | « Titre suivant » crash / fail intermittent | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.2 | Toute erreur app → **email immédiat** (télémétrie / crash) pour traitement | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.3 | Erreurs « connexion perdue » au chargement pages → cause + fix | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.5 | Clic zone vide barre noire lecteur **web** → toggle expand / collapse Now Playing (hors play/pause/next/seek) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.6 | Web : retry « Lecture impossible / nouvel essai auto » **ne boucle pas** ; message clair + bouton après N essais ; détecter 502 stream | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.8 | Android : toast clair si lecture bloquée pendant **appel** (`MODE_IN_CALL`) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.9 | Web refresh biblio lent → playlists light API + cache localStorage | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.10 | Emails télémétrie : streak≥2 = error, throttle 90s, fingerprint par message | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.11 | « À suivre » toujours visible ; auto OFF = stop fin de file ; Suivant charge ; sync préf devices | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.12 | Prefetch listes longues (viewport / scroll) web+Android ~10 s tête | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.13 | Crash `trackCount` string YTM → int (Ambiance Chill etc.) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.14 | Playlist hero : play / shuffle / DL icône+progress + menu ⋮ (rename/delete/mix/offline) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.15 | Sync playlists mobile→web drawer (poll 20s + refresh focus 8s) | ✅ | 🔧 | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B4.16 | Drawer web : compter `trackCount` (pas `tracks.length`) — régression playlists light | ✅ | ✅ | 🧪 | ⬜ | ⬜ | ⬜ | ⬜ |

### B5 — Réglages / logs

| ID | Demande | SPEC | CODE | LOCAL | DEV | PR | DEPLOY | PROD |
|----|---------|:----:|:----:|:-----:|:---:|:--:|:------:|:----:|
| B5.1 | Pages Crash / Perf / Logs : **page entière scrollable** + journal scrollable (zone trop petite) | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B5.2 | Page Réglages trop basse — récupérer l’espace en haut | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

### B6 — Page artiste / albums

| ID | Demande | SPEC | CODE | LOCAL | DEV | PR | DEPLOY | PROD |
|----|---------|:----:|:----:|:-----:|:---:|:--:|:------:|:----:|
| B6.1 | Listes albums / singles / playlists artiste en **cartes** + perf | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B6.2 | Garder l’état scroll / listes quand on quitte / revient page artiste | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B6.3 | Chargement page artiste trop lent → cache + chargement sélectif | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |
| B6.4 | Appui long **album** = même sheet que titre : biblio album, écouter album, j’aime tous les titres (cœur plein/vide), ajout titres individuels sans duplicata biblio | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ | ⬜ |

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

## Prochaine action recommandée

1. Traiter **[`ERRORS.md`](./ERRORS.md)** : **E2** radio artiste lente, **E3**/B2.5 mixes vides, **E4**/B1.1 biblio  
2. Redeploy web pour **E1/B4.16** (compteur drawer) + revalider PROD  
3. Continuer backlog B1.8, B2.*, B5, B6  

**Smoke charge** : `node scripts/test/smoke-load-test.mjs both` (rapport `logs/smoke-*.json`).

---

## Plus tard — toute fin (ne pas faire maintenant)

| ID | Sujet | Notes |
|----|-------|-------|
| Z99 | **Rebrand install / domaines PLM** | L’app s’appelle **PLM** (Pue La Merde) dans l’UI web + mobile. Domaines `plm.delhomme.ovh` et `pue-la-merde.delhomme.ovh` (redirections déjà côté DNS/NPM). À aligner **en toute fin** : prompt d’install PWA (« Installer YTMusic » → PLM), manifests, titres onglet, stores texts, éventuels liens « Get the app », docs restantes encore « YTMusic ». **Ignore pour le sprint UX actuel.** |
