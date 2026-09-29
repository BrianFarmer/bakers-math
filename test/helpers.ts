import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll } from 'vitest';
import { buildApp } from '../src/app.js';
import { createPool } from '../src/db.js';
import { createS3Storage } from '../src/lib/storage.js';
import { TEST_DATABASE_URL } from './globalSetup.js';

export interface TestContext {
  app: FastifyInstance;
  resetLinks: string[];
}

export function setupApp(): TestContext {
  const ctx = { resetLinks: [] as string[] } as TestContext;
  const pool = createPool(TEST_DATABASE_URL);
  const storage = createS3Storage();
  beforeAll(async () => {
    await storage.ensureBucket();
    ctx.app = buildApp({
      pool,
      storage,
      logger: false,
      mailer: {
        async sendPasswordReset(_email, link) {
          ctx.resetLinks.push(link);
        },
      },
    });
    await ctx.app.ready();
  });
  afterAll(async () => {
    await ctx.app.close();
    await pool.end();
  });
  return ctx;
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  refresh: string;
  auth: { authorization: string };
}

export async function signUp(app: FastifyInstance, name = 'baker'): Promise<TestUser> {
  const email = `${name}-${randomUUID().slice(0, 8)}@example.com`;
  const res = await app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email, password: 'correct horse battery' } });
  if (res.statusCode !== 201) throw new Error(res.body);
  const body = res.json();
  return {
    id: body.user.id,
    email,
    token: body.access_token,
    refresh: body.refresh_token,
    auth: { authorization: `Bearer ${body.access_token}` },
  };
}

/** The spec's worked example: 1000 g flour, 75% water, 20% starter at 100% hydration, 2% salt. */
export const countryLoaf = () => ({
  name: 'Country loaf',
  description: 'Everyday sourdough',
  input_mode: 'grams' as const,
  tags: ['sourdough', 'Everyday'],
  ingredients: [
    { name: 'Bread flour', role: 'flour' as const, grams: 900 },
    { name: 'Whole wheat flour', role: 'flour' as const, grams: 100 },
    { name: 'Water', role: 'water' as const, grams: 750 },
    { name: 'Starter', role: 'leaven' as const, grams: 200, leaven_hydration: 100 },
    { name: 'Salt', role: 'salt' as const, grams: 20 },
  ],
  steps: [
    { title: 'Autolyse', instructions: 'Mix flour and water', timer_seconds: 1800 },
    { title: 'Bulk', instructions: 'Stretch and fold every 30 min', timer_seconds: 4 * 3600 },
    { title: 'Shape', instructions: 'Pre-shape, rest, shape' },
    { title: 'Bake', instructions: '250C lid on, then off', timer_seconds: 2700 },
  ],
});
