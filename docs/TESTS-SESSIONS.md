# Sessions de test PLM — prod / DEV / local

Deux sessions **complètes** (même checklist), plus une variante **API locale**.  
Compte test : `dev@delhomme.ovh` (SEED).  
Appareils : **Samsung = flavor DEV** (`ovh.delhomme.ytmusic.dev`, `d+`) · **Nothing = flavor PROD** (`ovh.delhomme.ytmusic`, `p+`).

| Session | API | APK | Appareil cible |
|---|---|---|---|
| **PROD** | `https://ytmusic.delhomme.ovh` | `p+` (make android-upload-apk) | Nothing A059 |
| **DEV** | LAN `http://192.168.x.x:8787` | `d+` (make android) | Samsung |
| **LOCAL-web** | `http://127.0.0.1:8787` | navigateur | PC |
| **ALT-prod-from-dev-apk** | prefs Debug → URL prod | APK `d+` | Samsung (contrôle croisé) |

Consigner : date, build (`p+/d+x.y.z`), `/api/health` `ref`, résultat **OK / KO / N/A**, screenshot ou logcat si KO.  
Toute erreur player / crash **doit** partir par email admin (télémétrie). Si pas de mail → noter.

---

## Session PROD (Nothing)

### P0 — Santé
- [ ] Health `https://ytmusic.delhomme.ovh/api/health` OK, OAuth TV `connected`
- [ ] APK installée `p+` version = VERSION repo
- [ ] Catégorie app : Musique / audio (AOSP n’a pas « Divertissement »)

### P1 — Connexion / inscription / passkey
- [ ] Login email + mot de passe
- [ ] Après login : prompt passkey → Enregistrer (Bitwarden ou empreinte)
- [ ] Déconnexion → **Continuer avec une passkey**
- [ ] Inscription fermée en prod (sauf toggle Admin)
- [ ] Compte Google : **un bouton** « Connecter Google » → login dans l’app → sync biblio **sans collage**
- [ ] Pas Premium requis (compte Google gratuit)

### P2 — Batterie / télémétrie
- [ ] Réglages → Email rapport batterie
- [ ] Forcer une erreur player (avion 3 s puis play) → mail `android.player` reçu

### P3 — Lecture / file / « erreur réseau »
- [ ] Lancer un album (≥ 4 titres), laisser **enchaîner 4+ titres** sans toucher
- [ ] Fin de titre : **pas** de toast réseau, titre suivant part
- [ ] Skip suivant ×5 : pas de crash, file conservée
- [ ] Wi‑Fi OK : aucun « connexion perdue » / « réseau instable »
- [ ] Lecteur : scroll paroles, seek, shuffle

### P4 — Accueil / mixes / explorer
- [ ] Accueil charge (cache puis réseau), scroll progressif
- [ ] Mixés pour toi : mosaïques (pas que lettres)
- [ ] Mix **Nouveautés** lance une file
- [ ] Radio J’aime / mixes humeur
- [ ] Rayons **Podcasts** et **Livres audio**
- [ ] Explorer : tuiles avec nom lisible + cover si YTM en fournit

### P5 — Artiste / album / long-press
- [ ] Page artiste : tops + cartes albums/singles, retour conserve le scroll
- [ ] Appui long **album** : écouter, biblio, j’aime tous les titres, télécharger
- [ ] ⋮ titre : « déjà dans playlist / biblio » **immédiat** (SQL)

### P6 — Bibliothèque / playlists / filtres
- [ ] Accueil biblio (Ajouts) ; chip + ✕ pour revenir
- [ ] Podcasts / livres audio = **seulement** items ajoutés
- [ ] Playlist détail : **pas** Tout lire / Aléatoire ; bouton **télécharger la playlist**
- [ ] Téléchargés : playlists → albums → titres ; Lecture/aléatoire **titres seulement**

### P7 — Téléchargements
- [ ] Titre ⋮ télécharger : progress avance (pas coincé 2 %)
- [ ] Album *Pandemonium* Heaven Pierce Her : progress agrégé bouge, termine
- [ ] 2ᵉ tap = annuler

### P8 — Paroles
- [ ] *Vie d’artiste* Keny Arkana : paroles présentes ou message clair
- [ ] *Capitale de la rupture* : karaoké aligné ; Trop tôt / Trop tard

### P9 — Réglages & logs
- [ ] Page **entière** scrollable (formulaire + journal)
- [ ] Onglets Crash / Journal / Perf

---

## Session DEV (Samsung)

Même checklist **D0–D9** = P0–P9 avec API LAN.

### D1 extra — Passkey DEV
- [ ] rpId côté options Android = `ytmusic.delhomme.ovh` (pas `localhost`, pas une IP)
- [ ] Enroll + login passkey sur flavor `.dev`

### D-PLAY extra
- [ ] File 10 titres, lecture 20+ min, enchaînement fin de piste
- [ ] Logs : `EOS via error` sans `setMediaItem` qui vide la file

---

## Variante LOCAL (web PC)

- [ ] Login / passkey navigateur (`localhost`)
- [ ] Accueil, artiste, album, file, mix depuis titre/album/artiste
- [ ] Paroles Keny
- [ ] Admin OAuth TV status `connected` (ne pas relancer `/start`)

---

## Variante ALT (APK DEV → URL prod)

Debug → coller `https://ytmusic.delhomme.ovh` → refaire **P3** (lecture) + **P1** (passkey, rpId public).

---

## Pages à scroller (toutes sessions)

Accueil · Recherche · Artiste · Album · Titres artiste · File (auto + depuis album) · Playlists · Mix · J’aime · Épingles (artiste / titre / album) · Bibliothèque (chaque filtre) · Now playing · Réglages.

« Connexion perdue » sur une page alors que le Wi‑Fi est OK = **bug** : noter URL, logcat, mail télémétrie.
