import type { FastifyRequest, FastifyReply } from 'fastify';

// ─────────────────────────────────────────────────────────────
// E-08 : limitation de débit par agent authentifié.
//
// La clé est request.authUserId, dérivé du JWT validé (non usurpable, contrairement
// à une IP derrière le proxy Hostinger). Ce hook s'exécute APRÈS authenticate.
// But : borner le martèlement d'un token (compromis ou boucle client) sans gêner
// le scan normal. 240 req/min/agent = 4/s, très au-dessus d'une cadence humaine.
//
// Limiteur en mémoire, suffisant pour un process API unique. Si l'API passe en
// multi-instance, remplacer par un store partagé (Redis).
// ─────────────────────────────────────────────────────────────

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 240;
const MAX_KEYS = 10_000;

const hits = new Map<string, number[]>();

export async function rateLimitPerUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = request.authUserId;
  if (!key) return; // non authentifié : authenticate a déjà répondu 401

  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= MAX_PER_WINDOW) {
    await reply.code(429).send({ error: 'Trop de requêtes. Patientez un instant.' });
    return;
  }

  recent.push(now);
  hits.set(key, recent);

  // Éviction grossière pour borner la mémoire.
  if (hits.size > MAX_KEYS) hits.clear();
}
