import { describe, expect, it } from 'vitest';
import { countryLoaf, setupApp, signUp } from './helpers.js';

const ctx = setupApp();

describe('recipes', () => {
  it('creates a recipe, computes percentages and the summary', async () => {
    const user = await signUp(ctx.app);
    const res = await ctx.app.inject({ method: 'POST', url: '/v1/recipes', headers: user.auth, payload: countryLoaf() });
    expect(res.statusCode).toBe(201);
    const r = res.json();
    expect(r.visibility).toBe('private');
    expect(r.tags).toEqual(['sourdough', 'everyday']);
    expect(r.ingredients.map((i: any) => i.percent)).toEqual([90, 10, 75, 20, 2]);
    expect(r.steps.map((s: any) => s.position)).toEqual([0, 1, 2, 3]);
    expect(r.summary.total_dough_g).toBe(1970);
    expect(r.summary.hydration_pct).toBeCloseTo(77.27, 2);
    expect(r.owner.id).toBe(user.id);
  });

  it('accepts percent mode with a target weight and rejects flour that is not 100%', async () => {
    const user = await signUp(ctx.app);
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: user.auth,
      payload: {
        name: 'Baguette',
        input_mode: 'percent',
        target_dough_g: 1000,
        ingredients: [
          { name: 'Flour', role: 'flour', percent: 100 },
          { name: 'Water', role: 'water', percent: 70 },
          { name: 'Salt', role: 'salt', percent: 2 },
          { name: 'Yeast', role: 'yeast', percent: 0.5 },
        ],
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().summary.total_dough_g).toBeCloseTo(1000);

    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/v1/recipes',
      headers: user.auth,
      payload: { name: 'Bad', input_mode: 'percent', ingredients: [{ name: 'Flour', role: 'flour', percent: 90 }] },
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('flour_not_100');
  });

  it("hides other bakers' private recipes with 404 and shows public ones", async () => {
    const owner = await signUp(ctx.app);
    const other = await signUp(ctx.app);
    const { id } = (await ctx.app.inject({ method: 'POST', url: '/v1/recipes', headers: owner.auth, payload: countryLoaf() })).json();
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/recipes/${id}`, headers: other.auth })).statusCode).toBe(404);

    const pub = await ctx.app.inject({ method: 'PATCH', url: `/v1/recipes/${id}`, headers: owner.auth, payload: { visibility: 'public' } });
    expect(pub.json().visibility).toBe('public');
    expect(pub.json().published_at).toBeTruthy();
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/recipes/${id}`, headers: other.auth })).statusCode).toBe(200);

    // Others can't change it.
    const hijack = await ctx.app.inject({ method: 'PATCH', url: `/v1/recipes/${id}`, headers: other.auth, payload: { name: 'Mine' } });
    expect(hijack.statusCode).toBe(404);
  });

  it('lists own recipes with search, tag filter and pagination', async () => {
    const user = await signUp(ctx.app);
    for (const name of ['Rye', 'Rye 2', 'Focaccia']) {
      await ctx.app.inject({ method: 'POST', url: '/v1/recipes', headers: user.auth, payload: { ...countryLoaf(), name } });
    }
    const all = await ctx.app.inject({ method: 'GET', url: '/v1/recipes?limit=2', headers: user.auth });
    expect(all.json().items).toHaveLength(2);
    const next = await ctx.app.inject({ method: 'GET', url: `/v1/recipes?limit=2&cursor=${all.json().next_cursor}`, headers: user.auth });
    expect(next.json().items).toHaveLength(1);
    expect(next.json().next_cursor).toBeNull();
    const rye = await ctx.app.inject({ method: 'GET', url: '/v1/recipes?q=rye', headers: user.auth });
    expect(rye.json().items.map((r: any) => r.name).sort()).toEqual(['Rye', 'Rye 2']);
    const tag = await ctx.app.inject({ method: 'GET', url: '/v1/recipes?tag=sourdough', headers: user.auth });
    expect(tag.json().items).toHaveLength(3);
  });

  it('browses public recipes and copies one', async () => {
    const owner = await signUp(ctx.app);
    const other = await signUp(ctx.app);
    const unique = `Ciabatta ${Date.now()}`;
    const { id } = (
      await ctx.app.inject({
        method: 'POST',
        url: '/v1/recipes',
        headers: owner.auth,
        payload: { ...countryLoaf(), name: unique, visibility: 'public' },
      })
    ).json();
    const found = await ctx.app.inject({ method: 'GET', url: `/v1/public/recipes?q=${encodeURIComponent(unique)}`, headers: other.auth });
    expect(found.json().items.map((r: any) => r.id)).toEqual([id]);

    const copy = await ctx.app.inject({ method: 'POST', url: `/v1/recipes/${id}/copy`, headers: other.auth, payload: {} });
    expect(copy.statusCode).toBe(201);
    expect(copy.json()).toMatchObject({ copied_from_id: id, visibility: 'private', name: unique });
    expect(copy.json().owner.id).toBe(other.id);
    expect(copy.json().ingredients).toHaveLength(5);
  });

  it('replaces a recipe and honors If-Unmodified-Since', async () => {
    const user = await signUp(ctx.app);
    const created = (await ctx.app.inject({ method: 'POST', url: '/v1/recipes', headers: user.auth, payload: countryLoaf() })).json();
    const updated = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/recipes/${created.id}`,
      headers: { ...user.auth, 'if-unmodified-since': new Date(created.updated_at).toISOString() },
      payload: { ...countryLoaf(), name: 'Country loaf v2', steps: [] },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().name).toBe('Country loaf v2');
    expect(updated.json().steps).toHaveLength(0);

    // A second write based on the old copy conflicts and gets the server version back.
    const stale = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/recipes/${created.id}`,
      headers: { ...user.auth, 'if-unmodified-since': new Date(created.updated_at).toISOString() },
      payload: { ...countryLoaf(), name: 'Other device' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details.current.name).toBe('Country loaf v2');
  });

  it('soft-deletes a recipe', async () => {
    const user = await signUp(ctx.app);
    const { id } = (await ctx.app.inject({ method: 'POST', url: '/v1/recipes', headers: user.auth, payload: countryLoaf() })).json();
    expect((await ctx.app.inject({ method: 'DELETE', url: `/v1/recipes/${id}`, headers: user.auth })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/recipes/${id}`, headers: user.auth })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/v1/recipes/${id}`, headers: user.auth })).statusCode).toBe(404);
  });

  it('returns 400 for malformed ids', async () => {
    const user = await signUp(ctx.app);
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/recipes/not-a-uuid', headers: user.auth });
    expect(res.statusCode).toBe(400);
  });
});
