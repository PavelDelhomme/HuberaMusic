# Migration SQLite → PostgreSQL (zéro perte)

## Pourquoi

La prod utilisait un fichier SQLite (`/app/data/ytmusic.db` sur le volume Docker
`ytmusic_data`). Postgres 16 apporte backups standards, accès concurrent, et un
réseau Docker interne (pas d’exposition publique).

## Architecture

| Volume | Contenu |
|--------|---------|
| `ytmusic_data` | Fichiers : cache audio, APK, cookies, **backup SQLite** |
| `ytmusic_pg_data` | Données Postgres uniquement |

`DATABASE_URL` vide → l’API reste sur SQLite (rollback immédiat).  
`DATABASE_URL=postgres://…` → backend Postgres ([`api/src/library/pgDb.ts`](../api/src/library/pgDb.ts)).

## Prérequis

- Image API qui contient `api/migrations/001_init.sql` + `pg` + `make-synchronous`
- Mot de passe fort `POSTGRES_PASSWORD`
- **Ne jamais** cocher « Remove volumes » dans Portainer

## Procédure cutover (prod)

### 1. Backup froid SQLite (obligatoire)

Sur le VPS / via SSH dans le volume :

```bash
# Depuis le repo (ou docker exec + sqlite3)
bash scripts/db/backup-sqlite.sh
# → data/backups/ytmusic-YYYYMMDD….db (+ .counts.txt)
```

Copier le `.db` hors du serveur (scp). Garder `JWT_SECRET` inchangé (données
`ytm_accounts.*_enc`).

### 2. Démarrer Postgres (sans cutover app)

```bash
# Compose : profil optionnel (n’affecte pas le redeploy SQLite actuel)
docker compose --profile postgres up -d postgres
```

Dans Portainer : déployer le service `postgres` + volume `ytmusic_pg_data`.  
Laisser `DATABASE_URL` **vide** sur `ytmusic` pour l’instant (app toujours SQLite).

### 3. Import

```bash
export DATABASE_URL='postgres://ytmusic:SECRET@postgres:5432/ytmusic'
# Si script lancé hors réseau Docker, utiliser le port publié en lab local.
node scripts/db/sqlite-to-pg.mjs --sqlite /chemin/ytmusic.db
node scripts/db/verify-pg.mjs --sqlite /chemin/ytmusic.db
```

Stopper l’écriture (maintenance courte) juste avant l’import si possible :
redeploy en pause / fenêtre 2–5 min.

### 4. Cutover

1. Vérifier `verify-pg.mjs` = ✅
2. Login spot-check + playlist J’aime sur un compte réel (contre PG via tunnel)
3. Définir `DATABASE_URL` sur le service `ytmusic`
4. Redeploy **sans** Remove volumes
5. Healthcheck `/api/health` + login mobile/web

### 5. Rollback (< 5 min)

1. Retirer / vider `DATABASE_URL`
2. Redeploy — l’API rouvre `ytmusic.db` sur `ytmusic_data`
3. Si le fichier avait été modifié pendant le cutover PG-only : restaurer
   `data/backups/ytmusic-….db` → `data/ytmusic.db`

## Lab local

```bash
docker run -d --name ytm-pg-lab -e POSTGRES_PASSWORD=ytmusic -e POSTGRES_USER=ytmusic \
  -e POSTGRES_DB=ytmusic -p 5433:5432 postgres:16-alpine

export DATABASE_URL=postgres://ytmusic:ytmusic@127.0.0.1:5433/ytmusic
bash scripts/db/backup-sqlite.sh
node scripts/db/sqlite-to-pg.mjs
node scripts/db/verify-pg.mjs

# API en mode PG
DATABASE_URL=$DATABASE_URL npm run -w api start   # ou tsx src/index.ts
```

## Sécurité

- Postgres : réseau Docker interne uniquement (pas de port host en prod)
- Mot de passe aléatoire long dans Portainer secrets / `.env`
- Backups : `pg_dump` cron recommandé après cutover + conservation du dernier SQLite
- `JWT_SECRET` **identique** avant/après (OAuth YTM chiffré)

## Scripts

| Script | Rôle |
|--------|------|
| `scripts/db/backup-sqlite.sh` | Checkpoint WAL + `.backup` |
| `scripts/db/sqlite-to-pg.mjs` | Import + vérif counts |
| `scripts/db/verify-pg.mjs` | Re-vérif / spot-check |
| `api/migrations/001_init.sql` | Schéma PG versionné |
