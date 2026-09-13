# PLM — Checklist d’améliorations (suivi à la lettre)

**Date :** 2026-09-13  
**Baseline :** p+1.3.230 (DnD file + Accès rapide déjà livré)  
**Branche correctifs immédiats :** `feat/audit-battery-ui-improvements-231`  
**Test prévu :** demain après-midi (Samsung → Nothing, canal `dev` puis promo)

Ce fichier est la **source de vérité** pour la vague d’améliorations UI / batterie / backend / web.  
Cocher uniquement après validation appareil. Ne pas promo `prod` avant gate Samsung + Nothing.

---

## Légende

| Tag | Sens |
|-----|------|
| `[FAIT]` | Correctif déjà dans la branche audit (à tester demain) |
| `[P0]` | Impact fort ressenti / batterie — prochaines sessions |
| `[P1]` | Important, pas bloquant demain |
| `[P2]` | Polish / dette |
| `[SKIP-230]` | Déjà livré en 1.3.230 — ne pas replanifier |

---

## 0. Déjà livré (ne pas refaire)

- [x] `[SKIP-230]` Drag fluide Accès rapide Android (long-press / poignée, auto-scroll)
- [x] `[SKIP-230]` Drag fluide file d’attente Android (panneau + aperçu + paysage)
- [x] `[SKIP-230]` Warm prefetch différé en fin de drag file
- [x] `[SKIP-230]` Suppression junk racine `0.0` / `85` / `88` / `89`

---

## 1. Correctifs immédiats (branche audit — tester demain)

### Batterie / radio Android

- [ ] `[FAIT]` Gate warm `trackVisual` **uniquement** en mode Vidéo (`VideoPlaybackHost.kt`)
- [ ] `[FAIT]` `DisposableEffect` → `VisualClipPrefetcher.cancel()` au démontage NP
- [ ] `[FAIT]` `NetworkMonitor` : plus de poll 8 s permanent (60 s online / 12 s offline)
- [ ] `[FAIT]` `LibraryHeadPrefetcher` : pause ticks si app STOPPED (intervalle BG 15 min)
- [ ] `[FAIT]` Heartbeat session HTTP **seulement** si `receiveRemoteSync()`
- [ ] `[FAIT]` Miroir remote : sleep 45 s si sync off (plus de wakeups 2–6 s)

### UI motion

- [ ] `[FAIT]` `onQueueDrag` : `snapTo` en `UNDISPATCHED` (file moins saccadée)

### Serveur

- [ ] `[FAIT]` `streamHeal` : pendant cooldown 8 min → `bumpWarmPriority` seulement (pas de ré-enqueue)

### Validation demain (ordre strict)

1. [ ] Install **PLM Dev** Samsung (`d+`), API LAN ou `:dev`
2. [ ] Idle 10 min écran off : vérifier logcat — pas de storm `shuffle-heads` / `trackVisual`
3. [ ] Mode audio-only : pas d’appels `trackVisual` à chaque skip
4. [ ] Mode Vidéo : clip OK ; fermer sheet → prefetch clips stoppé
5. [ ] Drag file : geste fluide, expand/collapse moins collant
6. [ ] Sync multi-appareils **off** : plus de heartbeat 4 s
7. [ ] Gate Nothing PLM Dev → puis preprod → promo prod

---

## 2. Batterie Android — reste à faire

### P0

- [ ] `[P0]` Mode Vidéo : `stop()` + `clearMediaItems()` sur Exo clip quand `!active` (pas seulement pause) — `SyncedVideoSurface.kt`
- [ ] `[P0]` Une seule file prefetch stream (fusion rolling + warmAround + LibHeads) — `StreamPrefetcher.kt` / `PlayerController.kt`
- [ ] `[P0]` Hard-cap 1 far-prefetch pendant play actif

### P1

