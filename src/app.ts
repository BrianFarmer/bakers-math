import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { ApiError } from './lib/errors.js';
import { FormulaError } from './lib/bakersMath.js';
import type { Storage } from './lib/storage.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import recipeRoutes from './routes/recipes.js';
import bakeRoutes from './routes/bakes.js';
import mediaRoutes from './routes/media.js';
import syncRoutes from './routes/sync.js';

export interface Mailer {
  sendPasswordReset(email: string, link: string): Promise<void>;
}

export interface AppDeps {
  pool: pg.Pool;
  storage: Storage;
  mailer?: Mailer;
  logger?: boolean | object;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Required<Omit<AppDeps, 'logger'>>;
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? true, bodyLimit: 2 * 1024 * 1024 });

  const mailer: Mailer = deps.mailer ?? {
    // No email service in local development: the reset link is written to the API log.
    async sendPasswordReset(email, link) {
      app.log.info({ email, link }, 'password reset link (dev mailer)');
    },
  };
  app.decorate('deps', { pool: deps.pool, storage: deps.storage, mailer });
  app.decorateRequest('userId', '');

  app.setErrorHandler((err: any, request, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof FormulaError) {
      return reply.status(422).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err.validation || err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || err.statusCode === 400) {
      return reply.status(400).send({ error: { code: 'bad_request', message: err.message } });
    }
    if (err.statusCode === 413) {
      return reply.status(413).send({ error: { code: 'payload_too_large', message: err.message } });
    }
    // Postgres: invalid uuid text etc.
    if (err.code === '22P02') {
      return reply.status(400).send({ error: { code: 'bad_request', message: 'Invalid identifier' } });
    }
    request.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` } }),
  );

  app.get('/health', async () => {
    await deps.pool.query('SELECT 1');
    return { ok: true };
  });

  app.register(
    async (v1) => {
      await v1.register(authRoutes);
      await v1.register(meRoutes);
      await v1.register(recipeRoutes);
      await v1.register(bakeRoutes);
      await v1.register(mediaRoutes);
      await v1.register(syncRoutes);
    },
    { prefix: '/v1' },
  );

  return app;
}
