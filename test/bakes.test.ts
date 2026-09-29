import { describe, expect, it } from 'vitest';
import { countryLoaf, setupApp, signUp, type TestUser } from './helpers.js';

const ctx = setupApp();

async function recipeFor(user: TestUser, extra: object = {}) {
  return (await ctx.app.inject({ method: 'POST', url: '/v1/recipes', headers: user.auth, payload: { ...countryLoaf(), ...extra } })).json();
}

describe('bakes', () => {
  it('starts a scaled bake with a recipe snapshot', async () => {
    const user = await signUp(ctx.app);
    const recipe = await recipeFor(user);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/recipes/${recipe.id}/bakes`,
      headers: user.auth,
      payload: { target_dough_g: 2 * 985 * 2 }, // two loaves of 1970 g
    });
    expect(res.statusCode).toBe(201);
    const bake = res.json();
    expect(bake.scale_factor).toBeCloseTo(2);
    expect(bake.target_dough_g).toBeCloseTo(3940);
    expect(bake.visibility).toBe('private');
    expect(bake.recipe_snapshot.ingredients[0].grams).toBeCloseTo(1800);
    expect(bake.recipe_snapshot.steps).toHaveLength(4);

    // Editing the recipe later doesn't change the bake's snapshot.
    await ctx.app.inject({ method: 'PUT', url: `/v1/recipes/${recipe.id}`, headers: user.auth, payload: { ...countryLoaf(), name: 'Changed' } });
    const again = await ctx.app.inject({ method: 'GET', url: `/v1/bakes/${bake.id}`, headers: user.auth });
    expect(again.json().recipe_snapshot.name).toBe('Country loaf');
  });

  it('records step timings, notes, rating and finishing', async () => {
    const user = await signUp(ctx.app);
    const recipe = await recipeFor(user);
    const bake = (await ctx.app.inject({ method: 'POST', url: `/v1/recipes/${recipe.id}/bakes`, headers: user.auth, payload: {} })).json();
    const stepId = recipe.steps[1].id;
    const step = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/bakes/${bake.id}/steps/${stepId}`,
      headers: user.auth,
      payload: { started_at: '2026-09-29T08:00:00Z', ended_at: '2026-09-29T12:15:00Z', note: 'shaping was sticky at 78%' },
    });
    expect(step.statusCode).toBe(200);
    expect(step.json().steps[0]).toMatchObject({ step_id: stepId, actual_seconds: 4.25 * 3600, note: 'shaping was sticky at 78%' });

    const unknownStep = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/bakes/${bake.id}/steps/${crypto.randomUUID()}`,
      headers: user.auth,
      payload: { note: 'x' },
    });
    expect(unknownStep.statusCode).toBe(404);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/bakes/${bake.id}`,
      headers: user.auth,
      payload: { notes: 'Great oven spring', rating: 5, finished_at: '2026-09-29T14:00:00Z', current_step_position: 3 },
    });
    expect(patched.json()).toMatchObject({ notes: 'Great oven spring', rating: 5, current_step_position: 3 });
    const bad = await ctx.app.inject({ method: 'PATCH', url: `/v1/bakes/${bake.id}`, headers: user.auth, payload: { rating: 6 } });
    expect(bad.statusCode).toBe(400);
  });

  it('lists own bakes newest first, filtered by recipe', async () => {
    const user = await signUp(ctx.app);
    const a = await recipeFor(user);
    const b = await recipeFor(user);
    for (const [r, t] of [[a, '2026-09-01T10:00:00Z'], [b, '2026-09-02T10:00:00Z'], [a, '2026-09-03T10:00:00Z']] as const) {
      await ctx.app.inject({ method: 'POST', url: `/v1/recipes/${r.id}/bakes`, headers: user.auth, payload: { started_at: t } });
    }
    const all = (await ctx.app.inject({ method: 'GET', url: '/v1/bakes', headers: user.auth })).json();
    expect(all.items.map((x: any) => new Date(x.started_at).getUTCDate())).toEqual([3, 2, 1]);
    const onlyA = (await ctx.app.inject({ method: 'GET', url: `/v1/bakes?recipe_id=${a.id}`, headers: user.auth })).json();
    expect(onlyA.items).toHaveLength(2);
  });

  it('shows shared bakes to others who can see the recipe, never private ones', async () => {
    const owner = await signUp(ctx.app);
    const baker = await signUp(ctx.app);
    const stranger = await signUp(ctx.app);
    const recipe = await recipeFor(owner, { visibility: 'public' });

    const shared = (
      await ctx.app.inject({ method: 'POST', url: `/v1/recipes/${recipe.id}/bakes`, headers: baker.auth, payload: { visibility: 'shared', notes: 'Lovely' } })
    ).json();
    const priv = (await ctx.app.inject({ method: 'POST', url: `/v1/recipes/${recipe.id}/bakes`, headers: baker.auth, payload: {} })).json();

    const list = (await ctx.app.inject({ method: 'GET', url: `/v1/recipes/${recipe.id}/shared-bakes`, headers: stranger.auth })).json();
    expect(list.items.map((x: any) => x.id)).toEqual([shared.id]);
    expect(list.items[0].user.id).toBe(baker.id);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/bakes/${shared.id}`, headers: stranger.auth })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/bakes/${priv.id}`, headers: stranger.auth })).statusCode).toBe(404);
    // Others can't edit or delete it.
    expect((await ctx.app.inject({ method: 'PATCH', url: `/v1/bakes/${shared.id}`, headers: stranger.auth, payload: { notes: 'x' } })).statusCode).toBe(404);

    // When the recipe goes private, shared bakes on it are hidden from others.
    await ctx.app.inject({ method: 'PATCH', url: `/v1/recipes/${recipe.id}`, headers: owner.auth, payload: { visibility: 'private' } });
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/bakes/${shared.id}`, headers: stranger.auth })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/recipes/${recipe.id}/shared-bakes`, headers: stranger.auth })).statusCode).toBe(404);
    // The baker still has it in their log.
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/bakes/${shared.id}`, headers: baker.auth })).statusCode).toBe(200);
  });

  it("can't bake someone else's private recipe", async () => {
    const owner = await signUp(ctx.app);
    const other = await signUp(ctx.app);
    const recipe = await recipeFor(owner);
    const res = await ctx.app.inject({ method: 'POST', url: `/v1/recipes/${recipe.id}/bakes`, headers: other.auth, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('deletes a bake', async () => {
    const user = await signUp(ctx.app);
    const recipe = await recipeFor(user);
    const bake = (await ctx.app.inject({ method: 'POST', url: `/v1/recipes/${recipe.id}/bakes`, headers: user.auth, payload: {} })).json();
    expect((await ctx.app.inject({ method: 'DELETE', url: `/v1/bakes/${bake.id}`, headers: user.auth })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/bakes/${bake.id}`, headers: user.auth })).statusCode).toBe(404);
  });
});
