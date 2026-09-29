import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { decodeCursor, page, pageQuery } from '../lib/pagination.js';
import { checkUnmodifiedSince } from '../lib/preconditions.js';
import { idParams, parse, uuid } from '../lib/validate.js';
import { loadBakes } from '../services/bakes.js';
import {
  RECIPE_COLUMNS,
  getOwnRecipe,
  getVisibleRecipe,
  loadRecipe,
  recipeBodySchema,
  recipeListItem,
  writeRecipe,
} from '../services/recipes.js';

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  tag: z.string().trim().toLowerCase().max(40).optional(),
  ...pageQuery,
});
const publicQuery = listQuery.extend({ sort: z.enum(['recent']).default('recent') });

const patchBody = recipeBodySchema
  .pick({ name: true, description: true, visibility: true, tags: true, yield_count: true, yield_unit_weight_g: true, modified_at: true })
  .partial();

const copyBody = z.object({ id: uuid.optional() });

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const routes: FastifyPluginAsync = async (app) => {
  const { pool } = app.deps;
  app.addHook('preHandler', requireAuth);

  app.get('/recipes', async (request) => {
    const query = parse(listQuery, request.query);
    const cursor = decodeCursor(query.cursor);
    const { rows } = await pool.query(
      `SELECT ${RECIPE_COLUMNS}, r.updated_at::text AS sort_t FROM recipes r JOIN users u ON u.id = r.owner_id
       WHERE r.owner_id = $1 AND r.deleted_at IS NULL
         AND ($2::text IS NULL OR r.name ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR $3 = ANY(r.tags))
         AND ($4::timestamptz IS NULL OR (r.updated_at, r.id) < ($4, $5::uuid))
       ORDER BY r.updated_at DESC, r.id DESC LIMIT $6`,
      [request.userId, query.q ? escapeLike(query.q) : null, query.tag ?? null, cursor?.t ?? null, cursor?.id ?? null, query.limit + 1],
    );
    const result = page(rows, query.limit, (r) => ({ t: r.sort_t, id: r.id }));
    return { items: result.items.map(recipeListItem), next_cursor: result.next_cursor };
  });

  app.get('/public/recipes', async (request) => {
    const query = parse(publicQuery, request.query);
    const cursor = decodeCursor(query.cursor);
    const { rows } = await pool.query(
      `SELECT ${RECIPE_COLUMNS}, r.published_at::text AS sort_t FROM recipes r JOIN users u ON u.id = r.owner_id
       WHERE r.visibility = 'public' AND r.deleted_at IS NULL
         AND ($1::text IS NULL OR r.name ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR $2 = ANY(r.tags))
         AND ($3::timestamptz IS NULL OR (r.published_at, r.id) < ($3, $4::uuid))
       ORDER BY r.published_at DESC, r.id DESC LIMIT $5`,
      [query.q ? escapeLike(query.q) : null, query.tag ?? null, cursor?.t ?? null, cursor?.id ?? null, query.limit + 1],
    );
    const result = page(rows, query.limit, (r) => ({ t: r.sort_t, id: r.id }));
    return { items: result.items.map(recipeListItem), next_cursor: result.next_cursor };
  });

  app.post('/recipes', async (request, reply) => {
    const body = parse(recipeBodySchema, request.body);
    const recipe = await withTransaction(pool, async (db) => {
      const id = await writeRecipe(db, request.userId, body, { mode: 'create', allowVisibility: true });
      return loadRecipe(db, id);
    });
    return reply.status(201).send(recipe);
  });

  app.get('/recipes/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    return getVisibleRecipe(pool, id, request.userId);
  });

  app.put('/recipes/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(recipeBodySchema, request.body);
    return withTransaction(pool, async (db) => {
      await db.query('SELECT 1 FROM recipes WHERE id = $1 FOR UPDATE', [id]);
      const current = await getOwnRecipe(db, id, request.userId);
      checkUnmodifiedSince(request, current.updated_at, () => current);
      await writeRecipe(db, request.userId, body, { mode: 'update', id, allowVisibility: true });
      return loadRecipe(db, id);
    });
  });

  app.patch('/recipes/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(patchBody, request.body);
    return withTransaction(pool, async (db) => {
      const current = await getOwnRecipe(db, id, request.userId);
      checkUnmodifiedSince(request, current.updated_at, () => current);
      await db.query(
        `UPDATE recipes SET
           name = COALESCE($2, name),
           description = COALESCE($3, description),
           published_at = CASE WHEN $4::recipe_visibility = 'public' AND visibility <> 'public' THEN now() ELSE published_at END,
           visibility = COALESCE($4::recipe_visibility, visibility),
           tags = COALESCE($5, tags),
           yield_count = CASE WHEN $6 THEN $7 ELSE yield_count END,
           yield_unit_weight_g = CASE WHEN $8 THEN $9 ELSE yield_unit_weight_g END,
           modified_at = COALESCE($10, now())
         WHERE id = $1`,
        [
          id,
          body.name ?? null,
          body.description ?? null,
          body.visibility ?? null,
          body.tags ?? null,
          body.yield_count !== undefined,
          body.yield_count ?? null,
          body.yield_unit_weight_g !== undefined,
          body.yield_unit_weight_g ?? null,
          body.modified_at ?? null,
        ],
      );
      return loadRecipe(db, id);
    });
  });

  app.delete('/recipes/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const { rowCount } = await pool.query(
      `UPDATE recipes SET deleted_at = now(), modified_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
      [id, request.userId],
    );
    if (!rowCount) throw notFound('Recipe');
    return reply.status(204).send();
  });

  app.post('/recipes/:id/copy', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const body = parse(copyBody, request.body);
    const copy = await withTransaction(pool, async (db) => {
      const source = await getVisibleRecipe(db, id, request.userId);
      const newId = await writeRecipe(
        db,
        request.userId,
        {
          id: body.id,
          name: source.name,
          description: source.description,
          visibility: 'private',
          input_mode: source.input_mode,
          yield_count: source.yield_count,
          yield_unit_weight_g: source.yield_unit_weight_g,
          tags: source.tags,
          base_flour_g: source.input_mode === 'percent' ? source.summary.base_flour_g : null,
          ingredients: source.ingredients.map(({ id: _id, ...i }) => i),
          steps: source.steps.map(({ id: _id, ...s }) => s),
        },
        { mode: 'create', allowVisibility: true, copiedFromId: source.id },
      );
      return loadRecipe(db, newId);
    });
    return reply.status(201).send(copy);
  });

  app.get('/recipes/:id/shared-bakes', async (request) => {
    const { id } = parse(idParams, request.params);
    const query = parse(z.object(pageQuery), request.query);
    const cursor = decodeCursor(query.cursor);
    await getVisibleRecipe(pool, id, request.userId);
    const { rows } = await pool.query(
      `SELECT b.id, b.started_at::text AS sort_t FROM bakes b
       WHERE b.recipe_id = $1 AND b.visibility = 'shared' AND b.deleted_at IS NULL
         AND ($2::timestamptz IS NULL OR (b.started_at, b.id) < ($2, $3::uuid))
       ORDER BY b.started_at DESC, b.id DESC LIMIT $4`,
      [id, cursor?.t ?? null, cursor?.id ?? null, query.limit + 1],
    );
    const result = page(rows, query.limit, (r) => ({ t: r.sort_t, id: r.id }));
    const bakes = await loadBakes(pool, result.items.map((r) => r.id), request.userId);
    return { items: bakes, next_cursor: result.next_cursor };
  });

};

export default routes;
