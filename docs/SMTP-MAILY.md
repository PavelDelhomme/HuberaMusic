# SMTP (OVH MX Plan ou autre)

Configure le SMTP **uniquement dans `.env`** (jamais dans git).

| Variable | Rôle |
|---|---|
| `SMTP_HOST` | Hôte SMTP (ex. OVH) |
| `SMTP_PORT` | `465` (SSL) ou `587` |
| `SMTP_SECURE` / `SMTP_USE_SSL` | `1` si SSL |
| `SMTP_USER` | Compte technique |
| `SMTP_PASS` | Mot de passe (`.env` seulement) |
| `SMTP_FROM` | Ex. `"Hubera Music <noreply@ton-domaine>"` |
| `SMTP_REPLY_TO` | Optionnel |

## Local

Sans `SMTP_HOST` → mails en outbox admin + logs console.  
Mailhog : `docker compose -f docker-compose.dev.yml` (`SMTP_HOST=mailhog`, port `1025`).

## Prod

Renseigne les variables dans Portainer / `.env` VPS. Test : Admin → **Tester SMTP**.

## Parcours

1. Création compte → email de validation depuis `SMTP_FROM`
2. Login → JWT + refresh
3. `make seed-users` si `SEED_EMAIL` / `SEED_PASSWORD` définis dans `.env`
