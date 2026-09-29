import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { decodeCursor, page, pageQuery } from '../lib/pagination.js';
import { checkUnmodifiedSince } from '../lib/preconditions.js';
import { idParams, parse, uuid } from '../lib/validate.js';
import {
  bakeStepSchema,
  getOwnBake,
  getVisibleBake,
  loadBake,
  loadBakes,
  patchBakeSchema,
  startBake,
  startBakeSchema,
  upsertBakeStep,
} from '../services/bakes.js';

const listQuery = z.object({ recipe_id: uuid.optional(), ...pageQuery });
const stepParams = z.object({ id: uuid, stepId: uuid });

const routes: FastifyPluginAsync = async (app) => {
  const { pool, storage } = app.deps;
  app.addHook('preHandler', requireAuth);

  app.get('/bakes', async (request) => {
    const query = parse(listQuery, request.query);
    const cursor = decodeCursor(query.cursor);
    const { rows } = await pool.query(
      `SELECT b.id, b.started_at::text AS sort_t FROM bakes b
       WHERE b.user_id = $1 AND b.deleted_at IS NULL
         AND ($2::uuid IS NULL OR b.recipe_id = $2)
         AND ($3::timestamptz IS NULL OR (b.started_at, b.id) < ($3, $4::uuid))
       ORDER BY b.started_at DESC, b.id DESC LIMIT $5`,
      [request.userId, query.recipe_id ?? null, cursor?.t ?? null, cursor?.id ?? null, query.limit + 1],
    );
    const result = page(rows, query.limit, (r) => ({ t: r.sort_t, id: r.id }));
    return { items: await loadBakes(pool, result.items.map((r) => r.id), request.userId), next_cursor: result.next_cursor };
  });

  app.post('/recipes/:id/bakes', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const body = parse(startBakeSchema, request.body);
    const bake = await withTransaction(pool, async (db) => {
      const bakeId = await startBake(db, request.userId, id, body);
      return loadBake(db, bakeId, request.userId);
    });
    return reply.status(201).send(bake);
  });

  app.get('/bakes/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    return getVisibleBake(pool, id, request.userId);
  });

  app.patch('/bakes/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(patchBakeSchema, request.body);
    return withTransaction(pool, async (db) => {
      await db.query('SELECT 1 FROM bakes WHERE id = $1 FOR UPDATE', [id]);
      const current = await getOwnBake(db, id, request.userId);
      checkUnmodifiedSince(request, current.updated_at, () => current);
      await db.query(
        `UPDATE bakes SET
           notes = COALESCE($2, notes),
           rating = CASE WHEN $3 THEN $4 ELSE rating END,
           visibility = COALESCE($5::bake_visibility, visibility),
           current_step_position = CASE WHEN $6 THEN $7 ELSE current_step_position END,
           finished_at = CASE WHEN $8 THEN $9::timestamptz ELSE finished_at END,
           modified_at = COALESCE($10, now())
         WHERE id = $1`,
        [
          id,
          body.notes ?? null,
          body.rating !== undefined,
          body.rating ?? null,
          body.visibility ?? null,
          body.current_step_position !== undefined,
          body.current_step_position ?? null,
          body.finished_at !== undefined,
          body.finished_at ?? null,
          body.modified_at ?? null,
        ],
      );
      return loadBake(db, id, request.userId);
    });
  });

  app.put('/bakes/:id/steps/:stepId', async (request) => {
    const { id, stepId } = parse(stepParams, request.params);
    const body = parse(bakeStepSchema, request.body);
    return withTransaction(pool, async (db) => {
      const bake = await getOwnBake(db, id, request.userId);
      const inSnapshot = (bake.recipe_snapshot?.steps ?? []).some((s: { id: string }) => s.id === stepId);
      if (!inSnapshot) throw notFound('Step');
      await upsertBakeStep(db, id, stepId, body);
      return loadBake(db, id, request.userId);
    });
  });

  app.delete('/bakes/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const keys = await withTransaction(pool, async (db) => {
      const { rowCount } = await db.query(
        `UPDATE bakes SET deleted_at = now(), modified_at = now() WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [id, request.userId],
      );
      if (!rowCount) throw notFound('Bake');
      const { rows } = await db.query(
        `UPDATE media SET deleted_at = now() WHERE bake_id = $1 AND deleted_at IS NULL RETURNING storage_key`,
        [id],
      );
      return rows.map((r) => r.storage_key as string);
    });
    for (const key of keys) {
      await storage.remove(key).catch((err) => request.log.warn({ err, key }, 'media delete failed'));
    }
    return reply.status(204).send();
  });
};

export default routes;
