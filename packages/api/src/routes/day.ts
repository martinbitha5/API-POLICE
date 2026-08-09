import type { FastifyInstance } from 'fastify';
import { todayAtAirport } from '@police/shared';
import { authenticate } from '../auth.js';

// ─────────────────────────────────────────────────────────────
// Journée d'exploitation, calculée par le serveur.
//
// Le mobile la calculait seul, à partir de l'horloge du PDA. Un appareil dont
// la date dérive demandait alors les vols d'un autre jour et recevait une liste
// parfaitement cohérente, mais fausse : rien ne le signalait, ni à l'agent ni
// au superviseur. Un PDA a ainsi tourné une matinée sur les vols de la veille.
//
// L'aéroport n'est pas fourni par l'appelant, il est lu dans le profil via le
// JWT : un PDA ne peut pas réclamer la journée d'un autre site.
//
// `serverTime` permet au mobile de mesurer l'écart d'horloge sans requête
// supplémentaire, et de le montrer à l'agent. Le même décalage provoque déjà
// des refus d'authentification côté scan.
// ─────────────────────────────────────────────────────────────

export interface OperatingDayResponse {
  /** Aéroport du profil, tel qu'il sert au calcul. */
  airport: string | null;
  /** Journée d'exploitation en cours à cet aéroport (AAAA-MM-JJ). */
  day: string;
  /** Instant serveur, référence d'horloge pour l'appelant (ISO 8601). */
  serverTime: string;
}

export async function dayRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  app.get('/operating-day', async (request): Promise<OperatingDayResponse> => ({
    airport: request.authAirport,
    day: todayAtAirport(request.authAirport),
    serverTime: new Date().toISOString(),
  }));
}
