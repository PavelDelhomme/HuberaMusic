# Paroles & offline bundle (cible)

Pipeline actuel (API `getLyrics`) :

1. YouTube Music timed / texte  
2. LRCLIB (get + search, variantes titre/artiste)  
3. Captions YouTube (ASR)  
4. lyrics.ovh (texte)  
5. **Genius.com** (search publique ou `GENIUS_ACCESS_TOKEN` + scrape HTML)  
6. App : bouton « Chercher sur Genius / le web »

## Hors-ligne (à venir — pas dans 1.3.70)

Quand un titre est téléchargé, packager :

```text
offline/<trackId>/
  metadata.json
  audio.m4a
  cover.jpg      (optionnel)
  lyrics.lrc     (si timed) ou lyrics.txt
```

Lecteur : **horloge audio = maître** ; paroles / vidéo = esclaves (`currentTime`).

## Données mobiles & batterie

Chantier séparé : budgets prefetch, warm stream, OfflineKeeper, mesures ADB hors Wi‑Fi/mobile (Nothing une fois chargé). Voir aussi idées Gemini (bundle local, pas d’URL googlevideo en BDD).
