# Hubera Admin — User cases (Mermaid) & bugs remontés

> Console admin Hubera Music · API + panneau React · 2026-11-09

## Objectif

Visualiser et interagir avec les **user cases de chaque app Hubera** directement
dans l'interface d'administration (web), avec :

- les parcours **Admin** et **Utilisateur standard (test)** recensés ;
- un **diagramme visuel interactif** (Mermaid) par application ;
- la liste des **bugs remontés** par e-mail (Himalaya) et par **Hubera Docs**.

## Contrat de données — `user-cases.json`

Chaque dépôt produit dépose un `user-cases.json` à sa racine :

```json
{
  "app": "Hubera Music",
  "repo": "YTMusic",
  "version": "1.3.413",
  "roles": {
    "admin":   { "label": "Compte Admin", "email_env": "SEED_EMAIL" },
    "standard":{ "label": "Compte Utilisateur standard (test)", "email_env": "SEED_EMAIL_QA" }
  },
  "userCases": [
    { "id": "MUS-PLAY-01", "title": "Lecture d'un titre chaud",
      "role": "standard", "flow": ["recherche","clic_titre","lecture"],
      "expected": "Premier octet < 1 s" }
  ],
  "bugSources": [
    { "kind": "email", "provider": "himalaya", "mailbox": "INBOX" },
    { "kind": "docs",  "project": "music", "category": "bug" }
  ]
}
```

Génération du squelette pour toutes les apps :

```bash
node scripts/tests/generate-user-cases.mjs        # ne remplace pas un fichier existant
node scripts/tests/generate-user-cases.mjs --force
```

## Backend

| Module | Rôle |
|---|---|
| `api/src/platform/userCases.ts` | Lit `products/*/user-cases.json`, construit le **flowchart Mermaid** (`buildMermaidFlow`), échappe les libellés (`mermaidLabel`). |
| `api/src/platform/bugSources.ts` | `himalaya envelope search --json` (mail) + `GET /api/tasks?category=bug` (Docs). Jamais fatal : les erreurs remontent en clair. |

### Endpoints (admin)

| Route | Description |
|---|---|
| `GET /api/admin/user-cases` | `{ count, apps[{ app, cases, admin, standard, mermaid, userCases }] }` |
| `GET /api/admin/bugs?limit=10` | `{ mail{ ok, count, items, error }, docs{ ok, count, items, error } }` |

Le dossier des produits est résolu automatiquement (`HUBERA_PRODUCTS_DIR` pour
forcer), car les dépôts Git vivent côte à côte dans `Dev/Perso/` et `products/`
n'est qu'un jeu de symlinks.

## Frontend

- `web/src/components/admin/MermaidDiagram.tsx` — charge Mermaid depuis le CDN
  (ESM, `securityLevel: strict`), rend un SVG. **Repli** : si le CDN est
  indisponible, le code source Mermaid est affiché tel quel.
- `web/src/components/admin/UserCasesPanel.tsx` — sélecteur d'app, badges de rôle
  (`admin` rose / `standard` bleu), liste des cas, diagramme, liste des bugs.
- Intégré dans `AdminPage.tsx` sous un bloc dépliable « User cases & bugs remontés ».

## Vérification

```bash
node scripts/qa/admin-aggregates-check.mjs --base http://127.0.0.1:8787
```

Résultat de référence : **4/4** — 18 apps détectées, diagramme Mermaid généré,
permissions standard refusées (403), sources bugs interrogées sans crash.

## Sécurité

- Le panneau est **lecture seule** et réservé au rôle admin (`requireAdmin`).
- Aucun secret n'est affiché : ni mot de passe IMAP, ni jeton Docs.
- Le jeton Docs de service (`DOCS_SERVICE_TOKEN`) n'est jamais loggé.
