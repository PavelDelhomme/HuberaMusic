# ERRORS.md — erreurs & dettes à résoudre

> Journal des problèmes constatés en test (API / web / Android).  
> **Ne pas effacer** une entrée tant qu’elle n’est pas `done`.  
> Lien pipeline : [`STATUS.md`](./STATUS.md) · campagnes : [`TESTS.md`](./TESTS.md).  
> Smoke automatisé : `node scripts/test/smoke-load-test.mjs both` → `logs/smoke-*.json`.

**Légende** : `open` · `investigating` · `fixed` · `wontfix`

---

## Session 2026-08-27 (503 multi-titres + pause silencieuse)

### E31 — Relais maison KO → 503 hard (pas de fallback VPS) + player PAUSED
| | |
|--|--|
| **Status** | `fixed` (`1.3.79`) |
| **Surfaces** | API prod · Android (Blackview / Samsung / Nothing) — « erreurs sur plein de sons » |
| **Cause** | `stream-upstream.url` présent + tunnel PC coupé → `STREAM_UPSTREAM KO` renvoyait **503** sans tenter OAuth TV / yt-dlp VPS. Côté app, après retries : **pause** mid-song au lieu de skip → silence long. |
| **Fix** | Fallback VPS **par défaut** après relais KO (`STREAM_UPSTREAM_FALLBACK=0` pour opt-out) · skip auto au titre suivant après échecs · purge cache Exo `s4` |
| **Ops** | Remettre `link-home-stream.sh start` si le PC sert de relais ; ne plus éteindre l’API locale sans fallback |
| **Tests** | `curl /api/stream/4wOLVrGHiIU` 206 avec tunnel UP ; simuler tunnel DOWN → 206 via VPS |

---

## Session 2026-08-24 (stream Content-Range / Exo 2008)

