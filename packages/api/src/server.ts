import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import { scanRoutes } from './routes/scan.js';
import { dayRoutes } from './routes/day.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: true,
    // F-04 / M-04 : bornes anti-abus. Un scan (BCBP ou tag) est petit ; 64 Ko
    // laisse une marge confortable tout en coupant les corps démesurés.
    bodyLimit: 64 * 1024,
    requestTimeout: 15_000,
  });

  // F-03 : gestionnaire d'erreurs global. On ne renvoie jamais de détail interne
  // (message d'exception, trace) au client ; les 5xx sont génériques.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    request.log.error(err);
    const code = typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500
      ? err.statusCode
      : 500;
    reply.code(code).send({ error: code < 500 ? err.message : 'Erreur interne' });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(scanRoutes);
  app.register(dayRoutes);

  return app;
}
