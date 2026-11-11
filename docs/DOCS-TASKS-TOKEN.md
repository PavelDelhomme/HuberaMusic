# Blocage « tâches Hubera Docs » — diagnostic & correctif

> 2026-11-10 · Hubera Music → Hubera Docs · aucun secret dans ce document

## Symptôme

Depuis Hubera Music, `POST /api/admin/docs-task` échoue systématiquement :
aucune tâche n'arrive dans Hubera Docs.

## Flux réel (3 maillons)

```
Music (admin)                     Hubera Docs                      Hubera ID
     │                                  │                              │
     │ 1. POST /api/admin/docs-task     │                              │
     │    (Bearer <access_token>)       │                              │
     ├─────────────────────────────────►│                              │
     │                                  │ 2. POST /api/auth/login/sso  │
     │                                  ├─────────────────────────────►│
     │                                  │◄─────────────────────────────┤
     │                                  │ 3. allowlist DOCS_ADMIN_EMAILS
     │                                  │    → 403 si email absent
```

## Diagnostic

### Verrou 1 — Music : jeton absent

`api/src/platform/docsTask.ts` exige `opts.accessToken`. La route admin lit le
jeton depuis l'en-tête `Authorization` ou le cookie de session ; le module
`streamIncident.ts` lit `DOCS_SERVICE_TOKEN` / `HUBERA_DOCS_TOKEN` /
`DOCS_API_TOKEN`.

**Constat** : aucune de ces variables n'existe — ni dans le `.env` local de
Music, ni dans l'environnement du conteneur `ytmusic`. Sans jeton,
`postDocsTask` sort en `error: 'auth'`.

### Verrou 2 — Docs : allowlist

`DOCS_ADMIN_EMAILS` (dans `/home/pavel/hubera-docs/.env`) contient :

```
paul@delhomme.ovh,paveldelhomme@gmail.com
```

→ **Le compte admin à utiliser est `paul@delhomme.ovh`** (déjà autorisé).
Aucune modification de l'allowlist n'est nécessaire.

## Correctif

Poser un jeton **Hubera ID** du compte `paul@delhomme.ovh` côté Music :

```bash
# /home/pavel/apps/ytmusic-deploy/stack.env
DOCS_SERVICE_TOKEN=<access token Hubera ID de paul@delhomme.ovh>
DOCS_API_URL=https://docs.hubera.cloud
```

Puis recréer le conteneur :

```bash
cd /home/pavel/apps/ytmusic-deploy
docker compose --env-file stack.env up -d --no-deps --force-recreate ytmusic
```

## Vérification

```bash
node scripts/qa/admin-aggregates-check.mjs
# attendu : « docs OK (n) » au lieu de « KO (DOCS_SERVICE_TOKEN non configuré) »
```

## État

- ✅ Code prêt, dégradation propre (l'incident reste journalisé, le mail ops part).
- ⏳ Configuration : jeton à poser (compte `paul@delhomme.ovh`).
- ⚠️ Aucun secret dans ce document ni dans les logs.
