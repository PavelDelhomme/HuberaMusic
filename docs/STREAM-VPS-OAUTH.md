# Streams prod VPS — session Google TV (sans PC, sans proxy payant)

**Statut :** à reprendre après le 16/08/2026.  
**But :** que la **prod** (`ytmusic.delhomme.ovh` + APK) stream la musique **sans** laisser un PC allumé (`link-home-stream`) et **sans** proxy résidentiel payant.

---

## Réponse courte — pubs / « YouTube Music fait maison »

| Question | Réponse |
|---|---|
| Est-ce que l’OAuth transforme PLM en YouTube Music officiel **avec pubs** ? | **Non.** Tu restes sur **PLM** (web / Android). Pas le lecteur YTM Google. |
| Est-ce que ça enlève un éventuel Premium ? | **Non.** C’est le **même compte Google** : Premium reste Premium ; sans Premium, tu n’en gagnes pas non plus. |
| À quoi sert l’OAuth alors ? | Uniquement à **autoriser le VPS** (IP datacenter Contabo) à résoudre les URLs audio. Sans ça, YouTube répond souvent `LOGIN_REQUIRED` / `unavailable` → **HTTP 502** sur la musique. |
| Dois-tu le faire tout de suite ? | **Non obligatoire aujourd’hui.** Doc prête ; on reprend plus tard. En attendant, la musique prod peut rester fragile / en 502 sans relais maison. |

PLM ne diffuse pas les pubs vidéo YouTube dans le lecteur : on proxifie un flux **audio**. L’OAuth n’injecte pas de pubs « maison ».

---

## Contexte technique

1. **IP VPS Contabo** = datacenter → YouTube laisse passer certains titres (ex. Rickroll) mais **bloque souvent la musique** (`LOGIN_REQUIRED`, formats vides).
2. **Tunnel PC** (`scripts/deploy/link-home-stream.sh`) marche (IP résidentielle) mais **dépend du PC allumé** → rejeté pour la prod au quotidien.
3. **Cookies navigateur** aident un peu (anti-bot) mais **ne suffisent pas** seuls depuis cette IP pour la musique.
4. **Solution logicielle retenue :** OAuth **appareil / TV** une fois → tokens chiffrés sur le volume Docker → Innertube signé pour `getAudioFormat`.

Fichiers clés :

- `api/src/youtube/streamAuth.ts` — start / status / tokens stream
- `api/src/youtube/yt.ts` — priorise la session signée
- `POST /api/admin/youtube-stream-oauth/start`
- `GET /api/admin/youtube-stream-oauth`
- `DELETE /api/admin/youtube-stream-oauth`

En prod, `STREAM_UPSTREAM` / fichier `stream-upstream.url` est **ignoré** sauf `ALLOW_STREAM_UPSTREAM=1` (réservé DEV).

---

## Procédure (quand on reprend)

### 1. Déployer le code API sur prod

Merge `dev` → `prod` (ou hot-copy déjà testé) puis laisser Watchtower / redéployer l’image pour que `streamAuth` soit bien dans l’image GHCR (ne pas compter uniquement sur un `docker cp` temporaire).

### 2. Lancer le code appareil (compte admin)

```bash
# Depuis une machine avec .env (SEED_*)
TOKEN=$(curl -fsS -X POST https://ytmusic.delhomme.ovh/api/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$SEED_EMAIL\",\"password\":\"$SEED_PASSWORD\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

curl -fsS -X POST https://ytmusic.delhomme.ovh/api/admin/youtube-stream-oauth/start \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
```

Réponse typique :

```json
{
  "ok": true,
  "verificationUrl": "https://www.google.com/device",
  "userCode": "XXX-YYY-ZZZ",
  "expiresIn": 1800
}
```

### 3. Autoriser sur Google (2 min)

1. Ouvre **https://www.google.com/device** (téléphone ou PC).
2. Compte Google = celui de **ton** YouTube / YTM.
3. Entre le `userCode`, valide.

### 4. Vérifier

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" \
  https://ytmusic.delhomme.ovh/api/admin/youtube-stream-oauth
# → status: connected, configured: true

# Streams musique (ex.)
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 40 \
  -H "Authorization: Bearer $TOKEN" -H 'Range: bytes=0-1023' \
  https://ytmusic.delhomme.ovh/api/stream/cc6RjMfIj6w
# Attendu : 206
```

### 5. Alternative / complément ops

```bash
BROWSER=brave bash scripts/deploy/push-youtube-cookies.sh prod
```

(Cookies Flatpak Brave OK ; utile anti-bot, **pas** un substitut à l’OAuth stream si l’IP reste bloquée.)

---

## Ce qu’il ne faut pas faire en prod

- Compter sur `link-home-stream` au quotidien (PC éteint = 502).
- Remettre `ALLOW_STREAM_UPSTREAM=1` sans raison (réintroduit la dépendance maison).
- Croire qu’un cookie NID stub (~1 Ko) suffit.

---

## Reprise prévue

- [ ] Déployer image prod avec `streamAuth`
- [ ] `youtube-stream-oauth/start` + code sur google.com/device
- [ ] Probe 206 sur titres musique (pas seulement dQw4w9WgXcQ)
- [ ] Smoke Nothing : play + pas de spam `early_end` / 502
- [ ] Commit/doc à jour si la procédure change

**Note 15/08/2026 :** correctifs lecteur Android (volume système, `resumeOrPlay`, reprise `early_end`) installés en sideload sur Nothing ; API stream OAuth hot-copiée une fois sur le conteneur — à **rejouer via image** à la reprise.
