# Déploiement PLM — à suivre dans l’ordre

**État actuel typique :** tu es en local, tu as aligné `.env` / `.env.example`,  
tu as **`DEPLOY_URL=https://ytmusic.delhomme.ovh`**.  
Tu n’as **pas encore** créé la stack Portainer / NPM / Watchtower / DNS.

**Ne configure pas** `PORTAINER_API_KEY` ni `DEPLOY_SSH` pour l’instant.  
On utilise **Watchtower** (gratuit, Portainer CE, sans webhook Pro).

Après la **première mise en ligne** (étapes 1 → 7), tu ne feras plus que  
l’étape **8** (boutons Admin sur ton PC).

---

## Checklist première mise en ligne

Coche au fur et à mesure. **Ne saute aucune étape.**

### ☐ 1. DNS OVH (obligatoire en premier)

Sans ça : `Could not resolve host` partout.

1. Va sur [OVH](https://www.ovh.com/manager/) → Domaines → **`delhomme.ovh`** → Zone DNS  
2. **Ajouter une entrée** :

| Type | Sous-domaine / Nom | Cible | TTL |
|------|--------------------|--------|-----|
| **A** | `ytmusic` | **IP publique de ton VPS** (celle de ton serveur) | 300 |

3. Enregistre. Attends quelques minutes.  
4. Sur ton PC :

```bash
dig +short ytmusic.delhomme.ovh
```

✅ OK si tu vois l’IP du VPS.  
❌ Si vide / NXDOMAIN → attends encore, ou corrige l’entrée DNS. **N’avance pas.**

---

### ☐ 2. Image Docker déjà sur GitHub (une fois)

Sur ton PC :

```bash
cd ~/Documents/Dev/Perso/YTMusic
git status          # working tree propre de préférence
git checkout dev && git pull origin dev
git checkout prod && git pull origin prod
git merge origin/dev -m "merge: promu dev → prod"
git push origin prod
```

1. Ouvre GitHub → repo **YTMusic** → onglet **Actions**  
2. Attends que le workflow **Docker** sur `prod` soit **vert**  
3. Image produite : `ghcr.io/paveldelhomme/ytmusic:latest`

Si GHCR est **privé** : Portainer → **Registries** → ajoute GitHub avec un PAT  
ayant le droit `read:packages`.

**Mieux (recommandé) : package en Public** — repo public ≠ image publique.

1. Ouvre : https://github.com/users/PavelDelhomme/packages/container/ytmusic/settings  
   (ou repo YTMusic → panneau droit **Packages** → `ytmusic` → **Package settings**)  
2. **Danger Zone** / Change visibility → **Public** → confirmer  
3. Réessaie le Deploy de la stack Portainer (plus besoin de registry login)

---

### ☐ 3. Stack Portainer `ytmusic` (le conteneur)

1. Ouvre **Portainer** (comme pour tes autres apps)  
2. **Stacks** → **Add stack**  
3. **Name** : `ytmusic`  
4. **Web editor** (pas Git si ça t’a déjà embêté)  
5. Ouvre sur ton PC le fichier  
   `deploy/portainer-template.yml`  
   → **tout sélectionner** → coller dans l’éditeur Portainer  
6. Plus bas : **Environment variables** → **Add an environment variable**  
   pour **chaque** ligne :

| Name | Value |
|------|--------|
| `JWT_SECRET` | lance `openssl rand -hex 32` et colle le résultat (**pas** le secret local) |
| `SMTP_PASS` | le même mot de passe SMTP que dans ton `.env` local |
| `ADMIN_EMAILS` | `toi@email.com` (ou ton email) |
| `AUTH_ALLOWED_EMAILS` | **identique** à `ADMIN_EMAILS` |
| `AUTH_ALLOW_REGISTER` | `0` |
| `AUTH_ALLOW_GUEST` | `0` |
| `APP_URL` | `https://ytmusic.delhomme.ovh` |
| `WEBAUTHN_RP_ID` | `ytmusic.delhomme.ovh` |
| `WEBAUTHN_ORIGIN` | `https://ytmusic.delhomme.ovh` |
| `YTMUSIC_IMAGE` | `ghcr.io/paveldelhomme/ytmusic:latest` |
| `SMTP_HOST` | `ssl0.ovh.net` |
| `SMTP_USER` | `noreply@ton-domaine` |
| `SMTP_FROM` | `PLM <noreply@ton-domaine>` |

7. **Deploy the stack**  
8. Onglet Containers : `ytmusic` doit passer **healthy** / running  

**Réseaux** (déjà chez toi en principe) :  
`nginx-proxy-manager_npm-network` et `shared-network-copy`.  
Si Portainer refuse le deploy → Networks : vérifie que ces noms existent  
(ou adapte les `name:` en bas du YAML comme sur tes autres stacks).

⚠️ Ne **jamais** cocher « Remove volumes » plus tard.

---

### ☐ 4. Stack Portainer `watchtower` (MAJ auto)

**Une seule fois.** C’est ça qui remplace les webhooks Pro.

1. Portainer → **Stacks** → **Add stack**  
2. **Name** : `watchtower`  
3. Colle le contenu de `deploy/watchtower-compose.yml`  
4. **Deploy**  

Tu n’ajoutes **rien** dans ton `.env` local pour Watchtower.  
Les commentaires A/B/C dans `.env` : ignore B et C.

---

### ☐ 5. Nginx Proxy Manager (HTTPS)

1. Ouvre **Nginx Proxy Manager**  
2. **Proxy Hosts** → **Add Proxy Host**  
3. Onglet **Details** :

| Champ | Valeur exacte |
|--------|----------------|
| Domain Names | `ytmusic.delhomme.ovh` |
| Scheme | `http` |
| Forward Hostname / IP | `ytmusic` |
| Forward Port | `8787` |
| Websockets Support | **ON** |
| Block Common Exploits | ON (ok) |

4. Onglet **SSL** :

| Champ | Valeur |
|--------|--------|
| SSL Certificate | Request a new SSL Certificate |
| Force SSL | **ON** |
| HTTP/2 | ON |
| Email | ton email Let’s Encrypt |
| Agree Let’s Encrypt | coché |

5. **Save**

Test sur ton PC :

```bash
curl -fsS https://ytmusic.delhomme.ovh/api/health
```

✅ Tu dois voir du JSON avec `"ok":true`.  
❌ **502** → conteneur pas sur le réseau NPM, ou Forward Hostname ≠ `ytmusic`.  
❌ certificat KO → DNS pas encore propagé (reviens à l’étape 1).

---

### ☐ 6. Créer ton compte sur le site prod (une seule fois)

Le site répond déjà (`/api/health` OK). L’inscription est **fermée** (`AUTH_ALLOW_REGISTER=0`) :
c’est voulu pour n’avoir **qu’un** compte (`toi@email.com` dans `AUTH_ALLOWED_EMAILS`).

Pour créer **ce** compte la première fois, on ouvre l’inscription **temporairement**.

#### 6.a — Ouvrir l’inscription (env seulement)

1. Portainer → **Stacks** → **ytmusic** → **Editor**  
2. Trouve la variable `AUTH_ALLOW_REGISTER` → mets la valeur **`1`**  
3. Clique **Update the stack**  
4. Dans la popup / options Portainer :
   - ✅ **Update / Redeploy** (recréation du conteneur avec les nouvelles env)  
   - ❌ **Ne coche PAS** « Pull image » / « Repull image and redeploy »  
     (inutile ici : on ne change **pas** l’image, seulement une variable)  
   - ❌ **Ne coche PAS** « Remove volumes » / « Remove orphaned volumes »

Attends que le conteneur `ytmusic` soit de nouveau **running / healthy** (~10–30 s).

Vérif depuis ton PC :

```bash
curl -fsS https://ytmusic.delhomme.ovh/api/auth/config
# tu dois voir : "allowRegister":true
```

#### 6.b — Créer le compte

1. Navigateur : **https://ytmusic.delhomme.ovh**  
2. **Créer un compte** avec **exactement** :
   - email : `toi@email.com` (celui de `AUTH_ALLOWED_EMAILS` / `ADMIN_EMAILS`)  
   - mot de passe : celui que tu veux (note-le)  
3. Connecte-toi → tu dois être admin.

Si « Accès réservé » / email refusé → l’email n’est pas dans `AUTH_ALLOWED_EMAILS` côté stack.

#### 6.c — Refermer l’inscription

1. Portainer → stack **ytmusic** → **Editor**  
2. `AUTH_ALLOW_REGISTER` → **`0`**  
3. **Update the stack** encore une fois  
   - ❌ toujours **pas** de Pull / Repull image  
   - ❌ toujours **pas** de Remove volumes  

```bash
curl -fsS https://ytmusic.delhomme.ovh/api/auth/config
# "allowRegister":false   ← plus personne ne peut s’inscrire
```

Tes réglages finaux (à garder) :

| Variable | Valeur |
|----------|--------|
| `AUTH_ALLOW_REGISTER` | `0` |
| `AUTH_ALLOW_GUEST` | `0` |
| `ADMIN_EMAILS` | `toi@email.com` |
| `AUTH_ALLOWED_EMAILS` | `toi@email.com` |

→ un seul compte utilisable : le tien.

---

### ☐ 6b. Mot de passe admin (SEED) — si login prod refuse le .env

Dans Portainer → stack `ytmusic` → Environment, ajoute :

```
SEED_EMAIL=toi@email.com
SEED_PASSWORD=<le même que ton .env local>
AUTH_SEED_SYNC=1
```

Puis **Pull and redeploy**. Au boot l’API aligne le hash mot de passe.

### ☐ 7. Cookies YouTube (obligatoire pour le son sur le VPS)

Sans ça : login OK mais **aucune lecture** (« Sign in to confirm you’re not a bot »).  
En local ça marche souvent ; sur un VPS YouTube bloque l’IP.

**Chemin recommandé (prod, sans PC allumé) :** OAuth appareil Google TV —  
voir [`docs/STREAM-VPS-OAUTH.md`](docs/STREAM-VPS-OAUTH.md).

Complément cookies (souvent insuffisant seul sur Contabo) :

1. Navigateur (fenêtre privée) → connecte-toi sur **https://www.youtube.com**  
2. F12 → **Network** → clique une requête `youtube.com` → Request Headers → copie **Cookie**  
3. Ouvre **https://ytmusic.delhomme.ovh/admin** (connecté admin)  
4. Section **Cookies YouTube (stream VPS)** → colle → **Enregistrer cookies**  
5. Relance une piste sur le téléphone / le site  

Alternative : page **Importer** → coller les cookies YTM (sert aussi au stream serveur).

---

### ☐ 8. Première APK (quand le site HTTPS marche + cookies OK)

Sur ton PC (Android SDK) :

```bash
cd ~/Documents/Dev/Perso/YTMusic
ADMIN_EMAIL=toi@email.com ADMIN_PASSWORD='ton-mot-de-passe' make android-upload-apk
```

Ou : `http://localhost:5173/admin` → **APK → VPS**.

Puis téléphone : ouvre / scanne  
`https://ytmusic.delhomme.ovh/api/deploy/apk`

---

### ☐ 9. Ensuite : tout contrôler depuis ton PC

**Quotidien / chaque release :**

1. Lance l’API + Vite en local si besoin (`make ensure-api`, `npm run dev:web`)  
2. `http://localhost:5173` → login → **Admin**  
3. Bloc **Mise en production** :

| Bouton | Effet |
|--------|--------|
| **Web (git → image)** | envoie le code → `prod` → build Docker → Watchtower met à jour le VPS (~5 min) |
| **APK → VPS** | recompile + upload l’APK sur le serveur |
| **Web + APK** | les deux d’un coup |

Tu n’as **plus** à toucher Portainer pour une MAJ normale (sauf souci).

---

## Recette après déploiement

Ne pas « tout tester d’un coup » : suivre l’ordre des checklists.

1. Avant push prod : [`TESTS.LOCAL.md`](./TESTS.LOCAL.md) puis [`TESTS_DEV.md`](./TESTS_DEV.md)  
2. Deploy (cette page / Admin / `scripts/deploy/admin-deploy-prod.sh`)  
3. Après image VPS à jour : [`TESTS_PROD.md`](./TESTS_PROD.md)  
4. Nothing : `DEVICE=<ip>:5555 make android-prod` · Samsung reste en **API LAN** au quotidien  

Index : [`TESTS.md`](./TESTS.md).

---

## Rappel `.env` local (déjà fait)

```env
APP_ENV=local
APP_URL=http://127.0.0.1:8787
DEPLOY_URL=https://ytmusic.delhomme.ovh
```

Laisse B/C (Portainer API / SSH) **commentés**. Watchtower suffit.

---

## Dépannage

| Symptôme | Que faire |
|----------|-----------|
| `Could not resolve host` | Étape 1 DNS pas OK |
| Deploy Admin : fichiers locaux | `git commit` ou laisse le stash auto |
| 502 NPM | Étape 5 : hostname `ytmusic`, port `8787`, Websockets |
| Pull denied image | Registry GHCR + PAT `read:packages` |
| Conteneur pas à jour après Web | Étape 4 Watchtower absente, ou attendre 5 min, ou Pull manuel |
| Inscription impossible | Étape 6 : `AUTH_ALLOW_REGISTER=1` temporaire |
| Pas de son / stream KO en prod | YouTube anti-bot VPS — Admin → **Cookies YouTube** (coller Cookie DevTools) |
| Données perdues | Tu as coché Remove volumes |

---

## Fichiers à coller dans Portainer

| Stack | Fichier du repo |
|-------|------------------|
| `ytmusic` | `deploy/portainer-template.yml` |
| `watchtower` | `deploy/watchtower-compose.yml` |

```bash
make deploy-hint
```
