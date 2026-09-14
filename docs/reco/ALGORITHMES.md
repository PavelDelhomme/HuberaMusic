# Algorithmes de recommandation PLM

**Date :** 2026-09-14  
**Code :** `api/src/reco/*`, `api/src/library/prefs.ts`, `api/src/library/shuffleHeads.ts`, `api/src/media/tasteWarmScheduler.ts`

Ce document explique **ce qu’on utilise**, **comment ça marche**, et **où ça vit dans le code** — Accueil, radios, « À suivre », recherche, aléatoire biblio, warm.

---

## 1. Objectif produit

PLM ne copie pas un seul modèle ML lourd. On combine :

1. **Contenu** — proximité tags / embedding avec le titre seed  
2. **Séquence d’écoute** — skips, completes, récence  
3. **Contexte** — heure, week-end, moods / genres préférés  
4. **Exploration (bandit)** — découverte vs confort  
5. **Satisfaction** — feedback explicite / likes  

Le cœur commun est **`hybridRank`** (`api/src/reco/reco.ts`).

---

## 2. Schéma de données (préférences & signaux)

Créé par `ensureRecoSchema()` dans `prefs.ts` :

| Table | Signal |
|-------|--------|
| `user_prefs` | genres, moods, moments, `discovery_bias`, autoplay |
| `listen_events` | `start` / `progress` / `complete` / `skip` + heure / week-end |
| `search_history` | requêtes + clics |
| `artist_follows` | artistes suivis |
| `pins` | Accès rapide |
| `reco_feedback` | like / dislike contexte |
| `reco_weights` | poids par **mode** (radio, style, discover, focus) |

### Poids par défaut (`reco_weights`)

| Mode | content | seq | ctx | bandit | satisf |
|------|---------|-----|-----|--------|--------|
| radio | 0.28 | 0.32 | 0.18 | 0.14 | 0.08 |
| style | 0.20 | 0.38 | 0.14 | 0.20 | 0.08 |
| discover | 0.18 | 0.20 | 0.12 | 0.38 | 0.12 |
| focus | 0.40 | 0.30 | 0.20 | 0.05 | 0.05 |

En pratique, pour `radio` / `style` / `album-style`, `hybridRank` **remonte encore le poids contenu** (min ~0.42) pour coller au seed.

---

## 3. `hybridRank` — le moteur

**Signature :** `hybridRank({ userId, candidates, seed?, mode?, softExcludePlayed?, targetTags? })`

### 3.1 Entrées

- **candidates** : pool de `Track` (related YT, search, biblio, radio category…)  
- **seed** : titre en cours (optionnel)  
- **mode** : `radio` | `style` | `discover` | `album-style` | `artist-radio` | …  
- **targetTags** : tags genre (prefs + catégorie mix)

### 3.2 Filtres durs (avant score)

1. ID YouTube valide (11 chars)  
2. Pas le seed lui-même  
3. Anti « remix spam » du seed  
4. En mode radio/style : exclusion des titres **joués < 24 h** (history + events)  
5. Exclusion **overplayed** (top écoutés / ≥ 8 listens dans la fenêtre events)  
6. Uniquement hits **musique jouable** (pas podcasts / fiches) en modes radio/style  

### 3.3 Signaux scorés (simplifié)

Pour chaque candidat restant :

| Signal | Idée | Sources |
|--------|------|---------|
| **s_content** | Proximité seed / tags cibles | `styleTags`, `scoreContentEmbedding` (`trackFeatures.ts`) |
| **s_seq** | Comportement écoute | completes ↑, skips ↓, listenCounts |
| **s_ctx** | Heure / week-end / moods | `user_prefs`, horodatage event |
| **s_bandit** | Exploration | `discovery_bias`, mode discover |
| **s_satisf** | Feedback / likes | `reco_feedback`, liked set |

**Score ≈**  
`w_content·s1 + w_seq·s2 + w_ctx·s3 + w_bandit·s4 + w_satisf·s5`  
(+ boosts likes / taste artists / tags / pénalité récence < 6 h)

### 3.4 `rerank` anti-mono-artiste

Après le tri par score, un **rerank** évite une file de 10 titres du même artiste d’affilée (diversité artiste).

### 3.5 Soft exclude

Pour les mixes longs (~200 titres), `softExcludePlayed=true` : on **pénalise** les déjà joués au lieu de les exclure (sinon la file s’épuise).

---

## 4. Accueil — `homeReco(userId)`

Construit les **shelves** de l’écran Accueil :

| Shelf typique | Origine |
|---------------|---------|
| Épinglé | `pins` |
| Récent | history |
| Playlists / albums | biblio |
| Favoris oubliés | likes peu rejoués |
| Plus écoutés | stats listen |
| Shelves dynamiques | search YT + `hybridRank` (genres, moods, follows, recherches) |

Jobs **parallèles** pour ne pas bloquer le cold start ; l’API expose aussi `/api/home/more` pour allonger.

**Routes :** `GET /api/home`, `GET /api/reco/home`

