# Ops — secours VPS / multi-sites + coffre secrets

Contexte : services sur Contabo (Portainer, NPM, PLM, JobbingTrack, VTC Builder, Maily, etc.).  
Besoin d’un **secours moins cher** + procédure minimale + **gestion des secrets**.

## Objectif

| Niveau | Contenu | RTO cible (indicatif) |
|--------|---------|------------------------|
| A — Config | Exports Portainer stacks, NPM proxy hosts, `.env` chiffrés, certificats procédure | < 1 j |
| B — Data | Volumes SQLite / uploads critiques (PLM `ytmusic_data`, Maily, JT) | < 1 j |
| C — DNS | TTL bas + bascule A/AAAA vers VPS secours | < 2 h si préparé |

## Coffre secrets (obligatoire)

**Jamais** de secrets dans Git (même branche privée) — trop fragile si le dépôt devient public.

| Outil | Rôle |
|-------|------|
| **Bitwarden** (collection `PLM`) | Source de vérité ops |
| **KeePassXC** | Miroir chiffré exporté hors-repo (PC perso / NAS) |

### Inventaire Bitwarden — collection PLM

Créer une entrée (ou note sécurisée) par item — **valeurs uniquement dans le coffre** :

1. `JWT_SECRET` prod / preprod / local (3 secrets distincts)
2. SMTP (`SMTP_USER` / `SMTP_PASS` / FROM)
3. Portainer API token (si utilisé)
4. Seed `dev@delhomme.ovh` (admin/test) — email + mdp
5. Seed `pavel@delhomme.ovh` (perso prod) — email + mdp **distinct**
6. Cookies / OAuth YouTube (ops stream) — si utilisés
7. Fingerprints APK / WebAuthn android key-hash
8. `APK_DOWNLOAD_TOKEN` si activé
9. Tokens tiers (AudD, Genius) si utilisés

### KeePassXC

1. Exporter depuis Bitwarden (ou saisie manuelle) → base `.kdbx` **hors** du repo Git.
2. Mot de passe maître fort + (optionnel) fichier clé sur clé USB.
3. Ne pas committer `.kdbx` / `.key` (déjà typiquement dans `.gitignore`).

### Machines de confiance

- `.env` locaux uniquement sur PC perso / VPS (jamais push).
- Vérifier : `make env-check` + CI gitleaks.
- `.env*.example` = placeholders seulement.

## Preprod

Voir `deploy/portainer-preprod.yml` + `deploy/stack.env.preprod.example`.  
DNS : `ytmusic-preprod.delhomme.ovh` → NPM → conteneur `ytmusic-preprod`.  
Image : `ghcr.io/…/ytmusic:preprod` (workflow_dispatch `tag_preprod`).

## Pistes VPS moins chers (à comparer 2026)

- **Hetzner Cloud** CX22 / CAX11 (ARM)
- **Netcup** VPS / RS
- **OVHcloud** VPS Starter
- Contabo en primaire ; secours plus petit OK

## Minimum viable secours

1. VPS secours avec Docker + NPM (ou Caddy).
2. Cron / script : `docker compose` des stacks critiques + restore volumes.
3. Doc one-pager : ordre de reboot, secrets (**Bitwarden**), qui touche au DNS.
4. Test de bascule **1× / trimestre** (au moins health + un login).

## PLM

Voir [`DOMAIN-PLM-MIGRATION.md`](./DOMAIN-PLM-MIGRATION.md) + mode maintenance Admin avant toute bascule DNS agressive.

## Comptes PLM (rappel sans mots de passe)

| Email | Rôle | Canaux app |
|-------|------|------------|
| `dev@delhomme.ovh` | Admin + tests | PLM Dev, PLM Preprod |
| `pavel@delhomme.ovh` | Perso | PLM prod (Nothing prod, etc.) |

Clone données one-shot : `FROM_EMAIL=… TO_EMAIL=… make clone-user-data` (voir `scripts/admin/clone-user-data.mjs`).
