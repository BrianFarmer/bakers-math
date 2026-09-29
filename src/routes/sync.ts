import type { FastifyPluginAsync } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { ApiError, notFound } from '../lib/errors.js';
import { FormulaError } from '../lib/bakersMath.js';
import { isoDate, parse, uuid } from '../lib/validate.js';
import { bakeStepSchema, loadBake, loadBakes, startBake, upsertBakeStep } from '../services/bakes.js';
import { canView, getVisibleRecipe, loadRecipe, loadRecipes, recipeBodySchema, writeRecipe } from '../services/recipes.js';

/**
 * Offline sync. The phone creates ids itself, so rows made offline keep their id on the server.
 * Conflicts are settled per recipe and per bake: the most recent save (modified_at) wins.
 */

// Rows committed by slower concurrent transactions can carry an updated_at a little before
// server_time; handing out a slightly earlier cursor means they are picked up next time.
const CURSOR_OVERLAP_MS = 5000;

const pullQuery = z.object({ since: isoDate.optional() });

const pushRecipe = recipeBodySchema.extend({
  id: uuid,
  modified_at: isoDate,
  deleted_at: isoDate.nullable().optional(),
});

const pushBakeStep = bakeStepSchema.extend({ step_id: uuid });

const pushBake = z.object({
  id: uuid,
  recipe_id: uuid,
  modified_at: isoDate,
  deleted_at: isoDate.nullable().optional(),
  started_at: isoDate.optional(),
  finished_at: isoDate.nullable().optional(),
  scale_factor: z.number().finite().positive().max(1000).optional(),
  target_dough_g: z.number().finite().positive().nullable().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  notes: z.string().max(20_000).optional(),
  visibility: z.enum(['private', 'shared']).optional(),
  current_step_position: z.number().int().min(0).nullable().optional(),
  // The scaled recipe as the phone had it when the bake started offline.
  recipe_snapshot: z.record(z.unknown()).optional(),
  steps: z.array(pushBakeStep).max(200).default([]),
});

const pushBody = z.object({
  recipes: z.array(pushRecipe).max(200).default([]),
  bakes: z.array(pushBake).max(500).default([]),
});

type ItemResult<T> =
  | { id: string; status: 'applied' | 'stale'; server: T | null }
  | { id: string; status: 'error'; error: { code: string; message: string }; server: T | null };

/** Runs one item in a savepoint so a bad row doesn't sink the rest of the batch. */
async function inSavepoint<T>(db: pg.PoolClient, fn: () => Promise<T>): Promise<T> {
  await db.query('SAVEPOINT sync_item');
  try {
    const result = await fn();
    await db.query('RELEASE SAVEPOINT sync_item');
    return result;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT sync_item');
    throw err;
  }
}

function asError(err: unknown) {
  if (err instanceof ApiError || err instanceof FormulaError) return { code: err.code, message: err.message };
  throw err;
}

const newer = (client: string, server: Date) => Date.parse(client) >= server.getTime();

