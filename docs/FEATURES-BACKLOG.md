# Backlog fonctionnalités UX — menus & lecteur (style YouTube Music)

> Document de référence pour ce qu’on **doit** livrer.  
> Mis à jour au fil des itérations. Cocher / décocher au fur et à mesure.

---

## Vision menus d’actions (web + mobile)

Menu unique (bottom sheet) pour un **titre**, une **playlist**, un **album**, un **artiste**, un **mix / radio**.

### En-tête

| Élément | Comportement |
|--------|----------------|
| Cover (gauche) | Petite vignette |
| Titre | Une ou deux lignes |
| Artiste + durée | Sous le titre, sur une ligne |
| Cœur (j’aime) | Icône seule, à gauche du ✕ — **pas** de libellé « J’aime » |
| Fermer (✕) | Tout à droite |

### Rangée de 3 boutons rapides (icône + libellé dessous)

1. **Lire ensuite** — insère juste après le titre en cours  
2. **Playlist** — « Enregistrer dans une playlist »  
3. **Partager**

### Liste d’actions (dessous)

Ordre cible :

1. **Démarrer le mix** / radio à partir de ce titre (similaires + découverte)  
2. Radio proche de l’artiste / radio album / radio artiste (selon dispo)  
3. **Ajouter à la file d’attente** — en **fin** de file prévue (pas « lire ensuite »)  
   - Si déjà dans la file (et pas le titre en cours) → **Retirer de la file d’attente** à la place  
4. **Télécharger**  
5. **Supprimer de la playlist** — uniquement si on est dans le contexte d’une playlist  
6. **Accéder à l’album**  
7. **Accéder à la page de l’artiste**  
8. **Épingler dans Accès rapide** / Retirer  
9. Enregistrer dans la bibliothèque (album / artiste / playlist selon type)  
10. **Mise en veille** — 5 / 15 / 30 / 45 / 60 min / Fin de la chanson — ✅ mobile 

### Déclencheurs

| Surface | Déclencheur |
|---------|-------------|
| Lignes de titres (listes, file, recherche…) | Bouton **⋮** |
| Cartes Accueil / Explorer (titre, album, playlist, artiste) | **⋮** + **clic droit** (web) |
| Lecteur plein écran mobile | **⋮** en haut à droite |
| Accueil mobile (cartes / lignes) | **Appui long** → même menu (variante collection : aléatoire, biblio, télécharger, playlist, épingler…) |

---

## Lecteur plein écran mobile (Now Playing)

Style YouTube Music :

- **Haut gauche** : chevron bas (replier) — ✅  
- **Haut droite** : Cast + **⋮** (mix / radio dans le menu, plus sous les contrôles) — ✅  
- Contraste icônes / textes clairs — ✅  
- Sous titre : j’aime · paroles · playlist · DL · mix — ✅ (`NowPlayingChrome.secondaryActions`)  
- Transport : aléatoire · précédent (tap=début / double=précédent) · play · suivant · boucle off/all/one — ✅  
- Section file : titre source + enregistrer file → playlist · pull-up → mini barre multimédia — ✅  
- File : cover · titre · artiste · durée · drag handle reorder · long-press → menu ⋮ — ✅  
- Config malléable : `NowPlayingChrome.kt` + `docs/UI-MALLEABILITY-PERF.md`  

---

## Perf / énergie (plus tard)

Voir `docs/UI-MALLEABILITY-PERF.md` — tracer conso web / mobile / serveur.

## Accueil — Favoris à redécouvrir

Style YouTube Music (« Forgotten favorites ») :

- Rayon Accueil **Favoris à redécouvrir** (~8 items) — ✅ API `getForgottenFavorites` → `homeReco`
- Sources : titres **J’aime** matures non réécoutés récemment + anciens gros hits (`play_count`) + albums biblio anciens
- Exclusion si écoute dans les **14** derniers jours ; rotation stable **par jour**
- Affiché dès ≥ 2 candidats (web + mobile via `/api/home`)
- Distinct de la radio **Radio J’aime** (`liked-radio`) = mix seedé sur tops écoutés

