/**
 * Offline sync. Everything the baker does is saved on the phone first and queued in an outbox;
 * this engine pushes the queue, pulls what changed on the server, then uploads photos and videos
 * whose bake the server already knows. The most recent save wins, and when the server's copy of
 * a recipe wins over a local edit, the local one is kept as an older version the baker can restore.
 *
 * It talks to storage and the network only through the interfaces below, so it runs under tests.
 */
import { ApiError, NetworkError, type Api } from './api';
import type { Bake, Recipe } from './types';
import type { TimerState } from './timer';

export type Origin = 'own' | 'download';
export type EntityKind = 'recipe' | 'bake';

/** Guided-mode progress that only lives on this phone. */
export interface GuidedState {
  position: number;
  timers: Record<string, TimerState>;
  /** Step ids whose "time's up" notification is scheduled, mapped to the notification id. */
  notifications: Record<string, string>;
  /** When the current step was reached; the start time for steps without a timer. */
  enteredAt?: string;
}

export type LocalBake = Bake & { guided?: GuidedState };

export interface LocalMedia {
  id: string;
  bake_id: string;
  kind: 'photo' | 'video';
  local_uri: string;
  content_type: string;
  bytes: number;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  /** pending: waiting to upload; ready: on the server. */
  status: 'pending' | 'ready';
  deleted: boolean;
  last_error: string | null;
  created_at: string;
}

export interface OutboxItem {
  kind: EntityKind;
  id: string;
  last_error: string | null;
}

export interface LocalStore {
  getRecipe(id: string): Promise<{ doc: Recipe; origin: Origin } | null>;
  putRecipe(doc: Recipe, origin: Origin): Promise<void>;
  removeRecipe(id: string): Promise<void>;
  getBake(id: string): Promise<{ doc: LocalBake; serverKnown: boolean } | null>;
  putBake(doc: LocalBake, serverKnown: boolean): Promise<void>;
  removeBake(id: string): Promise<void>;
  /** Keeps a copy that lost to a newer save, so the baker can restore it. */
  saveVersion(kind: EntityKind, doc: Recipe | LocalBake, reason: string): Promise<void>;
  listOutbox(): Promise<OutboxItem[]>;
  isQueued(kind: EntityKind, id: string): Promise<boolean>;
  dequeue(kind: EntityKind, id: string): Promise<void>;
  markOutboxError(kind: EntityKind, id: string, message: string): Promise<void>;
  getCursor(): Promise<string | null>;
  setCursor(cursor: string): Promise<void>;
  listMedia(filter: 'pending' | 'deleted'): Promise<LocalMedia[]>;
  setMediaStatus(id: string, status: LocalMedia['status'], lastError: string | null): Promise<void>;
  /** Removes the row and its local file. */
  forgetMedia(id: string): Promise<void>;
}

export interface UploadTicket {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expires_at: string;
}

/** Uploads a local file to a presigned URL; resolves with the HTTP status. */
export type Uploader = (localUri: string, ticket: UploadTicket) => Promise<number>;

export interface SyncResult {
  offline: boolean;
  pushed: number;
  pulled: number;
  uploaded: number;
  errors: string[];
}

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : 0);

/** What to do with a row pulled from the server, given the local copy. */
export function decidePull(
  local: { modified_at: string } | null,
  queued: boolean,
  server: { modified_at: string },
): 'apply' | 'keep_local' | 'apply_keep_old' {
  if (!local || !queued) return 'apply';
  // Local edits not yet pushed: the most recent save wins.
  return time(server.modified_at) > time(local.modified_at) ? 'apply_keep_old' : 'keep_local';
}

export function recipePayload(doc: Recipe) {
  return {
    id: doc.id,
    name: doc.name,
    description: doc.description ?? '',
    input_mode: doc.input_mode,
    yield_count: doc.yield_count,
    yield_unit_weight_g: doc.yield_unit_weight_g,
    tags: doc.tags,
    base_flour_g: doc.input_mode === 'percent' ? (doc.base_flour_g ?? null) : null,
    ingredients: doc.ingredients.map((i) => ({
      id: i.id,
      name: i.name,
      role: i.role,
      grams: i.grams,
      percent: i.percent,
      leaven_hydration: i.role === 'leaven' ? i.leaven_hydration : null,
    })),
    steps: doc.steps.map((s) => ({
      id: s.id,
      title: s.title,
      instructions: s.instructions,
      timer_seconds: s.timer_seconds,
      auto_start: s.auto_start,
    })),
    modified_at: doc.modified_at,
    deleted_at: doc.deleted_at,
  };
}

