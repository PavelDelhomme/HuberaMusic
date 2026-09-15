# Lien écosystème Cloudity Suite (PLM / YTMusic)

> Fiche satellite — **ne modifie pas** le runtime ni le volume `ytmusic_ytmusic_data`.

## Identité

- Repo GitHub : `PavelDelhomme/YTMusic`
- Marque produit : **PLM** (domaines `plm.delhomme.ovh` + alias `ytmusic.delhomme.ovh`)
- Branche de travail habituelle : `dev`

## Rapport complet

Voir dans Cloudity : `ECOSYSTEME-SUITE-MODULAIRE.md` (v2) —
https://github.com/PavelDelhomme/Cloudity/blob/dev/ECOSYSTEME-SUITE-MODULAIRE.md

## Données utilisateurs (critique)

Volume VPS **`ytmusic_ytmusic_data` ≈ 20,6 Go** (monté `/app/data`).

**Interdit** : Remove volumes / `down -v` / migration monorepo qui recrée un volume vide.

SSO Cloudity ID futur = **opt-in** en parallèle du login actuel.

## Cursor / déploiement

- Unitaire : ouvrir `…/Perso/YTMusic` seul.
- Portainer / compose : stack `ytmusic` indépendante de Cloudity.

## Décisions

Voir §17 du rapport Cloudity avant toute implémentation cross-suite.
