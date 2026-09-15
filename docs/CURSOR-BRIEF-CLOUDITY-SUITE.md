# Brief Cursor — intégrer ce produit dans l’écosystème Cloudity

> **À coller / `@` dans un chat Cursor** ouvert sur JobbingTrack, GasoilTracking, YTMusic/PLM, ou Cloudity.  
> Objectif : développer **dans** l’écosystème Cloudity (seul ou multi-root), **sans perdre** données utilisateurs ni casser Portainer.

---

## 1. Contexte en 10 lignes

- **Cloudity** = suite (auth, mail, drive, pass, agenda, notes, tasks, contacts, photos) + hub web.  
  Chemin monorepo : `/home/pactivisme/Documents/Dev/Perso/Cloudity/Cloudity`
- **Satellites** (repos Git **dédiés**, aussi visibles sous `Cloudity/products/` en submodule) :
  - JobbingTrack → `products/jobbing-track/` (intégré en premier)
  - GasoilTracking → `products/GasoilTracking/` (à venir)
  - YTMusic/PLM → `products/YTMusic/` (à venir, **ne pas casser** le volume ~20 Go)
- On développe **soit** le produit seul, **soit** toute la suite via `Cloudity.code-workspace`.
- Déploiement VPS = **Portainer Git**, stacks **séparées**, volumes Docker **noms stables**.
- SSO « Cloudity ID » = **opt-in** plus tard ; auth locale de chaque app **reste**.

---

## 2. Comment ouvrir le projet dans Cursor

### Unitaire (recommandé au quotidien)

```bash
# JobbingTrack via submodule Cloudity
cd /home/pactivisme/Documents/Dev/Perso/Cloudity/Cloudity/products/jobbing-track
cursor .

# OU ancien chemin (tant qu’il existe encore)
cd /home/pactivisme/Documents/Dev/Perso/JobbingTrack
cursor .
```

### Global (suite)

```bash
cd /home/pactivisme/Documents/Dev/Perso/Cloudity/Cloudity
cursor Cloudity.code-workspace
```

Les commits doivent aller dans le **bon repo** (submodule = repo JobbingTrack, racine = repo Cloudity).

```bash
# Depuis Cloudity monorepo : maj pointeur submodule après commit JT
cd products/jobbing-track
git checkout dev
# ... commits JT ...
git push origin dev
cd ../..
git add products/jobbing-track
git commit -m "chore: bump jobbing-track submodule"
git push
```

---

## 3. Règles absolues (données & prod)

| Faire | Ne jamais faire |
|-------|-----------------|
| Backup volume avant manip VPS | `docker compose down -v` |
| Redeploy Portainer **sans** Remove volumes | Renommer un volume Docker à la volée |
| Garder stacks séparées (cloudity / JT prod / JT preprod / gasoil / ytmusic) | Fusionner toutes les DB dans un seul Postgres « pour simplifier » sans plan |
| SSO opt-in | Forcer migration comptes existants |
| Améliorer Cloudity **en s’inspirant** du code JT (patterns, monitoring) | Copier-coller half-baked JT dans `backend/` Cloudity |

### Volumes critiques (VPS Contabo)

- JobbingTrack prod : `jobbingtrack-prod_postgres_data`
- JobbingTrack preprod : `jobbingtrack-preprod_postgres_data`
- Gasoil : `gasoil_api_data` (~9 Go)
- PLM/YTMusic : `ytmusic_ytmusic_data` (~21 Go)
- Cloudity : `cloudity_postgres_data`, `cloudity_mobile_data`

---

## 4. Ce que « intégrer dans Cloudity » veut dire (et ne veut pas dire)

### Oui

1. Le code JT est **clonable / ouvrable** sous `Cloudity/products/jobbing-track` (submodule).  
2. Workspace Cursor multi-root.  
3. Plus tard : tuile hub Cloudity + OIDC + éventuellement Mail/Agenda (scopes).  
4. Réutiliser de JT vers Cloudity : idées monitoring, Makefile ops, patterns microservices — via **extraits / libs**, pas un big merge.  
5. Mises à jour **par produit** (image GHCR / tag) avec un **orchestrateur** éventuel (Watchtower filtré, ou script `suite-update`) qui respecte chaque app.

### Non

1. Un seul conteneur monolithique.  
2. Perdre preprod JT ou forcer une seule DB.  
3. Casser le fonctionnement actuel de YTMusic/PLM « pour aligner ».  
4. Plus de 5 versions d’API **lourdes** en parallèle sur le serveur sans budget disque/RAM (voir §6).

---

## 5. Apports croisés (quoi prendre de chaque app)

| Source | Apport potentiel à Cloudity / suite |
|--------|-------------------------------------|
| **JobbingTrack** | Beaucoup de microservices Node ; monitoring ; preprod+prod ; mobile Flutter ; triage email (à brancher plus tard sur Cloudity Mail) |
| **GasoilTracking** | Trajets GPS, UX mobile Expo → alimentera **Cloudity Maps** |
| **YTMusic/PLM** | Offline, cache média, OTA — **garder le comportement** ; brancher SSO progressivement |
| **Cloudity** | Auth JWT/2FA, gateway Go, design system `@cloudity/ui`, hub apps |

---

## 6. Serveur Contabo — perf & versions (constat + reco)

Mesures indicative (2026-09-15) : **~29 Go RAM**, **~7 Go used**, disque **~43 %** (478 Go / 1,2 To).  
**JobbingTrack prod + preprod** = double flotte de services (~60–80 conteneurs suite+JT) → **gros levier** : éteindre preprod hors usage, mutualiser Redis/limites mémoire.

Recommandations Cursor/ops :

1. Ne pas lancer preprod JT 24/7 si inutile.  
2. Limiter tags d’images API gardés sur le VPS (≤ 5 tags « actifs » hors prod, sauf si cache user &gt; 1 Go/user → purge).  
3. Watchtower / updates : **labels par stack**, jamais un pull all destructif.  
4. YTMusic : garder limite mémoire (~3 Go déjà) ; ne pas dupliquer le volume data.

---

## 7. Checklist agent Cursor (quand on te demande d’avancer)

1. Confirmer le repo ouvert (Cloudity racine vs `products/jobbing-track`).  
2. Ne pas toucher aux volumes / `.env` prod sans backup.  
3. Si changement JT : commit **dans le submodule**, puis bump pointeur dans Cloudity.  
4. Si changement suite Cloudity : ne pas casser les builds GHCR existants.  
5. Toute idée SSO / Mail : feature flag / opt-in.  
6. Documenter dans `docs/` du produit concerné, pas un nouveau roman à la racine GitHub.

---

## 8. Fichiers de référence

| Fichier | Rôle |
|---------|------|
| `docs/ecosystem/ECOSYSTEME-SUITE-MODULAIRE.md` | Rapport long (aussi en PDF) |
| `products/README.md` | Carte des submodules |
| `Cloudity.code-workspace` | Ouverture multi-root |
| `docs/INDEX.md` | Index doc Cloudity |
| `products/jobbing-track/docs/SUITE-ECOSYSTEM-LINK.md` | Fiche satellite JT |

---

## 9. Prochaine étape humaine (pas encore codée)

- Décisions naming / SSO / Maps (voir rapport PDF).  
- Submodule Gasoil + PLM quand JT est stable dans le workspace.  
- Script VPS `backup-suite-volumes.sh`.  
- identity-sdk réel.

**Fin du brief — garder ce fichier à jour si la structure `products/` évolue.**
