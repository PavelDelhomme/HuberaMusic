# Incident production Hubera Music — 2026-11-10

> Rapport d'incident · conteneur `ytmusic` · VPS `vmi1296373` (pavel-server)
> Aucun secret dans ce document.

## 1. Chronologie

| Heure (Paris) | Événement |
|---|---|
| 15:02 | Début du diagnostic : conteneur `ytmusic` détecté `Up (unhealthy)` |
| 15:04 | Logs : `RangeError: Maximum call stack size exceeded` en boucle dans `stream.ts` |
| 15:06 | Healthcheck : `Health check exceeded timeout (5s)` × 5 · `restarts=26` |
| 15:08 | Cause racine identifiée (repli DASH récursif) |
| 15:11 | Build `ytmusic:1.3.414` lancé (depuis `dev`, qui contient `9ff0929`) |
| 15:16 | Image construite (664 Mo) |
| 15:20 | Transfert VPS (docker save → scp → load) · md5 identique |
| 15:12 | `docker-compose.override.yml` basculé sur `1.3.414` (sauvegarde `.bak-1414`) |
| 15:13 | `docker compose up -d --no-deps --force-recreate ytmusic` |
| 15:13 | **Conteneur `healthy`, 0 restart** · volume intact |
| 15:13 | Vérification : `/api/health` = **200** sur `plm.delhomme.ovh` et `music.hubera.cloud` |

## 2. Symptômes

- Conteneur `Up (unhealthy)`, **26 redémarrages** (image du 30/10)
- `RangeError: Maximum call stack size exceeded` en boucle (`PromiseRejectCallback`)
- `https://plm.delhomme.ovh/api/health` → timeout (code `000`)
- `https://music.hubera.cloud/api/health` → 404

## 3. Cause racine

Dans `api/src/media/stream.ts`, le repli DASH lançait `downloadTrack(...)` de façon
**synchrone** alors que la réponse était déjà en cours d'écriture. Cela provoquait une
**ré-entrée récursive** dans le pipeline de stream :

```
handleStream → (disque qui grossit) → downloadTrack → handleStream → ...
                                       ↑___________________________|
→ RangeError: Maximum call stack size exceeded
→ PromiseRejectCallback relance la même promesse → boucle infinie
→ l'event loop est saturé → le healthcheck (timeout 5 s) échoue
```

L'image en production (`ytmusic:search-durable`, construite le **30/10**) **ne
contenait pas** le correctif `9ff0929` (étiquette 1.3.413, du 09/11) dont le message
est explicite : « Le progressif tourne en fond **APRÈS** la décision (évite tempête
récursive `downloadTrack` ↔ stream) ».

## 4. Correctif

1. **Build** de l'image `ytmusic:1.3.414` depuis la branche `dev` (contient `9ff0929`)
   + les modules `fastStart` / `streamHealthHub` / `streamIncident`.
2. **Transfert** vers le VPS : `docker save | gzip` → `scp` → `docker load`
   (vérification md5 identique entre local et distant).
3. **Bascule** de `/home/pavel/apps/ytmusic-deploy/docker-compose.override.yml` :
   `image: ytmusic:search-durable` → `image: ytmusic:1.3.414`.
4. **Recréation** : `docker compose --env-file stack.env up -d --no-deps
   --force-recreate ytmusic`. Le volume `ytmusic_ytmusic_data` (**20,6 Go**) n'a
   **jamais** été touché (règle `REGLES-ZERO-PERTE.md`).

## 5. Vérification

| Indicateur | Avant | Après |
|---|---|---|
| Image | `search-durable` (30/10) | `1.3.414` |
| Status | unhealthy | **healthy** |
| Restarts | 26 | **0** |
| `RangeError` (compteur logs) | en boucle | **0** |
| `/api/health` plm | timeout | **200** |
| `/api/health` music | 404 | **200** |
| Volume | — | **intact** |

## 6. Prévention

1. **Alignement image/code** : le tag d'image déployé doit correspondre au code de
   `dev`. Un décalage de 10 jours a suffi à casser la production.
2. **Détection au démarrage** : alerter sur la présence de `RangeError` dans les
   logs du conteneur (le canal `fleet-watch` pourrait le faire).
3. **Healthcheck** : il a correctement signalé le problème (`unhealthy`) — conserver
   `curl --fail` + timeout court.
4. **Rollback préparé** : l'ancien override est sauvegardé
   (`docker-compose.override.yml.bak-1414`) ; les images
   `search-durable-pre-relay` / `search-durable-pre-mweb` restent sur le VPS.

## 7. Commandes utiles

```bash
# Etat du conteneur
ssh pavel-server "docker inspect ytmusic --format '{{.Config.Image}} {{.State.Status}} {{.State.Health.Status}} restarts={{.RestartCount}}'"

# Rollback d'urgence (remet l'ancienne image)
ssh pavel-server "cd /home/pavel/apps/ytmusic-deploy && cp docker-compose.override.yml.bak-1414 docker-compose.override.yml && docker compose --env-file stack.env up -d --no-deps ytmusic"

# Compteur RangeError
ssh pavel-server "docker logs ytmusic 2>&1 | grep -c 'Maximum call stack'"
```
