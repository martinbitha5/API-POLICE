# API Police — anti-fraude bagages

API Fastify autonome (extraite du monorepo) pour le scan boarding pass / bagage.

## Structure

```
packages/
  api/           → serveur Fastify (routes /scan/boarding, /scan/baggage)
  shared/        → types TypeScript partagés
  bcbp-parser/   → parsers boarding pass (BCBP) + étiquette bagage
```

`api` dépend de `shared` et `bcbp-parser` via les workspaces npm.

## Installation

```bash
npm install          # à la racine : résout les workspaces
```

## Variables d'environnement

À définir sur l'hébergeur (ne jamais committer). Voir `packages/api/.env.example` :

```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...   # clé serveur — secrète
PORT=3001
```

## Démarrage

L'API est bundlée en un seul fichier JS autonome (`server.js`) — code de
`shared` + `bcbp-parser` inliné, `fastify`/`@supabase/supabase-js`/`bcbp` en
dépendances npm. Aucun TypeScript ni résolution de workspace au runtime.

```bash
npm start            # = node server.js
```

Regénérer le bundle après modification du code source :

```bash
npm run build        # esbuild → server.js
```

### Déploiement Hostinger (preset Express)

- Fichier d'entrée : `server.js`
- Répertoire root : `./`
- Le serveur écoute sur `process.env.PORT` (injecté par l'hébergeur) — ne pas
  forcer `PORT` à la main.
- Variables d'env requises : `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
