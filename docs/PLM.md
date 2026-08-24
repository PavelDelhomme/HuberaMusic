# PLM — identité et nommage

## Nom public

| Contexte | Nom à utiliser |
|----------|----------------|
| UI utilisateur (web, mobile, PWA, notifications) | **PLM** |
| Sous-titre / accroche (optionnel) | « Musique sans pubs » — pas le nom complet en gros |
| Emails télémétrie / rapports | **PLM** (expéditeur normalisé depuis `SMTP_FROM`) |
| Nom complet du projet | **PueLaMerde** — **documentation et historique uniquement**, jamais en titre principal |

## Domaine (canonique)

| Hôte | Rôle |
|------|------|
| **`plm.delhomme.ovh`** | **Canonique** (web, API, Passkeys cibles, docs) |
| `ytmusic.delhomme.ovh` | Alias / rétrocompat APK anciennes (NPM → même stack) |
| `pue-la-merde.delhomme.ovh` | Alias historique |

Migration détaillée : [`DOMAIN-PLM-MIGRATION.md`](./DOMAIN-PLM-MIGRATION.md) · mode maintenance Admin.

## Ce qui reste « YTMusic » (volontaire)

| Élément | Raison |
|---------|--------|
| Dépôt Git / GitHub `YTMusic` | Renommage repo prévu plus tard, quand prod + dev seront stables |
| Package Android `ovh.delhomme.ytmusic` | Identifiant installé ; migration = nouvelle app sur le téléphone |
| Import bibliothèque Google | L’utilisateur lie son **compte YouTube Music** (service Google) — ce n’est pas le nom de PLM |
| Préfixes techniques `ytm_`, `Ytm*`, cookies YTM | Interne API / sync |

## Flavors Android

| Flavor | Package | Label launcher | Préfixe version |
|--------|---------|----------------|-----------------|
| **prod** | `ovh.delhomme.ytmusic` | PLM | `p+` |
| **dev** | `ovh.delhomme.ytmusic.dev` | PLM Dev | `d+` |

## Clients (ordre)

Voir [`ROADMAP-CLIENTS.md`](./ROADMAP-CLIENTS.md) : Android → Web → **Linux** → Windows → iOS / macOS.

## Règle pour les contributions

- Tout texte **visible par l’utilisateur** → **PLM**.  
- Commentaires de code / chemins package → inchangés tant que la migration package n’est pas faite.  
- Docs : titre **PLM** ; mention « PueLaMerde » seulement dans l’historique ou ce fichier.
