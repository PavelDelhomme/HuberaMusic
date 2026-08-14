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
| **Status** | `open` |
| **Surfaces** | API local **et** prod |
| **Mesure** | `/api/artist/:id/radio` → 200 titres en **47–75 s** (Stromae, Daft Punk, Sia, Bo Burnham, Suzane) |
| **Impact** | Mix / radio depuis page artiste = UX bloquante |
| **Piste** | Preview rapide + fill progressif (comme mixes) ; cache ; plafonner workers YT |
| **STATUS** | nouveau → **B7.2** |

### E3 — Reco radio seed « chill » vide
| | |
|--|--|
| **Status** | `open` |
| **Surfaces** | local + prod |
| **Mesure** | `GET /api/reco/radio?seed=chill&preview=1` → `tracks: []` en <50 ms |
| **Impact** | Mixes type nouveauté / seed texte peuvent rester vides (lié B2.5) |
| **STATUS** | **B2.5** |

### E4 — Library GET encore lourd (~2.4–3.2 s)
| | |
|--|--|
| **Status** | `open` (amélioré playlists light, reste songs/liked) |
| **Surfaces** | local 2422 ms (155 songs) · prod 3222 ms (189 songs) |
| **Piste** | pagination / endpoint songs light + hydrate détail ; cache ETag |
| **STATUS** | **B1.1** |

### E5 — Warm batch stream lent sous charge (prod)
| | |
|--|--|
| **Status** | `open` |
| **Surfaces** | prod |
| **Mesure** | `POST /api/stream/warm` 5 ids → **~16 s** après rafale streams |
| **Piste** | file d’attente warm côté API, timeout court, ne pas bloquer UI |
| **STATUS** | **B7.3** |

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
