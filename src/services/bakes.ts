import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../db.js';
import { scaleFormula } from '../lib/bakersMath.js';
import { notFound } from '../lib/errors.js';
import { isoDate, uuid } from '../lib/validate.js';
import { canView, getVisibleRecipe, loadRecipe, recipeSnapshot } from './recipes.js';

export const BAKE_COLUMNS = `b.id, b.recipe_id, b.user_id, u.display_name AS user_display_name, b.started_at, b.finished_at,
  b.scale_factor, b.target_dough_g, b.rating, b.notes, b.visibility, b.current_step_position, b.recipe_snapshot,
  b.modified_at, b.deleted_at, b.created_at, b.updated_at`;

export const MEDIA_COLUMNS = `id, bake_id, user_id, kind, content_type, bytes, duration_seconds, width, height, status,
  deleted_at, created_at, updated_at`;

export const bakeStepSchema = z.object({
  started_at: isoDate.nullable().optional(),
  ended_at: isoDate.nullable().optional(),
  actual_seconds: z.number().int().min(0).nullable().optional(),
  note: z.string().max(5000).optional(),
});

export const startBakeSchema = z.object({
  id: uuid.optional(),
  scale_factor: z.number().finite().positive().max(1000).optional(),
  target_dough_g: z.number().finite().positive().optional(),
  base_flour_g: z.number().finite().positive().optional(),
  started_at: isoDate.optional(),
  visibility: z.enum(['private', 'shared']).optional(),
  notes: z.string().max(20_000).optional(),
});

export const patchBakeSchema = z.object({
  notes: z.string().max(20_000).optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  visibility: z.enum(['private', 'shared']).optional(),
  current_step_position: z.number().int().min(0).nullable().optional(),
  finished_at: isoDate.nullable().optional(),
  modified_at: isoDate.optional(),
});

export interface Bake {
  id: string;
  recipe_id: string;
  user: { id: string; display_name: string };
  visibility: 'private' | 'shared';
  deleted_at: Date | null;
  updated_at: Date;
  recipe_snapshot: any;
  steps: any[];
  media: any[];
  [key: string]: unknown;
}

export function mediaItem(row: any) {
  const { user_id: _u, ...rest } = row;
  return rest;
}

/**
 * Loads bakes with their step records and media. Other bakers only see a bake's ready media.
 * Includes soft-deleted bakes (sync needs them); deleted steps and media are left out.
 */
export async function loadBakes(db: Queryable, ids: string[], viewerId: string): Promise<Bake[]> {
  if (ids.length === 0) return [];
  // Sequential: a PoolClient inside a transaction runs one query at a time.
  const { rows: bakes } = await db.query(`SELECT ${BAKE_COLUMNS} FROM bakes b JOIN users u ON u.id = b.user_id WHERE b.id = ANY($1)`, [ids]);
  const { rows: steps } = await db.query(
      `SELECT bake_id, step_id, started_at, ended_at, actual_seconds, note, updated_at FROM bake_steps
       WHERE bake_id = ANY($1) AND deleted_at IS NULL ORDER BY started_at NULLS LAST, created_at`,
      [ids],
    );
  const { rows: media } = await db.query(`SELECT ${MEDIA_COLUMNS} FROM media WHERE bake_id = ANY($1) AND deleted_at IS NULL ORDER BY created_at`, [ids]);
  const byId = new Map<string, Bake>();
  for (const { user_id, user_display_name, ...b } of bakes) {
    byId.set(b.id, { ...b, user: { id: user_id, display_name: user_display_name }, steps: [], media: [] } as Bake);
  }
  for (const { bake_id, ...s } of steps) byId.get(bake_id)?.steps.push(s);
  for (const m of media) {
    const bake = byId.get(m.bake_id);
    if (!bake) continue;
    if (m.status !== 'ready' && bake.user.id !== viewerId) continue;
    bake.media.push(mediaItem(m));
  }
  return ids.map((id) => byId.get(id)).filter((b): b is Bake => Boolean(b));
}

