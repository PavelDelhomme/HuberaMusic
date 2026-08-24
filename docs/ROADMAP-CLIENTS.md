# Roadmap clients PLM

Ordre de livraison des clients natifs / desktop. Ne pas inverser sans décision explicite.

| Priorité | Plateforme | État (2026-08-24) | Notes |
|----------|------------|-------------------|--------|
| 1 | **Android** | En cours / prod `p+` | Lecteur Media3, offline, MAJ in-app — priorité bugs stream |
| 2 | **Web / PWA** | Prod | `plm.delhomme.ovh` (canonique) + alias `ytmusic.delhomme.ovh` |
| 3 | **Linux (desktop)** | Shell Electron basique | Emballage AppImage + URL prod ; MAJ = rechargement web / rebuild AppImage |
| 4 | **Windows** | Prévu **après** Linux stable | Même shell Electron / installer NSIS — pas avant |
| 5 | **iOS** | Plus tard | Après Android + Web + Linux complets |
| 6 | **macOS** | Plus tard | Avec ou juste après iOS (même famille Apple) |

## Règles

- Pas de chantier Windows / iOS / macOS tant que **Android + Web + Linux** ne sont pas « complets » (lecture fiable, MAJ, auth).
- Linux : préférer un **shell autour de la PWA prod** (toujours à jour côté UI) plutôt qu’un second runtime audio local.
- Windows : « dans le principe » seulement pour l’instant — pas de dette à ouvrir.

## Liens

- Identité / domaine : [`PLM.md`](./PLM.md) · migration : [`DOMAIN-PLM-MIGRATION.md`](./DOMAIN-PLM-MIGRATION.md)
- Desktop : [`../desktop/`](../desktop/) · README racine § Desktop
- Suivi bugs : [`../STATUS.md`](../STATUS.md) · [`../ERRORS.md`](../ERRORS.md)
