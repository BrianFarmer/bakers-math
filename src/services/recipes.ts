import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../db.js';
import { computeFormula, summarize, type Ingredient } from '../lib/bakersMath.js';
import { notFound } from '../lib/errors.js';
import { isoDate, uuid } from '../lib/validate.js';

const positiveNumber = z.number().finite().positive();

export const ingredientSchema = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1).max(120),
  role: z.enum(['flour', 'water', 'salt', 'leaven', 'yeast', 'other_liquid', 'other']),
  grams: z.number().finite().min(0).nullable().optional(),
  percent: z.number().finite().min(0).nullable().optional(),
  leaven_hydration: z.number().finite().min(0).max(1000).nullable().optional(),
});

export const stepSchema = z.object({
  id: uuid.optional(),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().max(10_000).default(''),
  timer_seconds: z.number().int().positive().max(7 * 24 * 3600).nullable().optional(),
  auto_start: z.boolean().default(false),
});

export const recipeBodySchema = z.object({
  id: uuid.optional(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).default(''),
  visibility: z.enum(['private', 'public']).optional(),
  input_mode: z.enum(['grams', 'percent']).default('grams'),
  yield_count: z.number().int().positive().max(1000).nullable().optional(),
  yield_unit_weight_g: positiveNumber.nullable().optional(),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(20).default([]),
  // Percent mode only: the flour weight (or target dough weight) that turns percentages into grams.
  base_flour_g: positiveNumber.nullable().optional(),
  target_dough_g: positiveNumber.nullable().optional(),
  ingredients: z.array(ingredientSchema).max(100).default([]),
  steps: z.array(stepSchema).max(200).default([]),
  // When the baker saved this version on the device; defaults to now.
  modified_at: isoDate.optional(),
});
export type RecipeBody = z.infer<typeof recipeBodySchema>;

export interface Recipe {
  id: string;
  owner: { id: string; display_name: string };
  name: string;
  description: string;
  visibility: 'private' | 'public';
  input_mode: 'grams' | 'percent';
  yield_count: number | null;
  yield_unit_weight_g: number | null;
  tags: string[];
  copied_from_id: string | null;
  published_at: Date | null;
  modified_at: Date;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
  ingredients: (Ingredient & { id: string; position: number })[];
  steps: {
    id: string;
    position: number;
    title: string;
    instructions: string;
    timer_seconds: number | null;
    auto_start: boolean;
  }[];
  summary: ReturnType<typeof summarize>;
}

export const RECIPE_COLUMNS = `r.id, r.owner_id, u.display_name AS owner_display_name, r.name, r.description, r.visibility,
  r.input_mode, r.yield_count, r.yield_unit_weight_g, r.tags, r.copied_from_id, r.published_at, r.modified_at,
  r.deleted_at, r.created_at, r.updated_at`;

