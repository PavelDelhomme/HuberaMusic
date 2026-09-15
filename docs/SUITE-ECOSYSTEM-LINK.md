# Lien écosystème Cloudity Suite (PLM / YTMusic)

> Fiche satellite — **ne modifie pas** le runtime ni le volume `ytmusic_ytmusic_data`.

## Identité

- Repo GitHub : `PavelDelhomme/YTMusic`
- Sous Cloudity : `products/YTMusic` (submodule, branche `dev`)
- Clone Perso : `…/Perso/YTMusic` (même remote Git)
- Marque produit : **PLM** (`plm.delhomme.ovh` + alias `ytmusic.delhomme.ovh`)

## Données utilisateurs (critique)

Volume VPS **`ytmusic_ytmusic_data` ≈ 20,6 Go**.

**Interdit** : Remove volumes / `down -v` / fusion monorepo des données.

SSO Cloudity ID futur = **opt-in** en parallèle du login actuel.

## Cursor

```bash
# Suite
cursor /home/pactivisme/Documents/Dev/Perso/Cloudity/Cloudity/Cloudity.code-workspace
# Unitaire
cd …/Cloudity/Cloudity/products/YTMusic && cursor .
```

## Déploiement

Stack Portainer **`ytmusic`** indépendante — inchangée par le meta-repo Cloudity.
