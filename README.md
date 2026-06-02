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

```bash
npm start            # lance @police/api (tsx)
```

> Note : le script `start` de l'API utilise `--env-file=.env`. En production
> sans fichier `.env`, retire ce flag et fournis les variables via l'environnement
> de l'hébergeur.
