import Fastify, { type FastifyInstance } from 'fastify';
import { scanRoutes } from './routes/scan.js';
import { dayRoutes } from './routes/day.js';

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(scanRoutes);
  app.register(dayRoutes);

  return app;
}
