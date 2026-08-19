# DNS & accès PLM (delhomme.ovh)

## Objectif

Avoir **https://ytmusic.delhomme.ovh** → **PLM** (compte, biblio, PWA),
**sans pubs YouTube**, sur web / Android / Windows / Linux / macOS.

## Zone DNS OVH (`delhomme.ovh`)

Dans le manager OVH → Domaines → `delhomme.ovh` → Zone DNS :

| Type | Sous-domaine | Cible | TTL |
|------|--------------|-------|-----|
| **A** | `ytmusic` | IP publique du VPS (ex. `95.111.227.204`) | 300 ou défaut |
| ou **CNAME** | `ytmusic` | le même hôte que Nextcloud / NPM | 300 |

Optionnel préprod :

| Type | Nom | Cible |
|------|-----|--------|
| A/CNAME | `ytmusic-preprod` | même VPS (autre stack Portainer) |

Vérifie :

```bash
dig +short ytmusic.delhomme.ovh
# → doit renvoyer l’IP du VPS
```

## Nginx Proxy Manager

1. Nouveau Proxy Host  
2. Domain : `ytmusic.delhomme.ovh`  
3. Forward : `http://ytmusic:8787` (conteneur sur réseau `npm-network`)  
4. SSL Let’s Encrypt + **Websockets** ON  
5. Force SSL

Variables stack : `APP_URL=https://ytmusic.delhomme.ovh`, `WEBAUTHN_RP_ID=ytmusic.delhomme.ovh`, etc. (voir `.env.production.example`).

## Mises à jour apps (web, mobile, desktop)

| Client | Comment ça se met à jour |
|--------|---------------------------|
| Navigateur web | Recharge la page / SW |
| PWA Android / iOS | Relancer l’app → service worker `autoUpdate` |
| PWA Windows / Linux / mac | Idem (app installée = site en mode standalone) |
| Serveur | Push git `prod` → GHCR → Portainer / Watchtower |

Pas de Play Store / App Store obligatoire : **une seule PWA**.

```bash
make help          # toutes les commandes
make install       # npm install
make mobile-hint   # guide install téléphone
make update-apps   # rappel MAJ
```

## Installer sur un appareil

### Ordinateur (Windows / Linux / macOS)

1. Ouvre `https://ytmusic.delhomme.ovh` (ou `http://localhost:5173` en local)
2. Bannière « Installer » → **Installer maintenant** (si Chrome/Edge propose)
   ou **Comment installer** (guide selon l’OS)
3. L’icône **PLM** (disque rouge + note) apparaît

### Android

1. Chrome → URL prod / LAN
2. ⋮ → **Installer l’application**
3. Compte app → Importer pour lier YouTube Music si besoin

### iPhone

1. **Safari** uniquement
2. Partager → **Sur l’écran d’accueil**

## PWA déjà installée sur mobile / PC

Au prochain ouverture de l’app, le service worker (`autoUpdate`) récupère la nouvelle version
servie par le domaine (prod) ou par Vite (dev LAN). Pas besoin du Play Store.

Pour forcer : fermer l’app → rouvrir, ou vider les données du site.
