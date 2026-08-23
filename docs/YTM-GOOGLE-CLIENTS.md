# Liaison Google / YTM — clients mobiles & survie aux mises à jour

**But :** la même procédure partout (Android aujourd’hui, autre app demain) ; **rien à refaire** après un redeploy Watchtower / Portainer si on respecte la checklist.

---

## Deux liaisons distinctes (ne pas confondre)

| Besoin | API | UX recommandée | Persisté où |
|--------|-----|----------------|-------------|
| **Lecture audio fiable** (IP VPS) | `POST /api/ytm/connect/oauth` + poll `GET /api/ytm/oauth/status` | Code appareil → `https://www.google.com/device` (Chrome / navigateur système = compte Google déjà sur le téléphone, **sans resaisie MDP**) | Volume `ytmusic_data` → SQLite `ytm_accounts.oauth_enc` |
| **Likes / playlists / sync biblio** | `POST /api/ytm/connect/cookie` puis `POST /api/ytm/sync` | WebView music.youtube.com **ou** collage Cookie PC | `ytm_accounts.cookie_enc` |

OAuth seul → `hasOauth: true`, streams user OK.  
Cookies seuls → `canSyncLibrary: true`, biblio OK, streams souvent plus fragiles depuis le VPS.  
**Idéal user :** les deux (`hasOauth` + `hasCookie`).

Filet **ops** (tous les users) : OAuth TV serveur `data/youtube-stream-oauth.enc` — voir [`STREAM-VPS-OAUTH.md`](./STREAM-VPS-OAUTH.md).

---

## Flux client (copier-coller pour une autre app mobile)

1. JWT PLM valide (`Authorization: Bearer …`).
2. `POST /api/ytm/connect/oauth` → `{ userCode, verificationUrl, expiresIn }`.
3. Ouvrir `verificationUrl` (souvent `https://www.google.com/device`) via **Intent navigateur système** (pas WebView isolée).
4. L’utilisateur choisit le compte Google du téléphone, entre `userCode`.
5. Poll toutes les 2 s : `GET /api/ytm/oauth/status` jusqu’à `status: "connected"` (ou `error`).
6. Optionnel biblio : WebView / cookies → `POST /api/ytm/connect/cookie` → `POST /api/ytm/sync`.
7. Vérifier `GET /api/ytm/status` → `account.hasOauth` / `hasCookie` / `canSyncLibrary`.

**Android PLM :** Compte → Compte Google → **« Lier Google (compte déjà sur le téléphone) »**.

**Web :** page Import — section code appareil + cookies.

---

## Après une mise à jour (ne rien perdre)

| À faire | À ne jamais faire |
|---------|-------------------|
| Pull / redeploy image (`:latest` / `:prod` / `:dev`) | Cocher **Remove volumes** dans Portainer |
| Laisser `JWT_SECRET` **identique** | Régénérer `JWT_SECRET` (chiffre OAuth/cookies illisibles) |
| Garder volume `ytmusic_data` | Effacer `/app/data` |
| Env Portainer stables : `STREAM_UPSTREAM_FALLBACK=1` si relais maison | Compter sur un hot-patch seul dans le conteneur |

Contrôle rapide :

```bash
curl -sS https://ytmusic.delhomme.ovh/api/health | jq '.streamAuth, .streamUpstream, .youtubeCookies.configured'
```

Attendu typique prod VPS-only : `serverOauth: true`, `upstreamAllowed: false` (ou true seulement si secours maison assumé).

---

## Relais maison (optionnel)

- `ALLOW_STREAM_UPSTREAM=1` + `bash scripts/deploy/link-home-stream.sh`
- `STREAM_UPSTREAM_FALLBACK=1` (défaut compose) → si le PC coupe, fallback VPS au lieu d’un 502 définitif
- Prod idéal long terme : **ALLOW vide** + OAuth TV + OAuth user

---

## Checklist ops post-deploy

- [ ] Health `ok`, `streamAuth.serverOauth: true`
- [ ] Un user test : `hasOauth: true` (pas besoin de re-lier si volume intact)
- [ ] Probe `Range: bytes=0-65535` → HTTP 206 audio
- [ ] APK : Compte Google → OAuth device si `hasOauth: false`