- [ ] `[P1]` `OfflineKeeper` : WorkManager Wi‑Fi+charge au lieu de boucle 20 min process-lifetime
- [ ] `[P1]` `PlaybackIdleGuard` : demote / stop FGS après 20–30 min pause BG (au lieu de 6 h)
- [ ] `[P1]` Couper `WAKE_MODE_NETWORK` si `!isPlaying`
- [ ] `[P1]` Ticks UI position : seulement Activity STARTED + écran on ; paroles sans poll 48 ms
- [ ] `[P1]` Gate `Log.*` release via `AppLog` + rate-limit hot path
- [ ] `[P1]` Biblio 14k : ne pas matérialiser toute `playableQueue` ; throttle `boostVisible` ≥ 2–3 s

### P2

- [ ] `[P2]` Equalizer : release AudioEffect si disabled
- [ ] `[P2]` PlayingBars : geler anim si `!Lifecycle.RESUMED`
- [ ] `[P2]` Coil : revalider heap/disque après usage réel Nothing

---

## 3. Mouvements UI / interface Android

### P0

- [ ] `[P0]` Vélocité file : vrai `VelocityTracker` pour fling expand/collapse — `NowPlayingScreen.kt`
- [ ] `[P0]` Mini-player : spring snap-back + haptic Confirm au dismiss — `TrackRow.kt` / `MiniPlayerBar`
- [ ] `[P0]` Transition mini ↔ NP : morph cover / spring (pas `tween(0)` pop) — `MainActivity.kt`

### P1

- [ ] `[P1]` Remplacer `dismissArmed` 420 ms par seuil + vélocité / `anchoredDraggable`
- [ ] `[P1]` Swipe cover H/V : spring + haptic + crossfade avant skip
- [ ] `[P1]` Uniformiser sheets (`skipPartiallyExpanded`, handle, scrim) — TrackActions vs Cast/EQ/History
- [ ] `[P1]` Library : chips sticky + skeleton lignes (plus de « Chargement… » texte)
- [ ] `[P1]` Home : shimmer skeleton (comme web `HomeShelfSkeleton`)
- [ ] `[P1]` Haptics NP : expand file, like, seek ticks
- [ ] `[P1]` `NavHost` : transitions fade/slide courtes entre tabs / détail
- [ ] `[P1]` Library fenêtre progressive : placeholders hauteur pour éviter trous au scroll rapide

### P2

- [ ] `[P2]` Palette tokens unifiée (Theme vs PlayerFg/SeekRed vs web)
- [ ] `[P2]` Empty states illustrés + CTA (Library, QuickAccess, pins Home)
- [ ] `[P2]` A11y NP : seek `role=slider`, descriptions cover, chips File/Similaires
- [ ] `[P2]` Hit-targets ≥ 48 dp landscape / NavigationBar
- [ ] `[P2]` LazyRow Accueil : snap + fade edges
- [ ] `[P2]` Paroles : scale/opacity ligne active style YTM
- [ ] `[P2]` Kit sheet commun (Cast, EQ, History, Identify)

---

## 4. Web

### P0 / P1

- [ ] `[P0]` DnD file style Android 1.3.230 (pointer, insert line, élévation) — `TrackRow.tsx` / `QueuePanel.tsx` / `NowPlaying.tsx`
- [ ] `[P0]` Accès rapide web : drag fluide (plus de flèches swap) — `HomePage.tsx`
- [ ] `[P0]` Biblio : `library({ light: true })` au boot ; full seulement onglet Biblio / idle
- [ ] `[P1]` Stop poll Layout biblio 20 s → ETag / event WS `library.changed`
- [ ] `[P1]` Prefetch stream web : baisser concurrency ; pause si tab hidden
- [ ] `[P1]` NP web : sheet bottom + swipe dismiss (pas seulement fade-up)

### P2

- [ ] `[P2]` `ProxyHealthBanner` 60–120 s
- [ ] `[P2]` Admin poll 15 s / WS
- [ ] `[P2]` NowPlaying `setInterval` 250 ms → events média / rAF
- [ ] `[P2]` Code-split pages detail/admin (`React.lazy`)
- [ ] `[P2]` Morph PlayerBar ↔ NP lié à `--ytm-player-h`

---

## 5. Backend API

### P0