export function bakePayload(doc: LocalBake) {
  return {
    id: doc.id,
    recipe_id: doc.recipe_id,
    modified_at: doc.modified_at,
    deleted_at: doc.deleted_at,
    started_at: doc.started_at,
    finished_at: doc.finished_at,
    scale_factor: doc.scale_factor,
    target_dough_g: doc.target_dough_g,
    rating: doc.rating,
    notes: doc.notes,
    visibility: doc.visibility,
    current_step_position: doc.current_step_position,
    // Only used by the server when the bake was started offline.
    recipe_snapshot: doc.recipe_snapshot,
    steps: doc.steps.map((s) => ({
      step_id: s.step_id,
      started_at: s.started_at,
      ended_at: s.ended_at,
      // Left out when unknown, so the server works it out from the start and end times.
      actual_seconds: s.actual_seconds ?? undefined,
      note: s.note ?? '',
    })),
  };
}

/** Server copy of a percent-mode recipe keeps the phone's flour weight so grams still show. */
function withLocalFields(server: Recipe, local: Recipe | null): Recipe {
  const base = local?.base_flour_g ?? server.summary?.base_flour_g ?? null;
  return { ...server, base_flour_g: base };
}

function withLocalBakeFields(server: LocalBake, local: LocalBake | null): LocalBake {
  return local?.guided ? { ...server, guided: local.guided } : server;
}

type PushItemResult<T> = { id: string; status: 'applied' | 'stale' | 'error'; server: T | null; error?: { code: string; message: string } };