export async function loadBake(db: Queryable, id: string, viewerId: string): Promise<Bake | null> {
  return (await loadBakes(db, [id], viewerId))[0] ?? null;
}

/** Own bakes always; others' bakes only when shared and the recipe is visible to the caller. */
export async function getVisibleBake(db: Queryable, id: string, userId: string): Promise<Bake> {
  const bake = await loadBake(db, id, userId);
  if (!bake || bake.deleted_at) throw notFound('Bake');
  if (bake.user.id === userId) return bake;
  if (bake.visibility === 'shared') {
    const recipe = await loadRecipe(db, bake.recipe_id);
    if (recipe && canView(recipe, userId)) return bake;
  }
  throw notFound('Bake');
}

export async function getOwnBake(db: Queryable, id: string, userId: string): Promise<Bake> {
  const bake = await loadBake(db, id, userId);
  if (!bake || bake.deleted_at || bake.user.id !== userId) throw notFound('Bake');
  return bake;
}

/** Bumps a bake's updated_at so sync picks up changes to its steps and media. */
export async function touchBake(db: Queryable, bakeId: string): Promise<void> {
  await db.query('UPDATE bakes SET updated_at = clock_timestamp() WHERE id = $1', [bakeId]);
}

/** Starts a bake of a recipe the caller can see, storing the scaled recipe snapshot. */
export async function startBake(
  db: Queryable,
  userId: string,
  recipeId: string,
  body: z.infer<typeof startBakeSchema>,
): Promise<string> {
  const recipe = await getVisibleRecipe(db, recipeId, userId);
  const scaled = scaleFormula(recipe.ingredients, {
    scale_factor: body.scale_factor,
    target_dough_g: body.target_dough_g,
    base_flour_g: body.base_flour_g,
  });
  const id = body.id ?? randomUUID();
  const { rowCount } = await db.query(
    `INSERT INTO bakes (id, recipe_id, user_id, started_at, scale_factor, target_dough_g, visibility, notes, recipe_snapshot, current_step_position)
     VALUES ($1, $2, $3, COALESCE($4, now()), $5, $6, COALESCE($7::bake_visibility, 'private'), COALESCE($8, ''), $9, 0)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      recipeId,
      userId,
      body.started_at ?? null,
      scaled.scale_factor,
      scaled.target_dough_g,
      body.visibility ?? null,
      body.notes ?? null,
      JSON.stringify(recipeSnapshot(recipe, scaled.ingredients)),
    ],
  );
  if (!rowCount) {
    // A retried start with the same id is fine if it is the caller's own bake.
    await getOwnBake(db, id, userId);
  }
  return id;
}

/** Inserts or updates the record for one step of a bake. */
export async function upsertBakeStep(
  db: Queryable,
  bakeId: string,
  stepId: string,
  body: z.infer<typeof bakeStepSchema>,
): Promise<void> {
  let actual = body.actual_seconds;
  if (actual === undefined && body.started_at && body.ended_at) {
    actual = Math.max(0, Math.round((Date.parse(body.ended_at) - Date.parse(body.started_at)) / 1000));
  }
  await db.query(
    `INSERT INTO bake_steps (bake_id, step_id, started_at, ended_at, actual_seconds, note)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, ''))
     ON CONFLICT (bake_id, step_id) DO UPDATE SET
       started_at = CASE WHEN $7 THEN EXCLUDED.started_at ELSE bake_steps.started_at END,
       ended_at = CASE WHEN $8 THEN EXCLUDED.ended_at ELSE bake_steps.ended_at END,
       actual_seconds = CASE WHEN $9 THEN EXCLUDED.actual_seconds ELSE bake_steps.actual_seconds END,
       note = COALESCE($6, bake_steps.note),
       deleted_at = NULL`,
    [
      bakeId,
      stepId,
      body.started_at ?? null,
      body.ended_at ?? null,
      actual ?? null,
      body.note ?? null,
      body.started_at !== undefined,
      body.ended_at !== undefined,
      actual !== undefined,
    ],
  );
  await touchBake(db, bakeId);
}
