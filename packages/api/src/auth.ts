import type { FastifyRequest, FastifyReply } from 'fastify';
import type { UserRole } from '@police/shared';
import { getSupabase } from './supabase.js';

// ─────────────────────────────────────────────────────────────
// Authentification de l'API de scan.
//
// L'API tourne avec la clé service_role (bypass RLS) : elle DOIT donc
// authentifier chaque appel elle-même, sinon n'importe qui peut pré-enregistrer
// un bagage et contourner l'anti-fraude. Chaque requête /scan/* porte le JWT
// Supabase de l'agent (Authorization: Bearer <access_token>). On le valide
// auprès de GoTrue, on charge le rôle depuis profiles, et on n'autorise que les
// rôles opérationnels. L'identité du scanneur (authUserId) est dérivée du token,
// jamais du corps de la requête.
// ─────────────────────────────────────────────────────────────

const ALLOWED_ROLES: readonly UserRole[] = ['agent', 'supervisor', 'admin'];

declare module 'fastify' {
  interface FastifyRequest {
    /** UUID du profil authentifié (dérivé du JWT, pas du body). */
    authUserId: string;
    /** Rôle du profil authentifié. */
    authRole: UserRole;
  }
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

/**
 * preHandler Fastify : rejette (401/403) toute requête sans JWT valide d'un
 * agent/superviseur/admin, et décore la requête avec authUserId / authRole.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: 'Authentification requise' });
    return;
  }

  const supabase = getSupabase();

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData.user) {
    await reply.code(401).send({ error: 'Session invalide ou expirée' });
    return;
  }

  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .single<{ role: UserRole }>();

  if (profErr || !profile) {
    await reply.code(403).send({ error: 'Profil introuvable' });
    return;
  }

  if (!ALLOWED_ROLES.includes(profile.role)) {
    await reply.code(403).send({ error: 'Rôle non autorisé' });
    return;
  }

  request.authUserId = userData.user.id;
  request.authRole = profile.role;
}