export function createSyncEngine(deps: { api: Api; store: LocalStore; upload: Uploader; userId: () => string | null }) {
  const { api, store } = deps;

  async function push(result: SyncResult) {
    const queue = await store.listOutbox();
    if (!queue.length) return;
    const recipes: { payload: ReturnType<typeof recipePayload>; modified_at: string }[] = [];
    const bakes: { payload: ReturnType<typeof bakePayload>; modified_at: string }[] = [];
    for (const item of queue) {
      if (item.kind === 'recipe') {
        const row = await store.getRecipe(item.id);
        if (!row || row.origin !== 'own') {
          await store.dequeue('recipe', item.id);
          continue;
        }
        recipes.push({ payload: recipePayload(row.doc), modified_at: row.doc.modified_at });
      } else {
        const row = await store.getBake(item.id);
        if (!row) {
          await store.dequeue('bake', item.id);
          continue;
        }
        bakes.push({ payload: bakePayload(row.doc), modified_at: row.doc.modified_at });
      }
    }
    if (!recipes.length && !bakes.length) return;

    // Recipes before bakes, in the same request: a bake of a recipe made offline needs the recipe.
    const res = await api.post<{ recipes: PushItemResult<Recipe>[]; bakes: PushItemResult<LocalBake>[] }>('/sync', {
      recipes: recipes.map((r) => r.payload),
      bakes: bakes.map((b) => b.payload),
    });

    for (const [i, r] of res.recipes.entries()) {
      const sentAt = recipes[i]?.modified_at;
      const local = await store.getRecipe(r.id);
      // Edited again while the request was in flight: keep it queued for next time.
      const editedSince = local && local.doc.modified_at !== sentAt;
      if (r.status === 'error') {
        result.errors.push(`${local?.doc.name ?? 'Recipe'}: ${r.error?.message ?? 'rejected'}`);
        await store.markOutboxError('recipe', r.id, r.error?.message ?? 'rejected');
        continue;
      }
      if (r.status === 'stale' && local && !editedSince) {
        await store.saveVersion('recipe', local.doc, 'A newer save from another device replaced this version');
      }
      if (!editedSince) {
        if (r.server?.deleted_at) await store.removeRecipe(r.id);
        else if (r.server) await store.putRecipe(withLocalFields(r.server, local?.doc ?? null), 'own');
        else if (local?.doc.deleted_at) await store.removeRecipe(r.id);
        await store.dequeue('recipe', r.id);
      }
      result.pushed++;
    }

    for (const [i, b] of res.bakes.entries()) {
      const sentAt = bakes[i]?.modified_at;
      const local = await store.getBake(b.id);
      const editedSince = local && local.doc.modified_at !== sentAt;
      if (b.status === 'error') {
        result.errors.push(`Bake: ${b.error?.message ?? 'rejected'}`);
        await store.markOutboxError('bake', b.id, b.error?.message ?? 'rejected');
        continue;
      }
      if (b.status === 'stale' && local && !editedSince) {
        await store.saveVersion('bake', local.doc, 'A newer save from another device replaced this version');
      }
      if (!editedSince) {
        if (b.server?.deleted_at || (!b.server && local?.doc.deleted_at)) await store.removeBake(b.id);
        else if (b.server) await store.putBake(withLocalBakeFields(b.server, local?.doc ?? null), true);
        await store.dequeue('bake', b.id);
      } else if (local) {
        // Still queued, but the server has it now, so its media can upload.
        await store.putBake(local.doc, true);
      }
      result.pushed++;
    }
  }

  async function pull(result: SyncResult) {
    const since = await store.getCursor();
    const res = await api.get<{ server_time: string; recipes: Recipe[]; removed_recipe_ids: string[]; bakes: LocalBake[] }>(
      `/sync${since ? `?since=${encodeURIComponent(since)}` : ''}`,
    );
    const me = deps.userId();
    for (const server of res.recipes) {
      const local = await store.getRecipe(server.id);
      const origin: Origin = server.owner.id === me ? 'own' : 'download';
      const queued = origin === 'own' && (await store.isQueued('recipe', server.id));
      const decision = decidePull(local?.doc ?? null, queued, server);
      if (decision === 'keep_local') continue;
      if (decision === 'apply_keep_old' && local) {
        await store.saveVersion('recipe', local.doc, 'A newer save from another device replaced this version');
        await store.dequeue('recipe', server.id);
      }
      if (server.deleted_at) await store.removeRecipe(server.id);
      else await store.putRecipe(withLocalFields(server, local?.doc ?? null), origin);
      result.pulled++;
    }
    for (const id of res.removed_recipe_ids) {
      const local = await store.getRecipe(id);
      if (local && local.origin === 'download') {
        await store.removeRecipe(id);
        result.pulled++;
      }
    }
    for (const server of res.bakes) {
      const local = await store.getBake(server.id);
      const queued = await store.isQueued('bake', server.id);
      const decision = decidePull(local?.doc ?? null, queued, server);
      if (decision === 'keep_local') {
        if (local && !local.serverKnown) await store.putBake(local.doc, true);
        continue;
      }
      if (decision === 'apply_keep_old' && local) {
        await store.saveVersion('bake', local.doc, 'A newer save from another device replaced this version');
        await store.dequeue('bake', server.id);
      }
      if (server.deleted_at) await store.removeBake(server.id);
      else await store.putBake(withLocalBakeFields(server, local?.doc ?? null), true);
      result.pulled++;
    }
    await store.setCursor(res.server_time);
  }

  async function syncMedia(result: SyncResult) {
    for (const m of await store.listMedia('deleted')) {
      try {
        await api.del(`/media/${m.id}`);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      await store.forgetMedia(m.id);
    }
    for (const m of await store.listMedia('pending')) {
      const bake = await store.getBake(m.bake_id);
      if (!bake) {
        await store.forgetMedia(m.id);
        continue;
      }
      if (!bake.serverKnown) continue; // uploads after its bake syncs
      try {
        let ticket: UploadTicket;
        try {
          const res = await api.post<{ upload: UploadTicket }>(`/bakes/${m.bake_id}/media`, {
            id: m.id,
            kind: m.kind,
            content_type: m.content_type,
            bytes: m.bytes,
            duration_seconds: m.duration_seconds,
            width: m.width,
            height: m.height,
          });
          ticket = res.upload;
        } catch (e) {
          if (e instanceof ApiError && e.code === 'already_uploaded') {
            await store.setMediaStatus(m.id, 'ready', null);
            continue;
          }
          throw e;
        }
        const status = await deps.upload(m.local_uri, ticket);
        if (status < 200 || status >= 300) throw new Error(`Upload failed (${status})`);
        await api.post(`/media/${m.id}/complete`);
        await store.setMediaStatus(m.id, 'ready', null);
        result.uploaded++;
      } catch (e) {
        if (e instanceof NetworkError) throw e;
        const message = e instanceof Error ? e.message : 'Upload failed';
        await store.setMediaStatus(m.id, 'pending', message);
        result.errors.push(message);
      }
    }
  }

  let running: Promise<SyncResult> | null = null;

  async function run(): Promise<SyncResult> {
    const result: SyncResult = { offline: false, pushed: 0, pulled: 0, uploaded: 0, errors: [] };
    try {
      await push(result);
      await pull(result);
      await syncMedia(result);
    } catch (e) {
      if (e instanceof NetworkError) result.offline = true;
      else result.errors.push(e instanceof Error ? e.message : String(e));
    }
    return result;
  }

  return {
    /** Runs one sync; calls made while one is running share it. */
    sync(): Promise<SyncResult> {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;
