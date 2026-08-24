# Migration domaine → `plm.delhomme.ovh`

## Objectif

URL **canonique** utilisateur : **`https://plm.delhomme.ovh`**.  
`https://ytmusic.delhomme.ovh` reste un **alias** (redirection NPM invisible / même backend) le temps que toutes les apps installées basculent.

État DNS (2026-08-24) : les deux hôtes répondent déjà `200` sur le même VPS — la bascule code + Passkeys + APK est le vrai travail.

## Phases (ne pas fusionner)

### Phase 0 — Préparer (sans casser les APK existantes)

1. Activer **mode maintenance** Admin (message + durée auto) si cutover risqué.
2. CORS / Passkeys : accepter **les deux** origines (`plm` + `ytmusic`) dans Portainer :
   - `APP_URL=https://plm.delhomme.ovh`
   - `WEBAUTHN_RP_ID=plm.delhomme.ovh` **ou** dual-origin selon implémentation
   - `CORS_ORIGINS` inclut les deux HTTPS
3. Android Manifest + `AppDeepLinks` : hosts **plm** + **ytmusic** (+ `pue-la-merde`).
4. NPM : proxy `ytmusic` → même stack que `plm` (ou redirect 301/308 si tu préfères visible).

### Phase 1 — Canonique plm (web + API)

1. Portainer : `APP_URL` / `WEBAUTHN_ORIGIN` → `https://plm.delhomme.ovh`.
2. Rebuild image `:prod` après merge.
3. Vérifier login, passkeys, stream, Admin sur **plm**.
4. Vérifier que **ytmusic** alias marche toujours (apps anciennes).

### Phase 2 — APK

1. Flavor prod bake `API_BASE_URL=https://plm.delhomme.ovh`.
2. Publier APK ; utilisateurs MAJ via ticket / in-app (**latest only**).
3. Tant que des devices sont sur `ytmusic` dans le binaire : **ne pas** couper l’alias.

### Phase 3 — Nettoyage (plus tard)

1. Quand télémétrie montre quasi-tous sur `plm` : retirer hardcodes `ytmusic` des docs / defaults.
2. Optionnel : redirect HTTP 301 ytmusic → plm (au lieu d’invisible).

## Mode maintenance

- Admin → toggle **Maintenance** + message + « jusqu’à » (auto-off).
- Clients (web / Android / desktop) affichent le bandeau / écran et peuvent bloquer lecture si `blockPlayback=true`.
- Sert aussi pour migrations DNS, OAuth, incidents stream.

## Mobile déjà installées

Ne **jamais** changer uniquement le DNS sans dual-host : les APK `p+` ont l’URL API compilée. Ordre = dual support → nouvelle APK → puis éventuellement retirer l’ancien hôte.

## Hors scope immédiat

- Renommer le dépôt GitHub `YTMusic`
- Changer le package Android `ovh.delhomme.ytmusic`