## Intégration moteur reco (clients)

- Backend `hybridRank` + endpoints `/api/reco/*` — ✅ déjà prêts
- Web : home/explore/radios/listen/prefs/pins — ✅ ; feedback `good|bad` — ✅ ; Suivre artiste — ✅ ; « En rapport » — ✅
- Mobile : listen start/progress/complete/skip — ✅ ; radios chips Accueil — ✅ ; pins sync `/api/pins` — ✅ ; feedback like/dislike — ✅ ; Mix « En rapport » — ✅

---

## Accès rapide

- **Pas** d’onglet « Rapide » dans la nav bas mobile  
- Encart **Accès rapide** en haut de l’**Accueil** (épingles) — ✅ en partie livré  
- Épingler / retirer depuis le menu d’actions partout  

## Chrome mobile (en-têtes Accueil / Biblio)

| Zone | Attendu | Statut |
|------|---------|--------|
| Accueil | Logo + « Music » à gauche · avatar compte à droite → sheet compte | ✅ |
| Biblio | Titre « Bibliothèque » · avatar compte à droite (reco, passkey, logout, historique) | ✅ |
| Sheet compte | Historique, téléchargements, reco, passkey, déconnexion | ✅ |
| Biblio filtres | Chips horizontaux (Téléchargés, Playlists, Titres, Albums…) masquables | ✅ |
| Biblio défaut | Filtre **Ajouts** = Enregistré récemment | ✅ |
| Biblio Titres | Liste A–Z + ⋮ (contenu enregistré en biblio) | ✅ |
| Menu actions | États « Dans la biblio » / « Sur l'appareil », Mix, icônes distinctes | ✅ |
| Nav album/artiste | Replie le Now Playing (mini-bar), lecture continue | ✅ |
| Téléchargements | Écran / gestion offline | ⏳ |

---

## Recherche

| Plateforme | Attendu | Statut |
|------------|---------|--------|
| Web | Échap ferme suggestions + vide le champ ; bouton ✕ clear | ✅ |
| Web / API | Ranking titre/artiste + perso | ✅ (améliorable) |
| Mobile | Filtres Tout / Titres / Artistes… | ✅ |

---

## Clavier / média (web)

| Attendu | Statut |
|---------|--------|
| Media Session OS (play/pause/next/prev) hors page lecteur | ✅ |
| Espace / K, Shift+N/P, J/L, flèches | ✅ |

---

## Checklist d’implémentation

### Web

- [x] Bottom sheet d’actions unifié (header + 3 boutons + liste)  
- [x] Remplacer le dropdown TrackRow par ce sheet  
- [x] Cartes MediaCard : ⋮ + clic droit → sheet  
- [x] Contexte playlist : « Supprimer de la playlist » (API branchée, UI prête via opts)  
- [x] Contexte file : ajouter fin vs retirer  
- [x] Mise en veille (timer) — mobile  

### Mobile

- [x] Refonte TrackActionsSheet (header cœur+✕, 3 boutons, liste ordonnée)  
- [x] Now Playing : chevron / Cast / ⋮  
- [x] Appui long Accueil → menu (titres / cartes)  
- [x] Chrome Accueil / Biblio (logo Music, avatar, sheet compte, historique)  
- [x] Menu ⋮ aligné YTM + mise en veille + supprimer playlist  
- [x] Now Playing : contraste clair (chevron / cast / ⋮ / contrôles)  
- [ ] Variante menu collection dédiée (aléatoire, biblio, DL…)  
- [ ] Téléchargements (écran dédié)  

### Transversal

- [x] Harmoniser libellés FR (Lire ensuite ≠ Ajouter à la file) — en cours  
- [x] Docs backlog créé (`docs/FEATURES-BACKLOG.md`)  

---

## Notes produit

