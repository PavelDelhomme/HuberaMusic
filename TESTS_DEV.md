# TESTS_DEV — à faire **maintenant** (session courante)

Focus sur les correctifs récents (reprise player, file, similaires, fonts, offline, pins, radio, UI).  
Environnement : **local** (web + Samsung LAN). Prod = smoke rapide après si déjà déployé.

Prérequis : stack local UP + Samsung APK **dev** (API LAN). Voir [`TESTS.LOCAL.md`](./TESTS.LOCAL.md) §0.

---

## A. Web local (`http://localhost:5173`)

### A1. Reprise lecture
1. Lance un titre, avance à ~1:00, **recharge** la page (F5).
2. **Attendu** : barre de progression déjà au bon endroit **sans** cliquer Play ; Play reprend au bon timecode.

### A2. Fonts / console
1. Ouvre DevTools → Console sur Accueil / Biblio.
2. **Attendu** : **plus** d’erreur CSP `fonts.googleapis.com`.

### A3. File & À suivre
1. Now Playing → File : scrolle **Déjà joués** (pas de rétraction agressive).
2. Laisse l’autoplay remplir À suivre ; clique un titre **loin** (pas le 1er).
3. **Attendu** : ce titre passe **juste après** le courant ; le milieu n’est pas « déjà joué ».

### A4. Similaires
1. Lance un titre ; ouvre onglet **Similaires** tout de suite.
2. **Attendu** : ~10 suggestions déjà là (ou quasi) ; scroll → plus de titres.

### A5. Radio
1. Sur un titre de la file : icône radio **blanche**.
2. Clique radio → lecture mix ; icône **rouge** sur ce titre ; libellé type « Mix à partir de … ».

### A6. Téléchargement
1. Menu ⋯ d’un titre → Télécharger.
2. **Attendu** : cercle / % visible ; sheet ne disparaît pas avant la fin ; puis « Sur l’appareil ».

### A7. Pin → biblio
1. Épingle un titre **et** un album (accès rapide).
2. **Attendu** : apparaissent aussi en Bibliothèque (Titres / Albums).

### A8. Playlist UI
1. Ouvre une playlist.
2. **Attendu** : auteur / N titres empilés ; Lecture et Aléatoire l’un sous l’autre.

### A9. Accueil ordre
1. Soft refresh Accueil.
2. **Attendu** : Accès rapide (si pins) → Mixés pour toi → shelves (récents prioritaires).

---

## B. Samsung APK **dev** (API `http://<LAN>:8787`)

### B1. Boot / session
1. Force-stop + relance.
2. **Attendu** : pas d’écran noir interminable ; Accueil ou login cohérent.

### B2. Offline
1. Mode avion.
2. **Attendu** : Accueil sans Mixés ; message hors ligne + accès Téléchargés.
3. Réactive le réseau → refresh Accueil → mixes revenus.

### B3. Similaires + radio + download
1. Même scénarios A4–A6 côté Android.
2. **Attendu** : progress download visible ; radio label OK ; similaires pas vides au 1er open.

### B4. Biblio
1. Onglet Biblio à l’ouverture → filtre **Titres**.
2. Téléchargés : spinner si enrichissement, puis liste.

### B5. Album header
1. Ouvre un album.
2. **Attendu** : retour / artiste / année bien visibles (gros).

---

## C. Smoke prod (si déjà déployé — 5 min)

Ne remplace pas [`TESTS_PROD.md`](./TESTS_PROD.md).

- [ ] https://ytmusic.delhomme.ovh → login + play 1 titre + reload progression
- [ ] Console : pas d’erreur fonts Google
- [ ] Nothing APK prod : play + file (si installé)

---

## Critères « GO » pour la suite

| GO local | Condition |
|----------|-----------|
| Oui | A1–A9 + B1–B5 OK |
| Non | Bloquant : progression, crash, offline cassé, download sans feedback |

Ensuite :

1. Commit / PR → `dev` → deploy prod (déjà fait pour la dernière vague si `b9ca6e1` live).
2. `DEVICE=<nothing> make android-prod`
3. Enchaîner [`TESTS_PROD.md`](./TESTS_PROD.md).

Index : [`TESTS.md`](./TESTS.md).
