# TESTS_DEV — à faire **maintenant** (session courante)

Environnement : **local** d’abord (web `http://localhost:5173` + Samsung API LAN).  
Prod = smoke seulement quand LOCAL A1–A6 + B liés sont OK.

**Règle** : un bloc parent n’est **OK** que si **toutes** ses cases enfants sont cochées.  
Ne passe **pas** à A7+ tant que A1–A6 (et fixes associés) ne sont pas tous verts.

Glossaire :
- **Now Playing (NP)** = écran plein lecteur (clic sur la **barre du bas** qui montre le titre en cours).
- **File** = onglet « File » dans NP (ou panneau file latéral desktop).

Prérequis : [`TESTS.LOCAL.md`](./TESTS.LOCAL.md) §0 · Samsung APK **dev** LAN.

---

## A. Web local

### [ ] A — Web local (tout A1…A9)

#### [ ] A1. Reprise lecture *(parent OK quand A1.1–A1.3 OK)*
- [x] A1.1 — Avancer ~1:00, F5 → barre déjà au bon endroit **sans** Play
- [x] A1.2 — Play reprend au bon timecode (pause / perte connexion OK)
- [ ] A1.3 — **Clavier** Media keys / barre OS : Play/Pause reprend bien le titre après reload (prod + local)

> Note session : A1.1–A1.2 OK. A1.3 à **retester** après fix media session + toggle canplay.

#### [x] A2. Fonts / console
- [x] A2.1 — Plus d’erreur CSP `fonts.googleapis.com` (local)

#### [ ] A3. File & À suivre *(parent OK quand A3.1–A3.4 OK)*
- [x] A3.1 — Ouvrir NP (clic barre bas) → File → section **Déjà joués** scrollable, pas de rétraction agressive
- [x] A3.2 — Autoplay remplit **À suivre**
- [x] A3.3 — Clic titre **loin** dans À suivre → insert juste après le courant (milieu pas « déjà joué »)
- [ ] A3.4 — Titre **long** : le son démarre vite (début) pendant que la suite charge — **pas** d’attente longue / coupure

> Note : A3.1–A3.3 OK web. A3.4 à **retester** (Content-Length, audio-only yt-dlp, moins de prefetch concurrent).

#### [ ] A4. Similaires
- [ ] A4.1 — Au play, onglet Similaires : ~10 titres **rapides**
- [ ] A4.2 — Scroll → charge plus
- [ ] A4.3 — Chargement similaires **ne coupe pas** / ne sacade pas l’audio en cours

> Note : prefetch différé après merge autoplay — à retester.

#### [ ] A5. Radio
- [ ] A5.1 — Icône **radio blanche** sur la row (file / liste) par défaut (toujours visible)
- [ ] A5.2 — Après lancement mix titre → icône **rouge** sur ce titre + libellé « Mix à partir de {titre} »
- [ ] A5.3 — Menu ⋯ : « En rapport » / radios artiste avec **icône Radio** cohérente
- [ ] A5.4 — Mix remplace / remplit la file correctement

#### [ ] A6. Téléchargement
- [ ] A6.1 — ⋯ → Télécharger : % **réel** (pas bloqué 2 % puis saut)
- [ ] A6.2 — Download **audio only** (pas vidéo) — raisonnablement rapide
- [ ] A6.3 — Sheet peut se fermer : le download **continue** (pas d’erreur « coroutine scope left »)
- [ ] A6.4 — Progress visible **partout** pour ce titre (⋯, row %, chrome NP) tant que DL en cours
- [ ] A6.5 — Fin → « Sur l’appareil » / check, fichier jouable hors ligne

> Note : manager global Android + progress IndexedDB web — à retester avant A7.

#### [ ] A7. Pin → biblio *(après A1–A6 OK)*
- [ ] A7.1 — Épingler un **titre** → Accès rapide + Bibliothèque Titres
- [ ] A7.2 — Épingler un **album** → Accès rapide + Bibliothèque Albums

#### [ ] A8. Playlist UI *(après A1–A6 OK)*
- [ ] A8.1 — Auteur / N titres empilés
- [ ] A8.2 — Lecture et Aléatoire l’un sous l’autre

#### [ ] A9. Accueil ordre *(après A1–A6 OK)*
- [ ] A9.1 — Accès rapide (si pins) → Mixés pour toi → shelves

---

## B. Samsung APK **dev** (API LAN)

### [ ] B — Samsung (tout B1…B5)

#### [ ] B1. Boot / session
- [ ] B1.1 — Force-stop + relance sans écran noir long
- [ ] B1.2 — Session / Accueil cohérent

#### [ ] B2. Offline
- [ ] B2.1 — Mode avion : pas de Mixés + message hors ligne
- [ ] B2.2 — Accès Téléchargés
- [ ] B2.3 — Retour réseau + refresh Accueil → mixes OK

#### [ ] B3. Similaires + radio + download *(miroirs A4–A6)*
- [ ] B3.1 — Similaires rapides, peu de coupe audio
- [ ] B3.2 — Radio / En rapport icônes + comportement OK
- [ ] B3.3 — Download % global + continue si on ferme le sheet
- [ ] B3.4 — File : section **Déjà joués** présente (parité web)

#### [ ] B4. Biblio
- [ ] B4.1 — Filtre défaut **Titres**
- [ ] B4.2 — Téléchargés : spinner puis liste

#### [ ] B5. Album header
- [ ] B5.1 — Retour / artiste / année bien visibles

---

## C. Smoke prod *(seulement si A+B GO)*

### [ ] C — Smoke prod
- [ ] C.1 — https://ytmusic.delhomme.ovh login + play + F5 progression
- [ ] C.2 — Clavier Play/Pause après reload (A1.3 prod)
- [ ] C.3 — Console : pas d’erreur fonts
- [ ] C.4 — Nothing APK prod : play + file + download smoke

---

## Critères GO

| Niveau | Condition |
|--------|-----------|
| **GO A1–A6** | Toutes cases A1…A6 cochées (fixes inclus) |
| **GO suite** | GO A1–A6 + A7–A9 + B1–B5 |
| **GO prod** | GO suite + C |

Tant que A1–A6 ne sont pas verts → **pas** A7+, **pas** TESTS_PROD.

Index : [`TESTS.md`](./TESTS.md) · Local : [`TESTS.LOCAL.md`](./TESTS.LOCAL.md).

---

### Glossaire (rappel)
- **Now Playing (NP)** = clic sur la **barre du bas** (titre en cours) → plein écran lecteur.
- **File** = onglet / panneau file dans NP (Déjà joués · En cours · À suivre).