const routes: FastifyPluginAsync = async (app) => {
  const { pool, storage } = app.deps;
  app.addHook('preHandler', requireAuth);

  app.get('/sync', async (request) => {
    const { since } = parse(pullQuery, request.query);
    const userId = request.userId;
    const { rows: timeRows } = await pool.query('SELECT clock_timestamp() AS now');
    const serverTime: Date = timeRows[0].now;

    // Own recipes (including soft deletes) and downloaded public recipes that changed.
    const { rows: recipeRows } = await pool.query(
      `SELECT r.id, r.owner_id, r.visibility, r.deleted_at FROM recipes r
       WHERE ($2::timestamptz IS NULL OR r.updated_at > $2)
         AND (r.owner_id = $1 OR r.id IN (SELECT recipe_id FROM recipe_downloads WHERE user_id = $1 AND deleted_at IS NULL))
       UNION
       SELECT r.id, r.owner_id, r.visibility, r.deleted_at FROM recipe_downloads d JOIN recipes r ON r.id = d.recipe_id
       WHERE d.user_id = $1 AND d.deleted_at IS NULL AND $2::timestamptz IS NOT NULL AND d.updated_at > $2`,
      [userId, since ?? null],
    );
    const removedDownloads = since
      ? (
          await pool.query(
            `SELECT recipe_id FROM recipe_downloads WHERE user_id = $1 AND deleted_at IS NOT NULL AND updated_at > $2`,
            [userId, since],
          )
        ).rows.map((r) => r.recipe_id as string)
      : [];

    // Own recipes come back even when deleted (as soft deletes). Someone else's recipe that was
    // deleted or made private is listed in removed_recipe_ids instead of being sent.
    const sendIds: string[] = [];
    const removed = new Set(removedDownloads);
    for (const r of recipeRows) {
      if (r.owner_id === userId) {
        if (!since && r.deleted_at) continue; // first sync doesn't need tombstones
        sendIds.push(r.id);
      } else if (!r.deleted_at && r.visibility === 'public') sendIds.push(r.id);
      else removed.add(r.id);
    }
    for (const id of sendIds) removed.delete(id);

    const { rows: bakeRows } = await pool.query(
      `SELECT id FROM bakes WHERE user_id = $1 AND ($2::timestamptz IS NULL OR updated_at > $2)
         AND ($2::timestamptz IS NOT NULL OR deleted_at IS NULL)`,
      [userId, since ?? null],
    );

    return {
      server_time: new Date(serverTime.getTime() - CURSOR_OVERLAP_MS).toISOString(),
      recipes: await loadRecipes(pool, sendIds),
      removed_recipe_ids: [...removed],
      bakes: await loadBakes(pool, bakeRows.map((r) => r.id), userId),
    };
  });

  app.post('/sync', async (request) => {
    const body = parse(pushBody, request.body);
    const userId = request.userId;
    const removedKeys: string[] = [];

    const result = await withTransaction(pool, async (db) => {
      const recipes: ItemResult<unknown>[] = [];
      for (const item of body.recipes) {
        try {
          const status = await inSavepoint(db, async () => {
            const { rows } = await db.query('SELECT owner_id, modified_at FROM recipes WHERE id = $1 FOR UPDATE', [item.id]);
            const existing = rows[0];
            if (existing && existing.owner_id !== userId) throw notFound('Recipe');
            if (existing && !newer(item.modified_at, existing.modified_at)) return 'stale' as const;
            if (item.deleted_at) {
              if (existing) {
                await db.query('UPDATE recipes SET deleted_at = $2, modified_at = $3 WHERE id = $1', [
                  item.id,
                  item.deleted_at,
                  item.modified_at,
                ]);
              }
              return 'applied' as const;
            }
            // Visibility changes need a connection (PATCH /recipes/{id}), so sync leaves it alone.
            await writeRecipe(db, userId, item, { mode: 'create', allowVisibility: false });
            return 'applied' as const;
          });
          recipes.push({ id: item.id, status, server: await loadRecipe(db, item.id) });
        } catch (err) {
          const recipe = await loadRecipe(db, item.id);
          recipes.push({
            id: item.id,
            status: 'error',
            error: asError(err),
            server: recipe && recipe.owner.id === userId ? recipe : null,
          });
        }
      }

      const bakes: ItemResult<unknown>[] = [];
      for (const item of body.bakes) {
        try {
          const status = await inSavepoint(db, async () => {
            const { rows } = await db.query('SELECT user_id, modified_at FROM bakes WHERE id = $1 FOR UPDATE', [item.id]);
            const existing = rows[0];
            if (existing && existing.user_id !== userId) throw notFound('Bake');
            if (existing && !newer(item.modified_at, existing.modified_at)) return 'stale' as const;
            if (!existing) {
              if (item.deleted_at) return 'applied' as const; // created and deleted offline
              if (item.recipe_snapshot) {
                // Started offline: keep the phone's snapshot of the recipe as it was baked.
                const recipe = await loadRecipe(db, item.recipe_id);
                if (!recipe || (recipe.owner.id !== userId && !canView(recipe, userId))) throw notFound('Recipe');
                await db.query(
                  `INSERT INTO bakes (id, recipe_id, user_id, started_at, scale_factor, target_dough_g, recipe_snapshot)
                   VALUES ($1, $2, $3, COALESCE($4, now()), COALESCE($5, 1), $6, $7)`,
                  [item.id, item.recipe_id, userId, item.started_at ?? null, item.scale_factor ?? null, item.target_dough_g ?? null, JSON.stringify(item.recipe_snapshot)],
                );
              } else {
                await getVisibleRecipe(db, item.recipe_id, userId);
                await startBake(db, userId, item.recipe_id, {
                  id: item.id,
                  scale_factor: item.scale_factor,
                  target_dough_g: item.target_dough_g ?? undefined,
                  started_at: item.started_at,
                });
              }
            }
            await db.query(
              `UPDATE bakes SET
                 started_at = COALESCE($2, started_at),
                 finished_at = CASE WHEN $3 THEN $4::timestamptz ELSE finished_at END,
                 rating = CASE WHEN $5 THEN $6 ELSE rating END,
                 notes = COALESCE($7, notes),
                 visibility = COALESCE($8::bake_visibility, visibility),
                 current_step_position = CASE WHEN $9 THEN $10 ELSE current_step_position END,
                 deleted_at = $11,
                 modified_at = $12
               WHERE id = $1`,
              [
                item.id,
                item.started_at ?? null,
                item.finished_at !== undefined,
                item.finished_at ?? null,
                item.rating !== undefined,
                item.rating ?? null,
                item.notes ?? null,
                item.visibility ?? null,
                item.current_step_position !== undefined,
                item.current_step_position ?? null,
                item.deleted_at ?? null,
                item.modified_at,
              ],
            );
            if (item.deleted_at) {
              const { rows: gone } = await db.query(
                'UPDATE media SET deleted_at = now() WHERE bake_id = $1 AND deleted_at IS NULL RETURNING storage_key',
                [item.id],
              );
              removedKeys.push(...gone.map((m) => m.storage_key as string));
            }
            for (const { step_id, ...step } of item.steps) {
              await upsertBakeStep(db, item.id, step_id, step);
            }
            return 'applied' as const;
          });
          bakes.push({ id: item.id, status, server: await loadBake(db, item.id, userId) });
        } catch (err) {
          const bake = await loadBake(db, item.id, userId);
          bakes.push({
            id: item.id,
            status: 'error',
            error: asError(err),
            server: bake && bake.user.id === userId ? bake : null,
          });
        }
      }

      return { recipes, bakes };
    });
    for (const key of removedKeys) {
      await storage.remove(key).catch((err) => request.log.warn({ err, key }, 'media delete failed'));
    }
    return result;
  });
};

export default routes;
