import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { countryLoaf, setupApp, signUp, type TestUser } from './helpers.js';

const ctx = setupApp();

const pull = async (user: TestUser, since?: string) =>
  (await ctx.app.inject({ method: 'GET', url: `/v1/sync${since ? `?since=${encodeURIComponent(since)}` : ''}`, headers: user.auth })).json();
const push = async (user: TestUser, payload: object) =>
  ctx.app.inject({ method: 'POST', url: '/v1/sync', headers: user.auth, payload });

describe('offline sync', () => {
  it('pushes a recipe and a bake made offline, keeping their phone-made ids', async () => {
    const user = await signUp(ctx.app);
    const recipeId = randomUUID();
    const bakeId = randomUUID();
    const recipe = countryLoaf();
    const stepIds = recipe.steps.map(() => randomUUID());
    const res = await push(user, {
      recipes: [
        {
          ...recipe,
          id: recipeId,
          visibility: 'public', // ignored: visibility changes need a connection
          modified_at: '2026-09-29T08:00:00Z',
          steps: recipe.steps.map((s, i) => ({ ...s, id: stepIds[i] })),
        },
      ],
      bakes: [
        {
          id: bakeId,
          recipe_id: recipeId,
          modified_at: '2026-09-29T09:00:00Z',
          started_at: '2026-09-29T08:30:00Z',
          notes: 'Started on the train',
          steps: [{ step_id: stepIds[0], started_at: '2026-09-29T08:30:00Z', ended_at: '2026-09-29T09:00:00Z' }],
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.recipes[0]).toMatchObject({ id: recipeId, status: 'applied' });
    expect(body.recipes[0].server.visibility).toBe('private');
    expect(body.recipes[0].server.steps[0].id).toBe(stepIds[0]);
    expect(body.bakes[0]).toMatchObject({ id: bakeId, status: 'applied' });
    expect(body.bakes[0].server.recipe_snapshot.steps).toHaveLength(4);
    expect(body.bakes[0].server.steps[0].actual_seconds).toBe(1800);

    const first = await pull(user);
    expect(first.recipes.map((r: any) => r.id)).toEqual([recipeId]);
    expect(first.bakes.map((b: any) => b.id)).toEqual([bakeId]);
  });

  it('settles conflicts by the most recent save', async () => {
    const user = await signUp(ctx.app);
    const id = randomUUID();
    await push(user, { recipes: [{ ...countryLoaf(), id, name: 'Phone A 10:00', modified_at: '2026-09-29T10:00:00Z' }] });

    const older = (await push(user, { recipes: [{ ...countryLoaf(), id, name: 'Phone B 09:00', modified_at: '2026-09-29T09:00:00Z' }] })).json();
    expect(older.recipes[0].status).toBe('stale');
    expect(older.recipes[0].server.name).toBe('Phone A 10:00');

    const newer = (await push(user, { recipes: [{ ...countryLoaf(), id, name: 'Phone B 11:00', modified_at: '2026-09-29T11:00:00Z' }] })).json();
    expect(newer.recipes[0].status).toBe('applied');
    expect(newer.recipes[0].server.name).toBe('Phone B 11:00');
  });

  it('syncs deletions as soft deletes and returns only changes since the cursor', async () => {
    const user = await signUp(ctx.app);
    const keep = randomUUID();
    const drop = randomUUID();
    await push(user, {
      recipes: [
        { ...countryLoaf(), id: keep, modified_at: '2026-09-29T10:00:00Z' },
        { ...countryLoaf(), id: drop, modified_at: '2026-09-29T10:00:00Z' },
      ],
    });
    // Wait past the cursor overlap so the first pull's rows aren't repeated by the next one.
    await new Promise((r) => setTimeout(r, 5200));
    const first = await pull(user);
    expect(first.recipes).toHaveLength(2);

    const del = (await push(user, { recipes: [{ ...countryLoaf(), id: drop, modified_at: '2026-09-29T12:00:00Z', deleted_at: '2026-09-29T12:00:00Z' }] })).json();
    expect(del.recipes[0].status).toBe('applied');

    const next = await pull(user, first.server_time);
    expect(next.recipes.map((r: any) => [r.id, Boolean(r.deleted_at)])).toEqual([[drop, true]]);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/recipes/${drop}`, headers: user.auth })).statusCode).toBe(404);
  });

  it("includes downloaded public recipes and drops them when they're made private", async () => {
    const owner = await signUp(ctx.app);
    const baker = await signUp(ctx.app);
    const recipe = (
      await ctx.app.inject({ method: 'POST', url: '/v1/recipes', headers: owner.auth, payload: { ...countryLoaf(), visibility: 'public' } })
    ).json();
    expect((await ctx.app.inject({ method: 'PUT', url: `/v1/me/downloads/${recipe.id}`, headers: baker.auth })).statusCode).toBe(204);

    const first = await pull(baker);
    expect(first.recipes.map((r: any) => r.id)).toEqual([recipe.id]);

    await ctx.app.inject({ method: 'PATCH', url: `/v1/recipes/${recipe.id}`, headers: owner.auth, payload: { visibility: 'private' } });
    const next = await pull(baker, first.server_time);
    expect(next.recipes).toHaveLength(0);
    expect(next.removed_recipe_ids).toEqual([recipe.id]);
  });

  it("rejects writes to someone else's recipe without failing the batch", async () => {
    const owner = await signUp(ctx.app);
    const intruder = await signUp(ctx.app);
    const theirs = (await ctx.app.inject({ method: 'POST', url: '/v1/recipes', headers: owner.auth, payload: countryLoaf() })).json();
    const mine = randomUUID();
    const res = (
      await push(intruder, {
        recipes: [
          { ...countryLoaf(), id: theirs.id, name: 'Hijacked', modified_at: '2030-01-01T00:00:00Z' },
          { ...countryLoaf(), id: mine, modified_at: '2026-09-29T10:00:00Z' },
          { name: 'Bad', id: randomUUID(), input_mode: 'percent', ingredients: [{ name: 'F', role: 'flour', percent: 50 }], modified_at: '2026-09-29T10:00:00Z' },
        ],
      })
    ).json();
    expect(res.recipes.map((r: any) => r.status)).toEqual(['error', 'applied', 'error']);
    expect(res.recipes[0].server).toBeNull();
    expect(res.recipes[2].error.code).toBe('flour_not_100');
    const check = (await ctx.app.inject({ method: 'GET', url: `/v1/recipes/${theirs.id}`, headers: owner.auth })).json();
    expect(check.name).toBe('Country loaf');
  });
});