- [ ] `[P0]` Budget warm global / user / min (playing > next 2 > shuffle > taste)
- [ ] `[P0]` `/api/home` : ne pas double-warm si taste déjà planifié
- [ ] `[P0]` Library : pagination / curseur + ETag `(userId, max(updated_at))`
- [ ] `[P0]` Mutations library : répondre `{ ok, id }` sans `getFullLibrary`
- [ ] `[P0]` Session Android : WS ou heartbeat progress-only 15–30 s (pas toute la queue en HTTP 4 s)
- [ ] `[P0]` Telemetry batch : INSERT transaction + heal **unique** par trackId (max 5 / batch)

### P1

- [ ] `[P1]` Format URL cache durable SQLite (survie restart)
- [ ] `[P1]` `stream_log` prune probabiliste (comme telemetry 5 %)
- [ ] `[P1]` Endpoint `GET /api/stream/:id/ready` → `{ head, disk, formatExpires }`
- [ ] `[P1]` Skip `authOptional` JWT sur `/api/img`, `/api/health`, static
- [ ] `[P1]` Indexes `telemetry_events(kind, created_at)`, `(user_id, created_at)`
- [ ] `[P1]` Logs warm/heal gateés `LOG_LEVEL` + sampler

### P2

- [ ] `[P2]` Debounce `listen` progress serveur 30 s / track
- [ ] `[P2]` `POST /api/playback/tick` (coalesce listen + session)
- [ ] `[P2]` ANALYZE PG après gros sync YTM
- [ ] `[P2]` Métriques warm queue depth dans `/api/health`

---

## 6. Processus / ops / qualité

- [ ] `[P1]` Pipeline inchangé : local → Samsung → `dev` → Nothing → preprod → prod
- [ ] `[P1]` Toute promo : `VERSION_NOTES.json` + sync web/assets
- [ ] `[P1]` Script QA batterie Samsung (idle 15 min + lecture 20 min) → rapport JSON
- [ ] `[P2]` Dashboard admin : warm queue / heal rate / yt-dlp cooldown
- [ ] `[P2]` Alerte mail si heal storms > N / 10 min
- [ ] `[P2]` Doc `docs/OPS-BATTERY.md` (matrice BatterySaver + IdleGuard)

---

## 7. Ordre d’attaque des prochaines sessions

| Session | Focus | Sortie |
|---------|--------|--------|
| **A (demain PM)** | Valider `[FAIT]` sur Samsung + Nothing | Merge → `dev`, éventuelle promo |
| **B** | Batterie P0 Exo clip + prefetch unique | patch `1.3.23x` |
| **C** | UI P0 gestes NP / mini / morph | patch |
| **D** | API library light + ETag + heal batch | patch serveur |
| **E** | Parité web DnD + light library | patch web |
| **F** | Polish P1/P2 sheets / a11y / skeletons | vague polish |

---

## 8. Critères de « done » batterie

Mesure sur Nothing (usage quotidien `pavel@`) et Samsung gate :

1. Idle écran off 15 min, process vivant, sync off : **0** appel `shuffle-heads` / `trackVisual` / `session/state`
2. Lecture audio-only 20 min : pas de 2e Exo clip actif ; pas de warm visual
3. Lecture vidéo 10 min puis sheet fermé : clip Exo arrêté (pas seulement pause)
4. Batterie OS : pas de top « PLM » anormal vs YTM sur même session (observation manuelle)

---

## 9. Fichiers clés

| Zone | Fichiers |
|------|----------|
| Drag 1.3.230 | `DragReorder.kt`, `QuickAccessScreen.kt`, `NowPlayingScreen.kt` |
| Batterie audit | `VideoPlaybackHost.kt`, `NetworkMonitor.kt`, `LibraryHeadPrefetcher.kt`, `MainActivity.kt`, `streamHeal.ts` |
| Prefetch | `StreamPrefetcher.kt`, `VisualClipPrefetcher.kt`, `OfflineKeeper.kt` |
| API chauds | `api/src/media/stream.ts`, `library/library.ts`, `auth/sessions.ts` |
| Web | `web/src/components/layout/Layout.tsx`, `HomePage.tsx`, `streamPrefetch.ts` |

---

*Rapport PDF densifié + e-mail : `scripts/qa/send-audit-complet-20260913.mts` → `tmp/report-2026-09-13-audit-complet/`*
