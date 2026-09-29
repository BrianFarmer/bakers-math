import { describe, expect, it } from 'vitest';
import type { Api } from '../src/lib/api';
import { NetworkError } from '../src/lib/api';
import { createSyncEngine, decidePull } from '../src/lib/syncEngine';
import type { Recipe } from '../src/lib/types';
import { MemoryStore } from './memoryStore';

const recipe = (id: string, modified_at: string, name = 'Loaf'): Recipe => ({
  id,
  owner: { id: 'me', display_name: 'Me' },
  name,
  description: '',
  visibility: 'private',
  input_mode: 'grams',
  yield_count: null,
  yield_unit_weight_g: null,
  tags: [],
  copied_from_id: null,
  published_at: null,
  modified_at,
  deleted_at: null,
  ingredients: [],
  steps: [],
});

function fakeApi(handlers: Partial<Record<'get' | 'post' | 'del', (path: string, body?: any) => any>>) {
  const call = (k: 'get' | 'post' | 'del') => async (path: string, body?: any) => {
    const h = handlers[k];
    if (!h) throw new Error(`unexpected ${k} ${path}`);
    return h(path, body);
  };
  return { get: call('get'), post: call('post'), del: call('del') } as unknown as Api;
}

const emptyPull = { server_time: '2026-09-29T10:00:00.000Z', recipes: [], removed_recipe_ids: [], bakes: [] };

describe('decidePull', () => {
  it('applies the server copy unless a newer local edit is waiting', () => {
    expect(decidePull(null, false, { modified_at: 'x' })).toBe('apply');
    expect(decidePull({ modified_at: '2026-01-02T00:00:00Z' }, false, { modified_at: '2026-01-01T00:00:00Z' })).toBe('apply');
    expect(decidePull({ modified_at: '2026-01-02T00:00:00Z' }, true, { modified_at: '2026-01-01T00:00:00Z' })).toBe('keep_local');
    expect(decidePull({ modified_at: '2026-01-01T00:00:00Z' }, true, { modified_at: '2026-01-02T00:00:00Z' })).toBe('apply_keep_old');
  });
});

describe('sync engine', () => {
  it('keeps the local version when the server says it is stale', async () => {
    const store = new MemoryStore();
    store.saveRecipe(recipe('r1', '2026-09-29T09:00:00.000Z', 'Mine'));
    const server = recipe('r1', '2026-09-29T09:30:00.000Z', 'From the tablet');
    const engine = createSyncEngine({
      store,
      userId: () => 'me',
      upload: async () => 200,
      api: fakeApi({
        post: () => ({ recipes: [{ id: 'r1', status: 'stale', server }], bakes: [] }),
        get: () => emptyPull,
      }),
    });
    const res = await engine.sync();
    expect(res.offline).toBe(false);
    expect((await store.getRecipe('r1'))!.doc.name).toBe('From the tablet');
    expect(store.versions.map((v) => v.doc.name)).toEqual(['Mine']);
    expect(store.outbox.size).toBe(0);
    expect(store.cursor).toBe(emptyPull.server_time);
  });

  it('leaves an item queued when it was edited while the push was in flight', async () => {
    const store = new MemoryStore();
    store.saveRecipe(recipe('r1', '2026-09-29T09:00:00.000Z', 'v1'));
    const engine = createSyncEngine({
      store,
      userId: () => 'me',
      upload: async () => 200,
      api: fakeApi({
        post: (_p, body) => {
          store.saveRecipe(recipe('r1', '2026-09-29T09:01:00.000Z', 'v2'));
          return { recipes: [{ id: 'r1', status: 'applied', server: { ...body.recipes[0], owner: { id: 'me' } } }], bakes: [] };
        },
        get: () => emptyPull,
      }),
    });
    await engine.sync();
    expect((await store.getRecipe('r1'))!.doc.name).toBe('v2');
    expect(await store.isQueued('recipe', 'r1')).toBe(true);
  });

  it('reports offline and keeps the queue when the server is unreachable', async () => {
    const store = new MemoryStore();
    store.saveRecipe(recipe('r1', '2026-09-29T09:00:00.000Z'));
    const engine = createSyncEngine({
      store,
      userId: () => 'me',
      upload: async () => 200,
      api: fakeApi({
        post: () => {
          throw new NetworkError();
        },
      }),
    });
    const res = await engine.sync();
    expect(res.offline).toBe(true);
    expect(store.outbox.size).toBe(1);
  });

  it('drops downloaded recipes the server says were removed', async () => {
    const store = new MemoryStore();
    await store.putRecipe({ ...recipe('pub', '2026-09-29T09:00:00.000Z'), owner: { id: 'other', display_name: 'O' } }, 'download');
    await store.putRecipe(recipe('mine', '2026-09-29T09:00:00.000Z'), 'own');
    const engine = createSyncEngine({
      store,
      userId: () => 'me',
      upload: async () => 200,
      api: fakeApi({ get: () => ({ ...emptyPull, removed_recipe_ids: ['pub', 'mine'] }) }),
    });
    await engine.sync();
    expect(store.recipes.has('pub')).toBe(false);
    expect(store.recipes.has('mine')).toBe(true);
  });

  it('uploads media only after its bake is on the server', async () => {
    const store = new MemoryStore();
    const bake: any = { id: 'b1', recipe_id: 'r1', modified_at: '2026-09-29T09:00:00.000Z', steps: [], media: [] };
    await store.putBake(bake, false);
    store.media.set('m1', {
      id: 'm1',
      bake_id: 'b1',
      kind: 'photo',
      local_uri: 'file:///m1.jpg',
      content_type: 'image/jpeg',
      bytes: 10,
      duration_seconds: null,
      width: 1,
      height: 1,
      status: 'pending',
      deleted: false,
      last_error: null,
      created_at: '',
    });
    const posted: string[] = [];
    const uploads: string[] = [];
    const engine = createSyncEngine({
      store,
      userId: () => 'me',
      upload: async (uri) => {
        uploads.push(uri);
        return 200;
      },
      api: fakeApi({
        get: () => emptyPull,
        post: (path) => {
          posted.push(path);
          return path.endsWith('/media') ? { upload: { method: 'PUT', url: 'http://s3/put', headers: {} } } : {};
        },
      }),
    });
    await engine.sync();
    expect(uploads).toEqual([]);
    await store.putBake(bake, true);
    await engine.sync();
    expect(uploads).toEqual(['file:///m1.jpg']);
    expect(posted).toEqual(['/bakes/b1/media', '/media/m1/complete']);
    expect(store.media.get('m1')!.status).toBe('ready');
  });
});