### E30 — `RangeError start > end` sur `/api/stream` (createReadStream) → mails `unhandledRejection`
| | |
|--|--|
| **Status** | `fixed` (branche `fix/stream-eof-home-update` / PR **#149**, `1.3.70`) — **pas encore en prod** |
| **Surfaces** | API prod/local · Android (fin de titre / pause près EOF, ex. Don Choa) |
| **Cause** | Exo demande `Range: bytes=N-` avec `N === fileSize` (past EOF) → `createReadStream({ start: N, end: N-1 })` plante |
| **Fix** | `safeDiskRangeBounds()` → **416** si `start >= size` · try/catch + `rs.on('error')` · soft-ignore `ERR_OUT_OF_RANGE` · **meta.trackId** / `[stream ID]` dans télémétrie |
| **Tests** | `curl -H 'Range: bytes=SIZE-'` sur un `.m4a` caché → 416, pas de crash process ; mail (si autre erreur stream) affiche le titre |
| **PRs** | #149 |

### E23 — `onPlayerError` code **2008** (READ_POSITION_OUT_OF_RANGE) + EOF ~64 s + DL « unexpected end of stream »
| | |
|--|--|
| **Status** | `investigating` → fix dans PR **#149** (`1.3.69`/`1.3.70`) — **pas encore en prod** (`p+1.3.68`) |
| **Surfaces** | Android prod (Blackview / Nothing) · offline DL |
| **Cause** | Totaux `Content-Range` incohérents (relais maison vs cache disque) → Exo 2008 / EOF ; DL parallèle multi-Range coupé mid-stream |
| **Fix** | Total Content-Range stable · EOF/2008 = retry flux avec seek arrière · DL retry en séquentiel · Accueil/MAJ 7h–17h · **E30** bornes Range disque |
| **Tests** | Rejouer titres listés télémétrie > 2 min après deploy `p+1.3.70` |
| **PRs** | #149 stream/UX · #148 vidéo/transport **à valider avant** merge prod |

---

## Session 2026-08-12 (fin de titre = fausse erreur réseau)

### E13 — Fin de titre → « réseau instable » / file stoppée (prod mobile)
| | |
|--|--|
| **Status** | `in progress` — `setMediaItem` (vidait la file) → `replaceMediaItem` · EOS si durée inconnue · warm 8–22 s avant la fin |
| **Surfaces** | Android prod (surtout) · web |
| **Cause** | Recovery `setMediaItem` remplaçait toute la playlist par 1 item → plus de suivant. EOS raté si `duration` UNSET. Prefetch seulement au changement de piste. |
| **Fix** | `replaceMediaItem` · snapshot `lastPlayingPosMs` · warm near-end · ne plus `markStreamDown` sur EOS |
| **Tests** | docs/TESTS-SESSIONS.md **PROD P-PLAY** · **DEV D-PLAY** |

---

## Session 2026-08-12 (smoke charge multi-artistes + UI)

**Envs** : local API `:8787` + Vite `:5173` · prod `ytmusic.delhomme.ovh` (`a481e3b`, `p+1.3.17`) · Samsung DEV `d+1.3.17` · Nothing PROD `p+1.3.17`  
**Tunnel maison** : UP (streams prod 206)

### E1 — Drawer web : playlists affichent « 0 titres »
| | |
|--|--|
| **Status** | `fixed` (code) — à revalider PROD après redeploy web |
| **Surfaces** | web local + web prod |
| **Cause** | GET `/api/library` renvoie playlists **light** (`tracks: []` + `trackCount`) ; le drawer faisait `p.tracks.length` |
| **Fix** | `Layout.tsx` → `p.trackCount ?? p.tracks?.length ?? 0` |
| **Repro** | Ouvrir drawer → playlists locales affichent 0 alors que `trackCount` API > 0 |
| **STATUS** | lié B4.9 / B4.15 |
| **Tests** | TESTS.md **R5/R12** · LOCAL §4 · DEV D11 · PROD P11 |

### E2 — Radio artiste extrêmement lente (~50–75 s)
| | |
|--|--|
| **Status** | `fixed` (2026-08-14) |
| **Surfaces** | API local + prod · web · Android |
| **Cause** | `/api/artist/:id/radio` construisait le mix **full ~200** par défaut (multi-seed + searches) |
| **Fix** | Défaut = **preview ~12** (related + tops) ; `?full=1` pour le mix long ; fill full en fond + cache |
| **Tests** | smoke artist radio &lt; 8 s · tracks ≥ 5 |

### E3 — Reco radio seed « chill » vide
| | |
|--|--|
| **Status** | `wontfix` (faux positif smoke) — 2026-08-14 |
| **Surfaces** | smoke script |
| **Cause** | Smoke appelait `GET /api/reco/radio?seed=chill` (404/HTML) au lieu de `/api/reco/radio/chill?preview=1` |
| **Mesure correcte** | `/api/reco/radio/chill?preview=1` → **12 tracks** local + prod |
| **Fix** | `scripts/test/smoke-load-test.mjs` chemin corrigé |
| **STATUS** | B2.5 hors scope (endpoint catégorie OK) |

### E4 — Library GET encore lourd (~2.4–3.2 s)
| | |
|--|--|
| **Status** | `fixed` (2026-08-14) |
| **Surfaces** | API local + prod |
| **Cause** | `GET /api/library` attendait `repairLibraryTrackMeta` (hydrate YT + expand albums) |
| **Fix** | Réponse sync `getFullLibrary` ; repair throttlé en fond (`scheduleLibraryRepair`, TTL 10 min) |
| **Tests** | smoke library typiquement ≪ 1,5 s (payload JSON selon taille biblio) |

### E5 — Warm batch stream lent sous charge (prod)
| | |
|--|--|
| **Status** | `fixed` (2026-08-14) |
| **Surfaces** | API prod (surtout) |
| **Cause** | `POST /api/stream/warm` attendait `Promise.all` de tous les `getAudioFormat` avant de répondre |
| **Fix** | Réponse immédiate `{ queued: true }` + file workers (concurrence 2, cap 12) ; `wait=1` pour legacy |
| **Tests** | smoke warm ≪ 2 s + `queued=true` |

### E6 — Badge version web parfois stale (SW)
| | |
|--|--|
| **Status** | `open` (mineur) |
| **Surfaces** | web prod |
| **Note** | UI a affiché brièvement `p+1.3.9` alors que `/api/health` = `p+1.3.17` |
| **Piste** | forcer refresh SW / afficher version health API |
| **STATUS** | **B8.5** |

### E7 — Passkeys Android / Bitwarden non utilisables
| | |
|--|--|
| **Status** | `in progress` — rpId Android = domaine public (même en DEV LAN) · origines apk-key-hash toujours attendues · queries CredentialProviderService Android 14+ · Activity context |
| **Surfaces** | Android (Samsung, Nothing, …) · API WebAuthn |
| **Cause** | DEV : `WEBAUTHN_RP_ID=localhost` alors que Credential Manager lit assetlinks sur le domaine public ; VPS sans `WEBAUTHN_ANDROID_ORIGINS` ; Nothing Android 16 ne voyait pas Bitwarden |
| **Fix** | `publicRpId()` pour Origin `android:` · `expectedOrigins` toujours hash debug · CORS `android:apk-key-hash` · queries framework + Bitwarden · sanitize `hints` |
| **Repro** | Login Android prod Nothing → Continuer avec passkey ; enroll après login mot de passe |
| **Tests** | docs/TESTS-SESSIONS.md **PROD P1** · **DEV D1** |

### E8 — Paroles synchronisées trop en avance (1–2 lignes)
| | |
|--|--|
| **Status** | `fixed` (code) — lead 350 ms · lag LRCLIB 300 ms · pas de ligne 0 forcée |
| **Surfaces** | web · Android · API lyrics |
| **Cause** | Lead 500 ms trop tôt ; puis lag client 1,2–2 s **en plus** de `syncOffsetMs` API ; `coerceAtLeast(0)` / idx=0 avant la 1ʳᵉ ligne |
| **Fix** | Lead lecture 0,35 s · lag LRCLIB 0,3 s · cache Android `v3` · normalize s/ms · intro sans highlight |
| **Repro** | Keny *Capitale de la rupture* / *Vie d’artiste* |
| **Tests** | docs/TESTS-SESSIONS.md **PROD P5** |

### E9 — Membership playlist lente / fausse (tracks light vides)
| | |
|--|--|
| **Status** | `fixed` (code) |
| **Cause** | Playlists biblio light (`tracks: []`) → « déjà dedans » impossible / lent via full library |
| **Fix** | `GET /api/library/playlists/containing/:trackId` (SQL) · préchargement dès le sheet ⋮ |
| **Tests** | TESTS.md **R9** · LOCAL §4 · DEV D4 · PROD P4 |

### E10 — Téléchargement Android spinner long
| | |
|--|--|
| **Status** | `fixed` (code) |
| **Cause** | Après DL local, `POST /api/download` relançait yt-dlp (~10–20 s) avant de retirer le spinner |
| **Fix** | `?ack=1` marque serveur sans re-télécharger · warm stream avant GET |
| **Tests** | TESTS.md **R6/R10** · LOCAL §7 · DEV D7 · PROD P7 |

### E11 — Suggestions « À suivre » = clips Officiel plutôt qu’audio
| | |
|--|--|
| **Status** | `fixed` (code) — à revalider |
| **Cause** | upNext/related YT sans préférence ATV ; titres « Officiel » non nettoyés ; hydrate écrasait type video |
| **Fix** | `preferCatalogAudio` (dédup artiste+titre, score song≫video) · `cleanMusicTitle` FR/EN · preserve type video à l’hydrate |
| **Tests** | TESTS.md **R13** · LOCAL §4 · DEV D4 · PROD P4 |

### E12 — Saut anticipé en fin de titre (+ erreurs)
| | |
|--|--|
| **Status** | `fixed` — revalidé 2026-08-14 Android DEV/PROD (`1.3.18`) ; web à surveiller |
| **Cause** | Silence/lyrics-end skip trop agressif ; durée méta courte ; stream tronqué → `ended` sans retry |
| **Fix** | Skip seulement si ≤18 s restantes + RMS ; lyrics-end assoupli ; retry 1× si fin &lt; 88 % durée méta (web) |
| **Tests** | TESTS.md **R14** · LOCAL §4 · DEV D4 · PROD P4 |

---

## Session 2026-08-17 (502 stream, reprise file, shuffle, mails)

Télémetrie Nothing `p+1.3.18` : `71ad8024` (k1BneeJTDcU, 502 streak=4) · `2332b870` (HCgWWovlPVI, timeout 2002) · PDF `~/Téléchargements/plm-telemetry-71ad8024.pdf`.  
Perplexity a raison : **ExoPlayer 2004 = HTTP 502 du backend**, pas un codec.

### E14 — HTTP 502 / timeout sur `/api/stream` (prod)
| | |
|--|--|
| **Status** | `investigating` — OAuth TV VPS **connected** (17/08) + curl titres musicaux **206** ; reste smoke **Samsung PROD** + liaison Google **par user** si inscription ouverte (B4.24) |
| **Surfaces** | Android prod · API prod `ytmusic.delhomme.ovh` · DL offline |
| **Cause** | Reverse proxy / Innertube : YouTube bloque souvent l’IP Contabo (`LOGIN_REQUIRED`) → 502. DNS parfois `Unable to resolve host`. Timeouts = même chaîne (proxy attend trop longtemps). |
| **Symptômes** | `InvalidResponseCodeException: 502` · `SocketTimeoutException` · OfflineKeeper `DL retry HTTP 502` · lecture en pause · toast « connexion » trompeur |
| **Fix app** | Circuit-breaker immédiat sur 5xx ; 2 retries rapides puis **suivant** ; **pause** (plus de `stop()` qui vide la file) ; toast 502 ≠ Wi‑Fi ; OfflineKeeper capé ; mails avec pré-diagnostic |
| **Fix infra (toi)** | OAuth TV : [`docs/STREAM-VPS-OAUTH.md`](./docs/STREAM-VPS-OAUTH.md) · `curl -I` stream musical vs Rickroll · logs API au timestamp du mail |
| **Tests** | **R17** · DEV D8/D13 · PROD P8/P13 |

### E15 — File d’attente absente au relance / skip → « chargement de suggestion »
| | |
|--|--|
| **Status** | `fixed` (code) — à revalider Samsung DEV + Samsung PROD |
| **Surfaces** | Android |
| **Cause** | Restore `autoplay=false` préparait quand même le flux → 502 → `exo.stop()` **effaçait** les MediaItems. Skip sans suivant → fill autoplay (« Chargement des suggestions… ») puis titre suivant **sans audio**. |
| **Fix** | Restore sans `prepare()` ; skip reconstruit depuis `Holder.queue` si IDLE/vide ; `stop()` → `pause()` |
| **Tests** | **R18** · DEV D13 · PROD P13 |

### E16 — Shuffle biblio / playlist trop lent, titres suivants jamais chauds
| | |
|--|--|
| **Status** | `fixed` (code) — à revalider |
| **Surfaces** | Android biblio / playlist / album |
| **Cause** | `setMediaItems` 250 + warm 6 + **enqueueAhead immédiat** + OfflineKeeper 40 likes → saturation. 1er titre lent ; les autres n’ouvrent pas. |
| **Fix** | Fenêtre 80 ; ahead DL **après 8 s** de lecture réelle ; retries 5xx 140 ms ×2 ; skip auto au suivant |
| **Tests** | **R19** · DEV D6/D13 · PROD P6/P13 |

### E17 — Shuffle playlist : tous les titres en « téléchargement » ; cancel ne marche pas
| | |
|--|--|
| **Status** | `fixed` (code) — à revalider |
| **Surfaces** | Android |
| **Cause** | OfflineKeeper enfilait 40+12 DL sans que l’user clique ; 2ᵉ tap DL ignoré (`enabled = progress == null`) ; `.part` pas nettoyé à l’annulation UI |
| **Fix** | Tick like cap 8 ; cancel / cancelMany + suppression `.part` ; 2ᵉ tap = **annuler** ; DL parallèle Range (4 segments) type torrent |
| **Tests** | **R20** · DEV D7 · PROD P7 |

### E18 — Radio artiste ne démarre pas
| | |
|--|--|
| **Status** | `fixed` (code) — à revalider |
| **Surfaces** | Android page artiste |
| **Cause** | Attente du mix API complet avant le 1er play (timeout / vide) |
| **Fix** | Joue le seed (tops) **tout de suite**, append le mix ensuite (comme mix album) |
| **Tests** | **R21** · DEV D4 artiste · PROD P4 |

### E19 — Boutons biblio / follow sans état visuel plein vs creux
| | |
|--|--|
| **Status** | `fixed` (code) — à revalider |
| **Surfaces** | Android album (depuis artiste), artiste, sheet ⋮ |
| **Cause** | Même icône remplie pour on et off (seul le label changeait) |
| **Fix** | Off = `Outlined.*` (creux) · On = `*Check` / filled + rouge ; pastille album dans le shelf artiste |
| **Tests** | **R22** · DEV D4/D6 · PROD P4/P6 |

### E20 — Mails d’erreur trop bruts / parfois absents (streak=1)
| | |
|--|--|
| **Status** | `fixed` (code) — à revalider outbox |
| **Surfaces** | API telemetry · Android · web |
| **Cause** | `reportPlayerError` skip streak&lt;2 ; mail = stack brut ; throttle 90 s sans pré-diag |
| **Fix** | 5xx/timeout/DNS mail **dès la 1ʳᵉ** fois ; bloc **Pré-diagnostic** FR (famille, cause, actions) + compteur throttle ; subject = famille |
| **Tests** | **R17** · DEV D3 · PROD P3 |

### E21 — Erreurs mobile hors-ligne → mail jamais envoyé
| | |
|--|--|
| **Status** | `open` |
| **Surfaces** | Android (DEV + PROD) · `/api/telemetry` · SMTP |
| **Cause** | `TelemetryReporter` POST immédiat ; échec réseau → log `upload failed` et **drop**. Pas de persistance. |
| **Attendu** | Dès l’erreur : écrire un **résumé compact** sur disque. Au retour réseau : **un** flush de **tout** le cumul (pas N jobs qui s’enchaînent). Serveur : **un** mail digest. Invisible UX, budget RAM/réseau minuscule (STATUS **B4.22**). |
| **Pas ça** | File de coroutines « en attente d’envoi » ; un mail par event ; dumps AppLog × N ; retry agressif. |
| **STATUS** | **B4.22** |
| **Tests** | **R23** · DEV D3 · PROD P3 |

### E22 — Force-stop : file restaurée, Play / Suivant sans audio
| | |
|--|--|
| **Status** | `open` |
| **Surfaces** | Android |
| **Symptôme** | Kill forcé → rouvrir : mini-lecteur + file **OK** (`LocalPlaybackStore`). Clic **Play** : le titre courant **ne part pas**. **Suivant** non plus, alors que les titres suivants sont bien ceux d’avant. |
| **Piste** | Restore `autoplay=false` sans MediaItems Exo ; `Holder.queue` vs UI ; skip retombe sur « chargement de suggestion ». Lié E15 (là la file était vidée ; ici la file reste, l’audio non). |
| **STATUS** | **B4.23** |
| **Tests** | **R18** / **R24** · DEV D13 · PROD P13 — **Samsung** |

---

## Session 2026-08-20 (UX prod Nothing + lecteur)

**Envs** : local `d+1.3.37` · prod `p+1.3.37` · Nothing Wi‑Fi · Blackview USB · Samsung ADB absent (ping OK)

### E23 — Ajouter à une playlist : « 0 titres » affiché
| | |
|--|--|
| **Status** | `fixed` (code) — `resolvedTrackCount()` |
| **Surfaces** | Android (sheet Ajouter) |
| **Cause** | UI utilise `pl.tracks?.size` alors que la biblio light a `tracks: []` + `trackCount` |
| **Fix** | `pl.resolvedTrackCount()` |
| **Tests** | Nothing PROD · Samsung DEV · Blackview USB |

### E24 — Téléchargement bloqué à 2 %
| | |
|--|--|
| **Status** | `fixed` (code) — enqueue utilisateur `duringPlaybackSafe=true` |
| **Surfaces** | Android (page artiste / ⋮) |
| **Cause** | `enqueue` attend fin de lecture (`duringPlaybackSafe=false`) et reste à progress `0.02` |
| **Fix** | Téléchargements utilisateur autorisés pendant la lecture |
| **Tests** | DL pendant lecture · artiste · album |

### E25 — Partage = lien YouTube Music
| | |
|--|--|
| **Status** | `fixed` (code) — `/watch/:id` PLM |
| **Surfaces** | Android + web |
| **Fix** | URL app `/watch/:id` (et album/artist/playlist PLM) |
| **Tests** | Share sheet · ouverture lien web |

### E26 — Contrôles play/prev/next absents quand file ouverte / scroll
| | |
|--|--|
| **Status** | `fixed` (code) — barre sticky file expandue |
| **Surfaces** | Android Now Playing |
| **Fix** | Barre transport compacte sticky au-dessus de la file expandue |
| **Tests** | Scroll file · onglet Similaires |

### E27 — Boucle fin de chunk / coda (prod)
| | |
|--|--|
| **Status** | `fixed` (code) — `shouldRetryEndedAsTruncated` refuse le retry si Exo a vraiment terminé le fichier |
| **Surfaces** | Android |
| **Cause** | Catalogue YTM plus long que le flux → retry rejouait la coda |
| **Fix** | `mediaItemActuallyEnded` → enchaîner sans rebind |
| **Tests** | Marathon EOS Samsung DEV · Blackview · Nothing après deploy |

### E28 — Égaliseur dans le ⋮ de n’importe quel titre
| | |
|--|--|
| **Status** | `fixed` (code) — EQ lecteur only + icônes Activer/Reset |
| **Surfaces** | Android · web |
| **Fix** | EQ uniquement depuis le lecteur en cours ; boutons Activer / Reset icônes seuls |
| **Tests** | ⋮ titre hors lecture → pas d’EQ · Now Playing → EQ + Reset |

### E29 — Paroles désynchronisées / pas d’auto-sync
| | |
|--|--|
| **Status** | `fixed` (code) — lead 0 + recentrage auto · lag LRCLIB 1,2 s |
| **Surfaces** | Android (web à surveiller) |
| **Fix** | lead 0 · lag LRCLIB · recentrage auto sur la ligne active |
| **Tests** | Paroles pendant lecture · seek · changement de titre |

### E30 — Contamination `d+` sur APK prod (build joint)
| | |
|--|--|
| **Status** | `fixed` (code) — canal / API par flavor Gradle |
| **Surfaces** | Android build |
| **Cause** | `defaultConfig` unique : assembleDev+Prod → LAN partout → `d+` sur prod |
| **Fix** | `productFlavors` prod=`p+`+HTTPS · dev=`d+`+LAN |
| **Tests** | `assembleDevDebug assembleProdDebug` → badging `d+` / `p+` |

### E31 — Auto-play à la réouverture de l’app
| | |
|--|--|
| **Status** | `fixed` (code) — restore file en pause |
| **Surfaces** | Android (hydrate local / remote) |
| **Cause** | `autoplay = local.wasPlaying` (et remote active) relançait le son |
| **Fix** | Toujours `autoplay=false` à l’hydrate — file + position + titres gardés |
| **Tests** | Kill app → réouvrir → mini-lecteur en pause · play manuel OK |

### E32 — Historique d’écoute incomplet / pas par date
| | |
|--|--|
| **Status** | `fixed` (code) — `/api/history/detailed` enrichi + UI par jour |
| **Surfaces** | Android HistorySheet · API |
| **Fix** | Événements start/partial/complete/skip groupés par date · progress ≥5 % → history |
| **Tests** | Compte → Historique · plusieurs jours · badges Complet/Partiel/Skip |

### E33 — Scroll file d’attente → lecteur se réduit / se referme
| | |
|--|--|
| **Status** | `fixed` (code) — overscroll file ne shrink plus le Now Playing |
| **Surfaces** | Android NowPlayingScreen (aperçu + file expandue) |
| **Cause** | `collapseWhenTop` + nested scroll dismiss : pull en haut de liste → `queueProgress` partiel (« petit lecteur ») |
| **Fix** | Plus de collapse via scroll liste · snap binaire 0/1 · aperçu consomme l’overscroll (pas de dismiss) |
| **Tests** | Ouvrir file · scroller haut/bas · rester plein · repli seulement chevron/poignée |

### E34 — Paroles : 1ʳᵉ lettre coupée (encoche / bords)
| | |
|--|--|
| **Status** | `fixed` (code) — padding + plus de scaleX |
| **Surfaces** | Android InlineSyncedLyrics |
| **Cause** | `scaleX/Y 1.04` + padding 14 dp → clip gauche sur Samsung/Blackview |
| **Fix** | Padding 22 dp · pas de scale · softWrap |
| **Tests** | Paroles sync · ligne active · punch-hole |

### E26b — Transport absent au-dessus de la file (régression layout)
| | |
|--|--|
| **Status** | `fixed` (code) — header file collé à la liste |
| **Surfaces** | Android NowPlayingScreen file expandue |
| **Cause** | Header transport en overlay Box séparé du body → souvent masqué / hors flux |
| **Fix** | Column unique : transport sticky + titre + LazyColumn file |
| **Tests** | Ouvrir file · play/prev/next visibles · scroll liste garde les boutons |

### E35 — Paroles totalement désync vs audio
| | |
|--|--|
| **Status** | `fixed` (code) — sync recalibré Android + web |
| **Surfaces** | Android InlineSyncedLyrics · web NowPlaying |
| **Cause** | Ligne 0 forcée en intro + lag LRCLIB client 1,2–2 s empilé sur offset API |
| **Fix** | Pas de highlight avant 1ʳᵉ ligne · lead 350 ms · lag LRCLIB 300 ms · cache v3 |
| **Tests** | Vie d’artiste · Trop tôt/Trop tard · intro sans fausse ligne |

### E36 — Sync paroles : rythme qui dérive / besoin de recalage manuel
| | |
|--|--|
| **Status** | `fixed` (code) — calage appui long + nudges fins |
| **Surfaces** | Android · web paroles |
| **Fix** | Appui long = « cette ligne est chantée maintenant » · −1 s / Trop tôt / Trop tard / +1 s · Reset · persisté par titre |
| **Tests** | Dérive mid-track · long-press · reset |

### E37 — Crash prod : ExoPlayer `wrong thread` (OfflineDownloadManager)
| | |
|--|--|
| **Status** | `fixed` (code) — flag `playbackActive` + try/catch |
| **Surfaces** | Android OfflineDownloadManager · Nothing p+1.3.31 logs |
| **Cause** | `player.isPlaying` depuis `Dispatchers.IO` dans `enqueueAhead` |
| **Fix** | `Holder.isPlaybackActiveSafe()` (volatile, MAJ thread main) · jamais toucher Exo depuis IO |
| **Tests** | Lecture + DL offline · pas de crash wrong-thread |

### E38 — Journal debug : vieux en haut
| | |
|--|--|
| **Status** | `fixed` (code) — `recentLogText(newestFirst=true)` |
| **Surfaces** | Android DebugLogsScreen · AppLog |
| **Fix** | Inversion des lignes : plus récent en haut |

### E39 — Sync paroles encore mauvaise (web + mobile)
| | |
|--|--|
| **Status** | `fixed` (code) — stretch durée API v6 · lag client 0 |
| **Surfaces** | API `alignTimedToTrack` · web lyricSync · Android |
| **Fix** | Étirement linéaire LRC→durée YT · plus de lag client LRCLIB · lead 120 ms · cache v4/v6 |
| **Tests** | Vie d’artiste web+Android · appui long si résidu |

### E40 — Mode économiseur batterie système
| | |
|--|--|
| **Status** | `fixed` (code) — `BatterySaver` suit PowerManager |
| **Surfaces** | Android (pochettes, prefetch, OfflineKeeper) |
| **Fix** | Si économiseur OS ON : placeholders listes, prefetch stream ×1, OfflineKeeper pause, covers warm OFF |
| **Tests** | Activer économiseur Android · scroll home · lecture continue · logs « BatterySaver ON » |

---

## OK constatés (ne pas réouvrir sans nouveau signal)

| Check | Local | Prod | Samsung | Nothing |
|-------|:-----:|:----:|:-------:|:-------:|
| Health | ✅ | ✅ `a481e3b` | — | — |
| Login seed | ✅ | ✅ | apps UP | apps UP |
| Search 5 artistes | ✅ | ✅ | — | — |
| Artist page | ✅ (0.5–6 s) | ✅ | — | — |
| Related ×5 titres | ✅ ~1–2 s | ✅ | — | — |
| Stream Range 5× parallel | ✅ 206 | ✅ 206 (tunnel) | — | — |
| Playlist `trackCount` int | ✅ | ✅ (Chill House=82) | pas de crash Moshi | pas de crash Moshi |
| Logcat FATAL / trackCount | — | — | ✅ clean | ✅ clean |

---

## Comment ajouter une erreur

1. ID `E#` incrémental  
2. Status + surfaces + repro + piste  
3. Lier un item `STATUS.md` (`B*.*`)  
4. Quand fixé : `fixed` + commit/SHA + cocher pipeline STATUS  

```bash
# Relancer la batterie API
node scripts/test/smoke-load-test.mjs both
```
