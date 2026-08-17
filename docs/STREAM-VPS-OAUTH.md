# Streams prod VPS — session Google TV (sans PC, sans proxy payant)

**Statut :** OAuth TV **connecté** (17/08/2026). La prod stream la musique (HTTP 206) via session signée + interpréteur JS youtubei.js (`api/src/youtube/youtubeiEval.ts`).  
**But :** que la **prod** (`ytmusic.delhomme.ovh` + APK) stream la musique **sans** laisser un PC allumé (`link-home-stream`) et **sans** proxy résidentiel payant.

---

## Réponse courte — Premium, pubs, ce que tu dois faire

**Tu n’as pas besoin de YouTube Premium.** PLM est pensé pour marcher avec un **compte Google gratuit**. Tu peux résilier Premium : ça ne casse pas PLM, et l’OAuth ci-dessous **n’est pas** un abonnement Google.

| Question | Réponse |
|---|---|
| Est-ce que je dois garder / payer YouTube Premium ? | **Non.** Zéro Premium requis pour écouter sur PLM (web / Android). Résilie si tu veux. |
| Est-ce que l’OAuth TV = Premium déguisé, ou des pubs YTM ? | **Non.** Tu restes dans **PLM** (notre lecteur). Pas l’app YouTube Music officielle, pas les pubs vidéo Google. On proxifie un flux **audio**. |
| Est-ce que ça m’inscrit à Premium / me facture ? | **Non.** Tu autorises seulement le **VPS** à parler à YouTube **en ton nom** (compte gratuit OK). Aucun prélèvement lié à cette étape. |
| À quoi sert l’OAuth alors ? | YouTube **bloque souvent les IP datacenter** (Contabo) si la requête est anonyme → `LOGIN_REQUIRED` → **HTTP 502** sur la musique. Un login appareil (gratuit) signe les requêtes. Ce n’est pas « acheter Premium ». |
| Dois-tu le faire tout de suite ? | **Ops admin : déjà fait** (17/08). **Users :** seulement quand l’inscription prod sera ouverte → liaison Google **par compte** (B4.24), toujours sans Premium. |

En résumé : **Premium = option Google que tu peux couper.** **OAuth TV = 2 min une fois, compte gratuit, pour que le serveur ait le droit de résoudre l’audio.** Les deux n’ont rien à voir.

---

## Contexte technique

1. **IP VPS Contabo** = datacenter → YouTube laisse passer certains titres (ex. Rickroll) mais **bloque souvent la musique** (`LOGIN_REQUIRED`, formats vides).
2. **Tunnel PC** (`scripts/deploy/link-home-stream.sh`) marche **en DEV** (IP résidentielle) mais **dépend du PC allumé**. En prod on **ne s’en sert pas** : le VPS + OAuth TV suffisent. Si le PC est éteint, la musique prod continue.
3. **Cookies navigateur** aident un peu (anti-bot) mais **ne suffisent pas** seuls depuis cette IP pour la musique.
4. **Solution logicielle retenue :** OAuth **appareil / TV** une fois → tokens chiffrés sur le volume Docker → Innertube signé pour `getAudioFormat`.

Fichiers clés :

- `api/src/youtube/youtubeiEval.ts` — interpréteur JS (youtubei.js ≥ 16 n’en embarque plus)
- `api/src/youtube/streamAuth.ts` — start / status / tokens stream
- `api/src/youtube/yt.ts` — priorise la session signée (MWEB + cookies + OAuth)
- `POST /api/admin/youtube-stream-oauth/start`
- `GET /api/admin/youtube-stream-oauth`
- `DELETE /api/admin/youtube-stream-oauth`

En prod, `STREAM_UPSTREAM` / fichier `stream-upstream.url` est **ignoré** sauf `ALLOW_STREAM_UPSTREAM=1` (réservé DEV).

---

## Cookies YouTube vs compte Google (Android / Nothing)

**Sur le téléphone : un bouton « Connecter Google ».** Tu te connectes dans l’app ; PLM récupère la session tout seul. Rien à coller. Compte Google **gratuit** — Premium **non requis** (ça marche aussi si tu n’as plus Premium).

| Besoin | Quoi faire |
|---|---|
| Jouer titres / file / mix | Compte PLM + OAuth TV **serveur** (filet VPS). |
| Importer likes / playlists YouTube Music | Android : **Connecter Google** (WebView). Web : collage cookies (le navigateur bloque l’accès auto). |
| Pubs / Premium | PLM lit un **flux audio** proxifié. Pas l’app YTM officielle. Premium **jamais** requis. |

---
---

## Inscription prod + liaison Google (par utilisateur)

**Pas de Premium.** L’inscription se **ouvre / ferme depuis Admin → Inscription** (`PUT /api/admin/settings`, pas besoin de Portainer). Quand elle est ouverte :

1. **Crée un compte PLM** (email / mot de passe) — c’est *notre* app, pas YouTube.
2. Est **invité** à **lier un compte Google** (OAuth appareil, `google.com/device`). Compte Google **gratuit**. Les comptes **déjà existants** sans liaison sont listés dans Admin et reçoivent le même prompt.

Ça n’inscrit personne à YouTube Premium, ne met pas de pubs YTM dans PLM, et ne facture rien.

| Qui | Quoi | Quand |
|-----|------|--------|
| **Ops (toi)** | OAuth TV **serveur** (`/api/admin/youtube-stream-oauth`) | **Fait** (17/08/2026) — filet VPS, PC éteint OK |
| **Chaque user** | OAuth **son** Google → `/api/ytm/connect/oauth` | Après signup / au login si pas encore lié |
| **Premium** | Rien | Jamais requis |

`getSignedStreamYT(userId)` utilise d’abord les credentials **user**, puis le filet VPS.

**APK :** le QR Admin n’est plus une URL fixe. Chaque « Nouveau lien » / ouverture d’inscription émet un ticket **one-shot** (`?t=`, 30 min, 1 GET). Après téléchargement ou erreur, le lien meurt. Les comptes déjà connectés (JWT) peuvent encore mettre à jour l’app in-app.

---

## Procédure ops (admin VPS — déjà jouée)

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
2. Compte Google = **n’importe lequel à toi**, **sans Premium**. (Celui que tu utilises déjà pour YouTube suffit.)
3. Entre le `userCode`, valide. Tu n’achètes rien ; tu dis juste « oui, ce serveur a le droit de récupérer les URLs audio ».

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

## Reprise / checklist

- [x] Déployer image prod avec `streamAuth` + `youtubeiEval`
- [x] `youtube-stream-oauth/start` + code sur google.com/device → `connected`
- [x] Probe 206 sur titres musique (pas seulement dQw4w9WgXcQ)
- [x] Smoke Samsung PROD : play musical + pas de spam `early_end` / 502 *(curl 206 17/08 ; smoke device à rejouer)*
- [x] **B4.24** toggle inscription Admin + prompt liaison Google (comptes existants inclus)
- [x] **B4.22 / B4.23** tampon télémétrie digest + playAt plus réactif (à valider Samsung)

**Note 17/08/2026 :** OAuth TV admin **connecté** ; image `ce4eb72` ; APK cible `p+1.3.19` (branche `feat/android-player-library`). Ne **pas** relancer `/start` tant que `status: connected`. Premium toujours **non requis**. Cookies = import biblio YTM seulement, pas la lecture.