export function recipeListItem(row: any) {
  return {
    id: row.id,
    owner: { id: row.owner_id, display_name: row.owner_display_name },
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    input_mode: row.input_mode,
    yield_count: row.yield_count,
    yield_unit_weight_g: row.yield_unit_weight_g,
    tags: row.tags,
    copied_from_id: row.copied_from_id,
    published_at: row.published_at,
    modified_at: row.modified_at,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Loads recipes with their ingredients and steps. Includes soft-deleted rows. */
export async function loadRecipes(db: Queryable, ids: string[]): Promise<Recipe[]> {
  if (ids.length === 0) return [];
  // Sequential: a PoolClient inside a transaction runs one query at a time.
  const { rows: recipes } = await db.query(`SELECT ${RECIPE_COLUMNS} FROM recipes r JOIN users u ON u.id = r.owner_id WHERE r.id = ANY($1)`, [ids]);
  const { rows: ingredients } = await db.query(
      `SELECT id, recipe_id, position, name, role, grams, percent, leaven_hydration FROM ingredients
       WHERE recipe_id = ANY($1) ORDER BY position`,
      [ids],
    );
  const { rows: steps } = await db.query(
      `SELECT id, recipe_id, position, title, instructions, timer_seconds, auto_start FROM steps
       WHERE recipe_id = ANY($1) ORDER BY position`,
      [ids],
    );
  const byId = new Map<string, Recipe>();
  for (const row of recipes) {
    byId.set(row.id, { ...recipeListItem(row), ingredients: [], steps: [], summary: summarize([]) });
  }
  for (const { recipe_id, ...i } of ingredients) byId.get(recipe_id)?.ingredients.push(i);
  for (const { recipe_id, ...s } of steps) byId.get(recipe_id)?.steps.push(s);
  for (const r of byId.values()) r.summary = summarize(r.ingredients);
  // Keep the caller's order.
  return ids.map((id) => byId.get(id)).filter((r): r is Recipe => Boolean(r));
}

export async function loadRecipe(db: Queryable, id: string): Promise<Recipe | null> {
  return (await loadRecipes(db, [id]))[0] ?? null;
}

export const canView = (recipe: { owner: { id: string }; visibility: string; deleted_at: Date | null }, userId: string) =>
  !recipe.deleted_at && (recipe.owner.id === userId || recipe.visibility === 'public');

/** Loads a recipe the caller may see, else 404 (private recipes of others are not revealed). */
export async function getVisibleRecipe(db: Queryable, id: string, userId: string): Promise<Recipe> {
  const recipe = await loadRecipe(db, id);
  if (!recipe || !canView(recipe, userId)) throw notFound('Recipe');
  return recipe;
}

/** Loads a recipe the caller owns, else 404. */
export async function getOwnRecipe(db: Queryable, id: string, userId: string): Promise<Recipe> {
  const recipe = await loadRecipe(db, id);
  if (!recipe || recipe.deleted_at || recipe.owner.id !== userId) throw notFound('Recipe');
  return recipe;
}

/**
 * Writes a recipe with its ingredients and steps. Must run in a transaction.
 * - `create`: inserts (the id may come from the phone); an existing id owned by the caller is updated,
 *   so a retried create is harmless.
 * - `update`: replaces an existing recipe the caller owns.
 * `visibility` is only applied when `allowVisibility` is set (offline sync can't change it).
 */
export async function writeRecipe(
  db: Queryable,
  ownerId: string,
  body: RecipeBody,
  opts: { mode: 'create' | 'update'; id?: string; allowVisibility: boolean; copiedFromId?: string | null },
): Promise<string> {
  const ingredients = computeFormula(body.input_mode, body.ingredients, {
    baseFlourG: body.base_flour_g,
    targetDoughG: body.target_dough_g,
  });
  const id = opts.id ?? body.id ?? randomUUID();
  const visibility = opts.allowVisibility ? (body.visibility ?? null) : null;
  const params = [
    id,
    ownerId,
    body.name,
    body.description,
    body.input_mode,
    body.yield_count ?? null,
    body.yield_unit_weight_g ?? null,
    body.tags,
    visibility,
    body.modified_at ?? new Date().toISOString(),
  ];

  let written = false;
  if (opts.mode === 'create') {
    const { rowCount } = await db.query(
      `INSERT INTO recipes (id, owner_id, name, description, input_mode, yield_count, yield_unit_weight_g, tags,
                            visibility, published_at, modified_at, copied_from_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::recipe_visibility, 'private'),
               CASE WHEN $9::recipe_visibility = 'public' THEN now() END, $10, $11)
       ON CONFLICT (id) DO NOTHING`,
      [...params, opts.copiedFromId ?? null],
    );
    written = rowCount === 1;
  }
  if (!written) {
    const { rowCount } = await db.query(
      `UPDATE recipes SET name = $3, description = $4, input_mode = $5, yield_count = $6, yield_unit_weight_g = $7,
         tags = $8,
         published_at = CASE WHEN $9::recipe_visibility = 'public' AND visibility <> 'public' THEN now() ELSE published_at END,
         visibility = COALESCE($9::recipe_visibility, visibility),
         modified_at = $10, deleted_at = NULL
       WHERE id = $1 AND owner_id = $2`,
      params,
    );
    if (!rowCount) throw notFound('Recipe');
  }
  await replaceChildren(db, id, ingredients, body.steps);
  return id;
}

async function replaceChildren(db: Queryable, recipeId: string, ingredients: Ingredient[], steps: RecipeBody['steps']) {
  await db.query('DELETE FROM ingredients WHERE recipe_id = $1', [recipeId]);
  await db.query('DELETE FROM steps WHERE recipe_id = $1', [recipeId]);
  if (ingredients.length) {
    await db.query(
      `INSERT INTO ingredients (id, recipe_id, position, name, role, grams, percent, leaven_hydration)
       SELECT COALESCE(x.id, gen_random_uuid()), $1, x.position, x.name, x.role::ingredient_role, x.grams, x.percent, x.leaven_hydration
       FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, position int, name text, role text, grams numeric, percent numeric, leaven_hydration numeric)`,
      [recipeId, JSON.stringify(ingredients.map((i, position) => ({ ...i, position })))],
    );
  }
  if (steps.length) {
    await db.query(
      `INSERT INTO steps (id, recipe_id, position, title, instructions, timer_seconds, auto_start)
       SELECT COALESCE(x.id, gen_random_uuid()), $1, x.position, x.title, x.instructions, x.timer_seconds, x.auto_start
       FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, position int, title text, instructions text, timer_seconds int, auto_start boolean)`,
      [recipeId, JSON.stringify(steps.map((s, position) => ({ ...s, position })))],
    );
  }
}

/** Snapshot stored on a bake so its log still makes sense after the recipe is edited. */
export function recipeSnapshot(recipe: Recipe, scaled?: Ingredient[]) {
  const ingredients = scaled ?? recipe.ingredients;
  return {
    id: recipe.id,
    name: recipe.name,
    input_mode: recipe.input_mode,
    ingredients,
    steps: recipe.steps,
    summary: summarize(ingredients),
    snapshot_at: new Date().toISOString(),
  };
}
