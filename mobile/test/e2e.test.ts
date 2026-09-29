/**
 * End-to-end sync against a running API. Skipped unless E2E_API_URL is set:
 *   docker compose up -d        (from the repo root)
 *   E2E_API_URL=http://localhost:3000/v1 npm test
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createApi, type Tokens } from '../src/lib/api';
import { toFormula } from '../src/lib/bakersMath';
import { createSyncEngine, type LocalBake } from '../src/lib/syncEngine';
import type { Recipe } from '../src/lib/types';
import { MemoryStore } from './memoryStore';

const BASE = process.env.E2E_API_URL;

async function device(email: string, signUp: boolean) {
  let tokens: Tokens | null = null;
  const api = createApi({
    getBaseUrl: () => BASE!,
    getTokens: () => tokens,
    setTokens: (t) => {
      tokens = t;
    },
    onSignedOut: () => {},
  });
  const res = await api.anon<{ user: { id: string; display_name: string }; access_token: string; refresh_token: string }>(
    'POST',
    signUp ? '/auth/signup' : '/auth/login',
    { email, password: 'correct horse battery' },
  );
  tokens = { access_token: res.access_token, refresh_token: res.refresh_token };
  const store = new MemoryStore();
  const engine = createSyncEngine({
    api,
    store,
    userId: () => res.user.id,
    upload: async (uri, ticket) => {
      // fetch sets Content-Length itself from the body.
      const headers = Object.fromEntries(Object.entries(ticket.headers).filter(([k]) => k.toLowerCase() !== 'content-length'));
      const r = await fetch(ticket.url, { method: 'PUT', headers, body: readFileSync(uri.replace('file://', '')) });
      return r.status;
    },
  });
  return { api, store, engine, user: res.user };
}

const later = (ms: number) => new Date(Date.now() + ms).toISOString();

function countryLoaf(owner: { id: string; display_name: string }): Recipe {
  // Entered in baker's percentages with a 1000 g flour weight: the spec's worked example.
  const rows = [
    ['Bread flour', 'flour', 90],
    ['Whole wheat flour', 'flour', 10],
    ['Water', 'water', 75],
    ['Starter', 'leaven', 20],
    ['Salt', 'salt', 2],
  ] as const;
  const f = toFormula(
    'percent',
    rows.map(([name, role, percent]) => ({ id: randomUUID(), name, role, percent, grams: null, leaven_hydration: role === 'leaven' ? 100 : null })),
    1000,
  );
  return {
    id: randomUUID(),
    owner,
    name: 'Country loaf',
    description: '',
    visibility: 'private',
    input_mode: 'percent',
    yield_count: 2,
    yield_unit_weight_g: 985,
    tags: ['sourdough'],
    copied_from_id: null,
    published_at: null,
    modified_at: new Date().toISOString(),
    deleted_at: null,
    ingredients: f.ingredients,
    base_flour_g: 1000,
    steps: [
      { id: randomUUID(), title: 'Autolyse', instructions: '', timer_seconds: 1800, auto_start: false },
      { id: randomUUID(), title: 'Bulk', instructions: 'Folds every 30 min', timer_seconds: 14400, auto_start: false },
    ],
  };
}

describe.skipIf(!BASE)('sync against the API', () => {
  it('syncs an offline recipe, bake, step timings and photo; resolves conflicts; downloads public recipes', async () => {
    const email = `e2e-${randomUUID().slice(0, 8)}@example.com`;
    const phone = await device(email, true);

    // Offline: write a recipe, start a bake, time a step, take a photo.
    const recipe = countryLoaf(phone.user);
    phone.store.saveRecipe(recipe);
    const started = new Date(Date.now() - 3600_000).toISOString();
    const bake: LocalBake = {
      id: randomUUID(),
      recipe_id: recipe.id,
      started_at: started,
      finished_at: null,
      scale_factor: 1,
      target_dough_g: 1970,
      rating: 4,
      notes: 'Open crumb',
      visibility: 'shared',
      current_step_position: 1,
      recipe_snapshot: {
        id: recipe.id,
        name: recipe.name,
        input_mode: 'percent',
        ingredients: recipe.ingredients,
        steps: recipe.steps,
        summary: {} as any,
        snapshot_at: started,
      },
      modified_at: new Date().toISOString(),
      deleted_at: null,
      steps: [{ step_id: recipe.steps[0].id, started_at: started, ended_at: later(-1800_000), actual_seconds: null, note: 'Sticky at 78%' }],
      media: [],
      guided: { position: 1, timers: {}, notifications: {} },
    };
    phone.store.saveBake(bake);
    const dir = mkdtempSync(join(tmpdir(), 'bm-'));
    const photo = join(dir, 'crumb.jpg');
    writeFileSync(photo, Buffer.alloc(2048, 7));
    phone.store.media.set('m', {
      id: randomUUID(),
      bake_id: bake.id,
      kind: 'photo',
      local_uri: `file://${photo}`,
      content_type: 'image/jpeg',
      bytes: 2048,
      duration_seconds: null,
      width: 10,
      height: 10,
      status: 'pending',
      deleted: false,
      last_error: null,
      created_at: '',
    });

    const first = await phone.engine.sync();
    expect(first.errors).toEqual([]);
    expect(first.offline).toBe(false);
    expect(phone.store.outbox.size).toBe(0);
    expect(first.uploaded).toBe(1);

    const server = await phone.api.get<Recipe>(`/recipes/${recipe.id}`);
    expect(server.ingredients.map((i) => i.grams)).toEqual([900, 100, 750, 200, 20]);
    expect(server.summary!.total_dough_g).toBe(1970);
    expect(server.summary!.hydration_pct!).toBeCloseTo(77.27, 2);
    const serverBake = await phone.api.get<any>(`/bakes/${bake.id}`);
    expect(serverBake.steps[0]).toMatchObject({ step_id: recipe.steps[0].id, actual_seconds: 1800, note: 'Sticky at 78%' });
    expect(serverBake.media).toHaveLength(1);
    expect(serverBake.media[0].status).toBe('ready');
    expect(serverBake.visibility).toBe('shared');
    // The phone kept its guided-mode state through the server round trip.
    expect(phone.store.bakes.get(bake.id)!.doc.guided?.position).toBe(1);

    // A second device signs in and pulls everything.
    const tablet = await device(email, false);
    await tablet.engine.sync();
    expect(tablet.store.recipes.get(recipe.id)?.doc.name).toBe('Country loaf');
    expect(tablet.store.bakes.get(bake.id)?.doc.notes).toBe('Open crumb');

    // Both edit the recipe offline; the tablet saved last, so it wins and the phone keeps its version.
    const phoneEdit = { ...phone.store.recipes.get(recipe.id)!.doc, name: 'Phone edit', modified_at: later(1000) };
    const tabletEdit = { ...tablet.store.recipes.get(recipe.id)!.doc, name: 'Tablet edit', modified_at: later(2000) };
    phone.store.saveRecipe(phoneEdit);
    tablet.store.saveRecipe(tabletEdit);
    await tablet.engine.sync();
    const conflict = await phone.engine.sync();
    expect(conflict.errors).toEqual([]);
    expect(phone.store.recipes.get(recipe.id)!.doc.name).toBe('Tablet edit');
    expect(phone.store.versions.map((v) => v.doc.name)).toEqual(['Phone edit']);

    // Another baker downloads it once it's public, and loses it when it goes private again.
    await phone.api.patch(`/recipes/${recipe.id}`, { visibility: 'public' });
    const friend = await device(`e2e-${randomUUID().slice(0, 8)}@example.com`, true);
    await friend.api.put(`/me/downloads/${recipe.id}`);
    await friend.engine.sync();
    expect(friend.store.recipes.get(recipe.id)?.origin).toBe('download');
    // The friend bakes it offline; that syncs too.
    const friendBake: LocalBake = { ...bake, id: randomUUID(), steps: [], visibility: 'private', modified_at: new Date().toISOString() };
    friend.store.saveBake(friendBake);
    expect((await friend.engine.sync()).errors).toEqual([]);
    expect(friend.store.bakes.get(friendBake.id)?.serverKnown).toBe(true);

    await phone.api.patch(`/recipes/${recipe.id}`, { visibility: 'private' });
    await friend.engine.sync();
    expect(friend.store.recipes.has(recipe.id)).toBe(false);

    // Deleting on the phone removes it from the tablet.
    phone.store.saveRecipe({ ...phone.store.recipes.get(recipe.id)!.doc, deleted_at: later(3000), modified_at: later(3000) });
    await phone.engine.sync();
    expect(phone.store.recipes.has(recipe.id)).toBe(false);
    await tablet.engine.sync();
    expect(tablet.store.recipes.has(recipe.id)).toBe(false);
  });
});
