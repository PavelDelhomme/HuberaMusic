# Notes produit / backlog

## Stats d’écoute (paramètres / compte) — plus tard

Emplacement UX : menu compte Android (`AccountSheet`) à côté de Recommandations / Déconnexion ;
miroir web sur `ProfilePage`.

Contenu souhaité :
- Artistes les plus écoutés
- Temps d’écoute total (minutes → heures → jours → mois selon l’échelle)
- Nombre de titres écoutés
- Taux de couverture / « remplissage » de la bibliothèque
- Éventuellement historique agrégé par période

Sources possibles déjà côté API : `history`, `entity_history` / `getTopListened`, `getFullLibrary` counts.

---

## Podcasts / livres audio (2026-08-07) — amorcé

Besoin : section dédiée pour podcasts + livres audio YouTube (flux audio, pas forcément vidéo UI).
Les propositions « similaire » / radio doivent rester **musique only** (pas albums / fiches / épisodes).

Fait :
- [x] Dédup épingles par `targetId` (garder le premier), normaliser song/video
- [x] Filtre musique sur similar / hybridRank (`isMusicPlayableHit`)
- [x] Recherche filtres `podcast` / `audiobook` + `/api/explore/spoken`
- [x] Web : Recherche + Bibliothèque onglets
- [x] Android : Recherche filtres + Bibliothèque Podcasts / Livres audio

À valider :
- [ ] Qualité des résultats spoken (heuristique YTM, pas API podcast native)
- [x] Smoke web + Samsung Wi‑Fi (session 20260807-132058 ; ne plus Nothing)
- [ ] Déployer API avant clients (sinon explore/spoken 404) — OK en local, pas encore prod

---

## Réseau mobile / reprise lecture (signalé 2026-08-07) — en cours

Symptômes (Nothing, APK prod) :
- Changement Wi‑Fi ↔ données mobiles → perte de la file / impossible de reprendre
- Toast « Serveur injoignable » alors que l’API est `https://ytmusic.delhomme.ovh`
- Erreur type « coroutine scope… » (scope annulé / exception non gérée)
- Couper le réseau fait tout capoter

Cause probable :
- `onPlayerError` réseau → **stop immédiat** dès le 1er échec (handover)
- `NetworkMonitor.onLost` trop agressif (pas de debounce)
- Toast « Serveur injoignable » confond glitch réseau et API morte

Correctifs amorcés (à valider en prod **et** en dev / LAN) :
- Debounce offline ~1,8 s + retry soft sur erreurs réseau
- Messages : « Réseau instable — reprise… » / « Connexion perdue… »
- `CrashReporter.coroutineHandler` sur scopes Player / PlaybackService

À faire encore :
- [ ] Rebuild + smoke Nothing / Samsung (prod URL)
- [ ] Smoke équivalent en **dev** (API LAN) : bascule Wi‑Fi / avion / reprise
- [ ] Si file perdue côté UI : reconnect MediaController après handover
- [ ] Mails récap : tableaux **scrollables horizontalement** sur mobile (fait pour le prochain envoi)

---

## Mails rapports batterie

Pas de tableaux larges (BlueMail / mobile ne scroll pas toujours horizontalement).
Préférer des **cartes empilées** (label + valeur), largeur max ~480px, `word-break`.