- **Lire ensuite** = position `queueIndex + 1`  
- **Ajouter à la file** = append en fin de file « prévue » (pas dans le pool auto-radio si on peut le distinguer)  
- Les actions radio / mix réutilisent `startRadio` / `buildRadioQueue`  
- Le sheet doit marcher aussi pour album / playlist / artiste (sous-ensemble d’actions)  

---

## Sprint UX / biblio / DL / accueil (2026-08-12)

> Tracking pipeline complet dans [`STATUS.md`](../STATUS.md) (IDs `B1.*` … `B8.*`).  
> Ne cocher ici que quand **PROD (Nothing)** est validé.

### Bibliothèque

- [ ] Filtres : vue filtrée + **✕** pour revenir à l’accueil biblio (tous les chips)
- [ ] Titres : chargement / affichage plus rapide
- [ ] Mixes : mixes user **+** générés (biblio / humeur / habitudes)
- [ ] Playlist : **sans** Tout lire / Aléatoire ; bouton **télécharger toute la playlist**
- [ ] Téléchargés : Playlists → Albums → Titres ; Tout lire / Aléatoire **seulement** sur titres
- [ ] Sheet actions : état « dans biblio » **instantané** (cache)
- [ ] Podcasts / livres audio biblio = **uniquement** items ajoutés par l’user

### Accueil

- [ ] Section Podcasts + chips navigables (Albums / Livres / Podcasts)
- [ ] Explorer : covers + noms corrects
- [ ] Mixes : vignettes rapides (cache) ; Mix Nouveauté réparé ; mixes « déjà écouté »

### Téléchargements

- [ ] Progress non bloqué (titre / album, ex. Pandemonium) ; refresh live page album
- [ ] Pipeline DL plus rapide + stockage optimisé

### Lecteur / erreurs

- [ ] **Vitesse de lecture** — menu ⋮ (titre en cours / lecteur) : 0,5×–2×, option mémorisée par compte (style YTM)
- [ ] Next intermittent / crash → fix
- [ ] Toute erreur → email (télémétrie) ; **hors-ligne** → digest unique au retour réseau (E21)
- [ ] Force-stop Android : file restaurée **et** Play / Suivant jouent vraiment (E22)
- [ ] Toast « connexion perdue » : cause + fix
- [ ] **Web** : clic zone vide barre noire → toggle Now Playing (hors contrôles)
- [ ] **Web** : retry auto plafonné (pas de boucle « nouvel essai » infinie sur 502)
- [ ] **Ops** : prod streams via tunnel maison si IP VPS bloquée YouTube (`scripts/deploy/link-home-stream.sh`)
- [ ] **À suivre** : suggestions visibles même si auto OFF ; stop fin de file ; Suivant charge ; sync préf
- [ ] Prefetch listes longues (~10 s tête viewport)
- [ ] Playlist hero Android : play / shuffle / DL icône + menu ⋮
- [ ] Inscription prod ouverte → onboarding **liaison Google** (compte gratuit, pas Premium) pour signer les streams (B4.24)

### Perf API (voir ERRORS.md)

- [ ] Radio artiste < ~3 s pour un preview jouable (pas 50–75 s pour 200 titres)
- [ ] Reco / mix seed texte non vide (ex. chill / nouveauté)
- [ ] Warm stream sous charge non bloquant

### Réglages / logs

- [ ] Page entière scrollable (Crash / Perf / Logs) + journal
- [ ] Réglages : padding / espace haut

### Artiste / albums

- [ ] Albums / singles / playlists en cartes ; garder scroll state
- [ ] Page artiste plus rapide (cache)
- [ ] Appui long album = sheet complet (biblio, play, j’aime tous titres, ajouts individuels sans duplicata)

### Plus tard — toute fin (ne pas prioriser)

- [x] **Z99 Rebrand PLM (UI)** — PWA / mobile / manifests → **PLM** ; nom complet réservé à la doc. Repo Git **YTMusic** inchangé. Voir [`docs/PLM.md`](./PLM.md).
