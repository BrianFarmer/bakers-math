import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { idParams, parse } from '../lib/validate.js';

export function publicUser(row: any) {
  return { id: row.id, email: row.email, display_name: row.display_name, created_at: row.created_at };
}

const patchBody = z.object({ display_name: z.string().trim().min(1).max(80) }).partial();

const routes: FastifyPluginAsync = async (app) => {
  const { pool, storage } = app.deps;
  app.addHook('preHandler', requireAuth);

  app.get('/me', async (request) => {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [request.userId]);
    if (!rows[0]) throw notFound('User');
    return publicUser(rows[0]);
  });

  app.patch('/me', async (request) => {
    const body = parse(patchBody, request.body);
    const { rows } = await pool.query(
      'UPDATE users SET display_name = COALESCE($2, display_name) WHERE id = $1 RETURNING *',
      [request.userId, body.display_name ?? null],
    );
    if (!rows[0]) throw notFound('User');
    return publicUser(rows[0]);
  });

  app.delete('/me', async (request, reply) => {
    const { rows: media } = await pool.query('SELECT storage_key FROM media WHERE user_id = $1', [request.userId]);
    // Media on other bakers' bakes of this user's recipes are deleted by cascade too.
    const { rows: recipeMedia } = await pool.query(
      `SELECT m.storage_key FROM media m JOIN bakes b ON b.id = m.bake_id JOIN recipes r ON r.id = b.recipe_id
       WHERE r.owner_id = $1`,
      [request.userId],
    );
    await pool.query('DELETE FROM users WHERE id = $1', [request.userId]);
    for (const { storage_key } of [...media, ...recipeMedia]) {
      await storage.remove(storage_key).catch((err) => request.log.warn({ err, storage_key }, 'media delete failed'));
    }
    return reply.status(204).send();
  });

  app.put('/me/downloads/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const { rows } = await pool.query(
      `SELECT id FROM recipes WHERE id = $1 AND deleted_at IS NULL AND (visibility = 'public' OR owner_id = $2)`,
      [id, request.userId],
    );
    if (!rows[0]) throw notFound('Recipe');
    await pool.query(
      `INSERT INTO recipe_downloads (user_id, recipe_id) VALUES ($1, $2)
       ON CONFLICT (user_id, recipe_id) DO UPDATE SET deleted_at = NULL`,
      [request.userId, id],
    );
    return reply.status(204).send();
  });

  app.delete('/me/downloads/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const { rowCount } = await pool.query(
      'UPDATE recipe_downloads SET deleted_at = now() WHERE user_id = $1 AND recipe_id = $2 AND deleted_at IS NULL',
      [request.userId, id],
    );
    if (!rowCount) throw notFound('Download');
    return reply.status(204).send();
  });

  app.get('/me/downloads', async (request) => {
    const { rows } = await pool.query(
      `SELECT d.recipe_id, d.created_at FROM recipe_downloads d
       JOIN recipes r ON r.id = d.recipe_id AND r.deleted_at IS NULL
       WHERE d.user_id = $1 AND d.deleted_at IS NULL ORDER BY d.created_at DESC`,
      [request.userId],
    );
    return { items: rows };
  });

};

export default routes;
