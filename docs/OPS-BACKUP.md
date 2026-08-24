# Ops — secours VPS / multi-sites

Contexte : services sur Contabo (Portainer, NPM, PLM, JobbingTrack, VTC Builder, Maily, etc.).  
Besoin d’un **secours moins cher** + procédure minimale.

## Objectif

| Niveau | Contenu | RTO cible (indicatif) |
|--------|---------|------------------------|
| A — Config | Exports Portainer stacks, NPM proxy hosts, `.env` chiffrés, certificats procédure | &lt; 1 j |
| B — Data | Volumes SQLite / uploads critiques (PLM `ytmusic_data`, Maily, JT) | &lt; 1 j |
| C — DNS | TTL bas + bascule A/AAAA vers VPS secours | &lt; 2 h si préparé |

## Pistes VPS moins chers (à comparer 2026)

- **Hetzner Cloud** CX22 / CAX11 (ARM) — souvent le meilleur rapport
- **Netcup** VPS / RS — bons prix EU
- **OVHcloud** VPS Starter — simple, EU
- Contabo reste OK en primaire ; le secours peut être **plus petit** (repos + reverse-proxy + 1–2 stacks critiques)

Ne pas dupliquer *tout* en permanent : snapshot hebdo + script de restore + DNS prêt suffit souvent.

## Minimum viable secours

1. VPS secours avec Docker + NPM (ou Caddy).
2. Cron / script : `docker compose` des stacks critiques + restore volumes.
3. Doc one-pager : ordre de reboot, secrets (Bitwarden), qui touche au DNS.
4. Test de bascule **1× / trimestre** (au moins health + un login).

## PLM

Voir [`DOMAIN-PLM-MIGRATION.md`](./DOMAIN-PLM-MIGRATION.md) + mode maintenance Admin avant toute bascule DNS agressive.
