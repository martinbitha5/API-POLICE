import Fastify, { type FastifyInstance } from 'fastify';
import { scanRoutes } from './routes/scan.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(scanRoutes);

  return app;
}
