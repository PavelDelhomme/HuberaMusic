# PLM — identité et nommage

## Nom public

| Contexte | Nom à utiliser |
|----------|----------------|
| UI utilisateur (web, mobile, PWA, notifications) | **PLM** |
| Sous-titre / accroche (optionnel) | « Musique sans pubs » — pas le nom complet en gros |
| Emails télémétrie / rapports | **PLM** (expéditeur normalisé depuis `SMTP_FROM`) |
| Nom complet du projet | **PueLaMerde** — **documentation et historique uniquement**, jamais en titre principal |

## Ce qui reste « YTMusic » (volontaire)

| Élément | Raison |
|---------|--------|
| Dépôt Git / GitHub `YTMusic` | Renommage repo prévu plus tard, quand prod + dev seront stables |
| Package Android `ovh.delhomme.ytmusic` | Identifiant installé ; migration = nouvelle app sur le téléphone |
| Domaine prod `ytmusic.delhomme.ovh` | DNS / certificats / passkeys déjà en place |
| Import bibliothèque Google | L’utilisateur lie son **compte YouTube Music** (service Google) — ce n’est pas le nom de PLM |
| Préfixes techniques `ytm_`, `Ytm*`, cookies YTM | Interne API / sync |

## Aliases DNS (redirect)

- `plm.delhomme.ovh` → prod PLM  
- `pue-la-merde.delhomme.ovh` → prod PLM  

L’URL canonique documentée reste `https://ytmusic.delhomme.ovh` tant que le repo n’est pas renommé.

## Flavors Android

| Flavor | Package | Label launcher | Préfixe version |
|--------|---------|----------------|-----------------|
| **prod** | `ovh.delhomme.ytmusic` | PLM | `p+` |
| **dev** | `ovh.delhomme.ytmusic.dev` | PLM Dev | `d+` |

## Règle pour les contributions

- Tout texte **visible par l’utilisateur** → **PLM**.  
- Commentaires de code / chemins package → inchangés tant que la migration package n’est pas faite.  
- Docs : titre **PLM** ; mention « PueLaMerde » seulement dans l’historique ou ce fichier.