---

## 5. Radios / mixes — `radioForUser`

1. Choisit une **catégorie** dans `RADIO_CATEGORIES` (focus, chill, workout, …) — titre + requêtes / tags associés.  
2. Construit un **pool** (search YT + related éventuels).  
3. Passe le pool dans **`hybridRank`** (mode radio / focus selon catégorie).  
4. Met en cache via **`mixCache`**.  
5. `warmCategoryMixes` préchauffe les premières catégories en fond.

**Routes :** `GET /api/reco/radio/:cat`, `GET /api/reco/radios`, explore.

---

## 6. « À suivre » / similaires — `similarForUser`

Quand un titre joue et qu’il faut remplir la suite autoplay :

1. Récupère **related / upNext** YouTube (et variantes).  
2. Dédupe (id + fingerprint titre|artiste).  
3. Rank avec **`hybridRank`** (seed = titre courant, mode style/radio).  
4. Version **`similarForUserFast`** : chemin plus court pour l’UI (latence).

Variantes :

- `albumSimilarForUser` — radio autour d’un album  
- `artistSimilarForUser` — radio artiste  

**Routes :** `GET /api/reco/similar/:id` (+ chemins autoplay côté client)

---

## 7. Recherche — `searchRank.ts` + `suggestSearch`

| Fonction | Rôle |
|----------|------|
| `scoreSearchItem` | Score un hit search (titre, artiste, type, junk filters) |
| `rankByQuery` | Ordonne la liste pour une requête |
| `personalizeBoost` | Boost selon prefs / historique / `searchHits` |
| `suggestSearch` | Suggestions YT réordonnées avec prefs |

Filtres : priorise musique jouable, pénalise Topic / live / covers selon règles, évite le bruit.

---

## 8. Features contenu — `trackFeatures.ts`

- Construit un **vecteur** à partir de tags + énergie approximative.  
- **Similarité cosine** entre seed et candidat → alimente `s_content`.  
- Pas de réseau de neurones externe : features locales / dérivées des métadonnées YT.

---

## 9. Aléatoire bibliothèque — `getShuffleHeads`

Ce n’est **pas** un random uniforme naïf sur 14k titres :

1. Slot rotatif **~30 min** côté serveur.  
2. ~**100 IDs** pré-sélectionnés (biais likes ~20 %).  
3. Warm **stream + disk** sur le lot.  
4. Le client Android (`LibraryHeadPrefetcher`) tire ce lot et précharge des têtes Exo.

**Route :** `GET /api/library/shuffle-heads` (+ refresh)

But : quand l’utilisateur tape Aléatoire, les **premiers titres** sont déjà chauds (moins de « chargement long »).

---

## 10. Taste warm — `tasteWarmScheduler.ts`

Pas un ranking UI, mais un **prefetch prédictif** :

- À intervalle (~12 min) + au boot (+45 s)  
- Sélectionne des IDs selon history / likes / library  
- `enqueueStreamWarm` / `enqueueDiskWarm`  
- Respecte concurrence yt-dlp / budgets  

But : les titres « probables » sont en cache disque/format avant le play.

---

## 11. Feedback — `POST /api/reco/feedback`

L’utilisateur (ou le client) envoie un verdict (like/dislike contexte). Stocké dans `reco_feedback`, relu dans `hybridRank` (signal satisfaction).

---

## 12. Chaîne complète (exemple : skip → suite)

```
Titre en cours (seed)
    │
    ├─► similarForUser / autoplay fetch
    │       related YT + hybridRank(seed, mode style/radio)
    │
    ├─► Client enqueue file « À suivre »
    │
    └─► StreamPrefetcher / warm serveur sur next #0–#2
            │
            └─► Si stall → telemetry → streamHeal → re-warm
                    │
                    └─► Digest 12h30 (mail) si problèmes récurrents
```

---

## 13. Ce qui n’est **pas** utilisé (volontairement)

- Pas de collaborative filtering multi-users massif (instance perso)  
- Pas de modèle embeddings cloud type « neural CF »  
- Pas de re-rank GPU  

On reste **explicable**, **débogable**, et **aligné** sur une seule bibliothèque perso + signaux YT.

---

## 14. Fichiers à ouvrir pour modifier un comportement

| Changement | Fichier |
|------------|---------|
| Formule de score | `reco.ts` → `hybridRank` |
| Poids par mode | `prefs.ts` → `reco_weights` / `getWeights` |
| Shelves Accueil | `reco.ts` → `homeReco` |
| Catégories radio | `reco.ts` → `RADIO_CATEGORIES` |
| Qualité search | `searchRank.ts` |
| Similarité tags | `trackFeatures.ts` |
| Aléatoire chaud | `shuffleHeads.ts` |
| Prefetch goûts | `tasteWarmScheduler.ts` |

---

## 15. Lien backend général

Architecture serveur, routes, télémétrie, schedulers :  
**[`docs/backend/ARCHITECTURE.md`](../backend/ARCHITECTURE.md)**
