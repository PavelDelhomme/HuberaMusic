# ERRORS.md — erreurs & dettes à résoudre

> Journal des problèmes constatés en test (API / web / Android).  
> **Ne pas effacer** une entrée tant qu’elle n’est pas `done`.  
> Lien pipeline : [`STATUS.md`](./STATUS.md) · campagnes : [`TESTS.md`](./TESTS.md).  
> Smoke automatisé : `node scripts/test/smoke-load-test.mjs both` → `logs/smoke-*.json`.

**Légende** : `open` · `investigating` · `fixed` · `wontfix`

---

## Session 2026-08-12 (fin de titre = fausse erreur réseau)

### E13 — Fin de titre → « réseau instable » / file stoppée (prod mobile)
| | |
|--|--|
| **Status** | `fixed` — revalidé 2026-08-14 Samsung DEV + Nothing PROD (`d+/p+1.3.18`) |
| **Surfaces** | Android prod (surtout) · web |
| **Cause** | En fin de piste, googlevideo coupe souvent la connexion → Exo/`audio.error` classé **network** → toast « Réseau instable » / « Connexion perdue » + circuit-breaker → **pas de titre suivant** alors que le Wi‑Fi est OK |
| **Fix** | Si `pos/dur ≥ 88 %` (ou &lt; 5 s restantes) : traiter comme **EOS**, enchaîner le suivant, **sans** incrémenter le streak réseau. Mid-piste : toast « Reprise du flux… » + re-resolve `/url` + proxy frais |
| **Tests** | R14 / R15 · DEV D* lecture longue · PROD Samsung + Nothing · web prod |

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
| **Status** | `fixed` (code) — à revalider Samsung DEV + Nothing PROD |
| **Surfaces** | Android (Samsung, Nothing, …) · API WebAuthn |
| **Cause** | `authenticatorAttachment: 'platform'` excluait Bitwarden ; bouton login caché sans flag local ; `allowCredentials: []` si 0 creds ; assetlinks package `.dev` manquant |
| **Fix** | Retrait attachment platform · discoverable auth · bouton passkey toujours visible · assetlinks prod+`.dev` · queries Bitwarden · Credential Manager 1.5 · messages d’erreur explicites |
| **Repro** | Login Android → Continuer avec passkey → feuille Bitwarden ; Compte → Enregistrer une passkey |
| **Tests** | TESTS.md **R7** · LOCAL §1 · DEV D1 · PROD P1 |

### E8 — Paroles synchronisées trop en avance (1–2 lignes)
| | |
|--|--|
| **Status** | `fixed` (code) — à revalider web + Samsung + Nothing |
| **Surfaces** | web · Android · API lyrics |
| **Cause** | Timed YouTube parfois écrasé par LRCLIB ; LRC studio vs clip YT ; lead trop faible |
| **Fix** | Pas d’écrasement YTM · align durée LRCLIB · lag LRCLIB 2 s · lead 0,5 s · Trop tôt/tard · cache `v4` |
| **Repro** | Keny *Capitale de la rupture* / *Vie d’artiste* ; karaoké ~0,5 s d’avance |
| **Tests** | TESTS.md **R8** · LOCAL §4 · DEV D5 · PROD P5 |

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
