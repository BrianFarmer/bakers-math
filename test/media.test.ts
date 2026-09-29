import { describe, expect, it } from 'vitest';
import { countryLoaf, setupApp, signUp } from './helpers.js';

const ctx = setupApp();

async function newBake(visibility: 'private' | 'shared' = 'private') {
  const user = await signUp(ctx.app);
  const recipe = (
    await ctx.app.inject({ method: 'POST', url: '/v1/recipes', headers: user.auth, payload: { ...countryLoaf(), visibility: 'public' } })
  ).json();
  const bake = (await ctx.app.inject({ method: 'POST', url: `/v1/recipes/${recipe.id}/bakes`, headers: user.auth, payload: { visibility } })).json();
  return { user, recipe, bake };
}

describe('media', () => {
  it('uploads a photo through a presigned URL and downloads it', async () => {
    const { user, bake } = await newBake('shared');
    const photo = Buffer.from('fake jpeg bytes for the crumb shot');
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/bakes/${bake.id}/media`,
      headers: user.auth,
      payload: { kind: 'photo', content_type: 'image/jpeg', bytes: photo.length, width: 4032, height: 3024 },
    });
    expect(res.statusCode).toBe(201);
    const { media, upload } = res.json();
    expect(media.status).toBe('pending');
    expect(media.storage_key).toBeUndefined();

    // Not ready yet.
    expect((await ctx.app.inject({ method: 'POST', url: `/v1/media/${media.id}/complete`, headers: user.auth })).statusCode).toBe(409);

    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: photo });
    expect(put.status).toBe(200);

    const done = await ctx.app.inject({ method: 'POST', url: `/v1/media/${media.id}/complete`, headers: user.auth });
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe('ready');

    // Another baker can see media on a shared bake of a public recipe.
    const other = await signUp(ctx.app);
    const dl = await ctx.app.inject({ method: 'GET', url: `/v1/media/${media.id}`, headers: other.auth });
    expect(dl.statusCode).toBe(200);
    const file = await fetch(dl.json().url);
    expect(Buffer.from(await file.arrayBuffer()).equals(photo)).toBe(true);

    const withMedia = (await ctx.app.inject({ method: 'GET', url: `/v1/bakes/${bake.id}`, headers: other.auth })).json();
    expect(withMedia.media.map((m: any) => m.id)).toEqual([media.id]);

    // Only the owner can delete it.
    expect((await ctx.app.inject({ method: 'DELETE', url: `/v1/media/${media.id}`, headers: other.auth })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/v1/media/${media.id}`, headers: user.auth })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/media/${media.id}`, headers: user.auth })).statusCode).toBe(404);
  });

  it('keeps private bake media private', async () => {
    const { user, bake } = await newBake('private');
    const { media } = (
      await ctx.app.inject({
        method: 'POST',
        url: `/v1/bakes/${bake.id}/media`,
        headers: user.auth,
        payload: { kind: 'photo', content_type: 'image/png', bytes: 3 },
      })
    ).json();
    const other = await signUp(ctx.app);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/media/${media.id}`, headers: other.auth })).statusCode).toBe(404);
  });

  it('enforces size, duration and type limits', async () => {
    const { user, bake } = await newBake();
    const post = (payload: object) => ctx.app.inject({ method: 'POST', url: `/v1/bakes/${bake.id}/media`, headers: user.auth, payload });
    expect((await post({ kind: 'photo', content_type: 'image/jpeg', bytes: 21 * 1024 * 1024 })).statusCode).toBe(413);
    expect((await post({ kind: 'video', content_type: 'video/mp4', bytes: 201 * 1024 * 1024, duration_seconds: 60 })).statusCode).toBe(413);
    expect((await post({ kind: 'video', content_type: 'video/mp4', bytes: 1000, duration_seconds: 181 })).json().error.code).toBe('video_too_long');
    expect((await post({ kind: 'video', content_type: 'video/mp4', bytes: 1000 })).statusCode).toBe(400);
    expect((await post({ kind: 'photo', content_type: 'video/mp4', bytes: 1000 })).statusCode).toBe(400);
    expect((await post({ kind: 'photo', content_type: 'application/pdf', bytes: 1000 })).statusCode).toBe(400);
    expect((await post({ kind: 'video', content_type: 'video/quicktime', bytes: 150 * 1024 * 1024, duration_seconds: 175 })).statusCode).toBe(201);
  });

  it('rejects an upload whose size differs from what was declared', async () => {
    const { user, bake } = await newBake();
    const { media, upload } = (
      await ctx.app.inject({
        method: 'POST',
        url: `/v1/bakes/${bake.id}/media`,
        headers: user.auth,
        payload: { kind: 'photo', content_type: 'image/jpeg', bytes: 10 },
      })
    ).json();
    // The signed Content-Length makes storage refuse a different size outright.
    const put = await fetch(upload.url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.alloc(50) });
    expect(put.ok).toBe(false);
    expect((await ctx.app.inject({ method: 'POST', url: `/v1/media/${media.id}/complete`, headers: user.auth })).statusCode).toBe(409);
  });
});
