# ERRORS.md — erreurs & dettes à résoudre

> Journal des problèmes constatés en test (API / web / Android).  
> **Ne pas effacer** une entrée tant qu’elle n’est pas `done`.  
> Lien pipeline : [`STATUS.md`](./STATUS.md) · campagnes : [`TESTS.md`](./TESTS.md).  
> Smoke automatisé : `node scripts/smoke-load-test.mjs both` → `logs/smoke-*.json`.

**Légende** : `open` · `investigating` · `fixed` · `wontfix`

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
node scripts/smoke-load-test.mjs both
```
