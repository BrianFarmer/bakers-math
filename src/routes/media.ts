import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { withTransaction } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors.js';
import { idParams, parse, uuid } from '../lib/validate.js';
import { MEDIA_COLUMNS, getOwnBake, getVisibleBake, mediaItem, touchBake } from '../services/bakes.js';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

const uploadBody = z.object({
  id: uuid.optional(),
  kind: z.enum(['photo', 'video']),
  content_type: z.string().refine((t) => t in EXTENSIONS, { message: `must be one of ${Object.keys(EXTENSIONS).join(', ')}` }),
  bytes: z.number().int().positive(),
  duration_seconds: z.number().positive().nullable().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
});

function checkLimits(body: z.infer<typeof uploadBody>) {
  const isVideo = body.content_type.startsWith('video/');
  if ((body.kind === 'video') !== isVideo) throw badRequest(`content_type ${body.content_type} does not match kind ${body.kind}`);
  const max = body.kind === 'photo' ? config.media.maxPhotoBytes : config.media.maxVideoBytes;
  if (body.bytes > max) {
    throw new ApiError(413, 'media_too_large', `${body.kind === 'photo' ? 'Photos' : 'Videos'} can be up to ${max / 1024 / 1024} MB`);
  }
  if (body.kind === 'video') {
    if (body.duration_seconds == null) throw badRequest('duration_seconds is required for videos');
    if (body.duration_seconds > config.media.maxVideoSeconds) {
      throw new ApiError(413, 'video_too_long', `Videos can be up to ${config.media.maxVideoSeconds / 60} minutes`);
    }
  }
}

const routes: FastifyPluginAsync = async (app) => {
  const { pool, storage } = app.deps;
  app.addHook('preHandler', requireAuth);

  async function getMedia(id: string) {
    const { rows } = await pool.query(`SELECT ${MEDIA_COLUMNS}, storage_key FROM media WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!rows[0]) throw notFound('Media');
    return rows[0];
  }

  async function uploadTicket(media: any) {
    return {
      method: 'PUT' as const,
      url: await storage.presignUpload(media.storage_key, media.content_type, media.bytes),
      headers: { 'Content-Type': media.content_type, 'Content-Length': String(media.bytes) },
      expires_at: new Date(Date.now() + config.media.uploadUrlTtlSeconds * 1000).toISOString(),
    };
  }

  app.post('/bakes/:id/media', async (request, reply) => {
    const { id: bakeId } = parse(idParams, request.params);
    const body = parse(uploadBody, request.body);
    checkLimits(body);
    await getOwnBake(pool, bakeId, request.userId);
    const id = body.id ?? randomUUID();
    const key = `bakes/${bakeId}/${id}.${EXTENSIONS[body.content_type]}`;
    const { rows } = await pool.query(
      `INSERT INTO media (id, bake_id, user_id, kind, storage_key, content_type, bytes, duration_seconds, width, height)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO NOTHING RETURNING ${MEDIA_COLUMNS}, storage_key`,
      [id, bakeId, request.userId, body.kind, key, body.content_type, body.bytes, body.duration_seconds ?? null, body.width ?? null, body.height ?? null],
    );
    let media = rows[0];
    if (!media) {
      // Retried request for an upload that already exists: hand out a fresh URL if it's still pending.
      media = await getMedia(id);
      if (media.user_id !== request.userId || media.bake_id !== bakeId) throw notFound('Media');
      if (media.status === 'ready') throw conflict('already_uploaded', 'This file was already uploaded');
    }
    await touchBake(pool, bakeId);
    const { storage_key: _k, ...item } = mediaItem(media);
    return reply.status(201).send({ media: item, upload: await uploadTicket(media) });
  });

  app.post('/media/:id/complete', async (request) => {
    const { id } = parse(idParams, request.params);
    const media = await getMedia(id);
    if (media.user_id !== request.userId) throw notFound('Media');
    const object = await storage.head(media.storage_key);
    if (!object) throw conflict('upload_missing', 'The file has not been uploaded yet');
    if (object.bytes !== Number(media.bytes)) {
      throw conflict('upload_size_mismatch', `Uploaded ${object.bytes} bytes, expected ${media.bytes}`);
    }
    const { rows } = await withTransaction(pool, async (db) => {
      const res = await db.query(`UPDATE media SET status = 'ready' WHERE id = $1 RETURNING ${MEDIA_COLUMNS}`, [id]);
      await touchBake(db, media.bake_id);
      return res;
    });
    return mediaItem(rows[0]);
  });

  app.get('/media/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const media = await getMedia(id);
    // Visible if the caller can see the bake (own, or shared on a recipe they can see).
    await getVisibleBake(pool, media.bake_id, request.userId);
    if (media.status !== 'ready') {
      if (media.user_id !== request.userId) throw notFound('Media');
      throw conflict('upload_pending', 'This file has not finished uploading');
    }
    const { storage_key, ...item } = mediaItem(media);
    return {
      media: item,
      url: await storage.presignDownload(storage_key),
      expires_at: new Date(Date.now() + config.media.downloadUrlTtlSeconds * 1000).toISOString(),
    };
  });

  app.delete('/media/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const media = await getMedia(id);
    if (media.user_id !== request.userId) throw notFound('Media');
    await withTransaction(pool, async (db) => {
      await db.query('UPDATE media SET deleted_at = now() WHERE id = $1', [id]);
      await touchBake(db, media.bake_id);
    });
    await storage.remove(media.storage_key).catch((err) => request.log.warn({ err }, 'media delete failed'));
    return reply.status(204).send();
  });
};

export default routes;
