/**
 * What screens call to read and change local data. Every change is saved on the phone first,
 * queued in the outbox, and a sync is requested; it goes out when the server is reachable.
 */
import { randomUUID } from 'expo-crypto';
import { summarize } from '../lib/bakersMath';
import type { LocalBake, LocalMedia, Origin } from '../lib/syncEngine';
import type { Bake, Ingredient, Recipe, RecipeSnapshot, Step, User } from '../lib/types';
import { db, emitChange, enqueue, sqliteStore, toMedia, type MediaRow } from './db';

export const newId = () => randomUUID();
const now = () => new Date().toISOString();

let syncRequester: () => void = () => {};
/** Set by the sync provider; called after every local change. */
export function setSyncRequester(fn: () => void) {
  syncRequester = fn;
}

// ---- recipes ----

export interface RecipeListItem {
  id: string;
  name: string;
  origin: Origin;
  doc: Recipe;
  queued: boolean;
}

export async function listRecipes(q = ''): Promise<RecipeListItem[]> {
  const rows = await db.getAllAsync<{ id: string; name: string; origin: Origin; json: string; queued: number }>(
    `SELECT r.id, r.name, r.origin, r.json, EXISTS (SELECT 1 FROM outbox o WHERE o.kind = 'recipe' AND o.entity_id = r.id) AS queued
     FROM recipes r WHERE r.deleted_at IS NULL ORDER BY r.origin = 'download', r.modified_at DESC`,
  );
  const needle = q.trim().toLowerCase();
  return rows
    .map((r) => ({ id: r.id, name: r.name, origin: r.origin, doc: JSON.parse(r.json) as Recipe, queued: !!r.queued }))
    .filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.doc.tags.some((t) => t.includes(needle)));
}

export async function getLocalRecipe(id: string) {
  const row = await sqliteStore.getRecipe(id);
  if (!row || row.doc.deleted_at) return null;
  return row;
}

export function newRecipe(owner: User): Recipe {
  return {
    id: newId(),
    owner: { id: owner.id, display_name: owner.display_name },
    name: '',
    description: '',
    visibility: 'private',
    input_mode: 'grams',
    yield_count: null,
    yield_unit_weight_g: null,
    tags: [],
    copied_from_id: null,
    published_at: null,
    modified_at: now(),
    deleted_at: null,
    ingredients: [],
    steps: [],
    base_flour_g: null,
  };
}

export function newIngredient(role: Ingredient['role'] = 'flour'): Ingredient {
  return { id: newId(), name: '', role, grams: null, percent: null, leaven_hydration: role === 'leaven' ? 100 : null };
}

export function newStep(): Step {
  return { id: newId(), title: '', instructions: '', timer_seconds: null, auto_start: false };
}

export async function saveRecipe(doc: Recipe) {
  const saved: Recipe = { ...doc, modified_at: now(), summary: summarize(doc.ingredients) };
  await sqliteStore.putRecipe(saved, 'own');
  await enqueue('recipe', saved.id);
  syncRequester();
  return saved;
}

export async function deleteRecipe(id: string) {
  const row = await sqliteStore.getRecipe(id);
  if (!row) return;
  if (row.origin === 'download') {
    await sqliteStore.removeRecipe(id);
    return;
  }
  await sqliteStore.putRecipe({ ...row.doc, deleted_at: now(), modified_at: now() }, 'own');
  await enqueue('recipe', id);
  syncRequester();
}

/** Stores a public recipe for offline use (the server call is made by the caller). */
export async function storeDownload(doc: Recipe) {
  await sqliteStore.putRecipe(doc, 'download');
}

export async function listVersions(entityId: string) {
  const rows = await db.getAllAsync<{ id: number; json: string; reason: string; saved_at: string }>(
    'SELECT id, json, reason, saved_at FROM versions WHERE entity_id = ? ORDER BY saved_at DESC',
    entityId,
  );
  return rows.map((r) => ({ id: r.id, doc: JSON.parse(r.json) as Recipe, reason: r.reason, saved_at: r.saved_at }));
}

/** Restores an older recipe version as a new save (so it wins over the current one). */
export async function restoreVersion(versionId: number) {
  const row = await db.getFirstAsync<{ json: string; kind: string }>('SELECT json, kind FROM versions WHERE id = ?', versionId);
  if (!row || row.kind !== 'recipe') return;
  const doc = JSON.parse(row.json) as Recipe;
  const current = await sqliteStore.getRecipe(doc.id);
  if (current) await sqliteStore.saveVersion('recipe', current.doc, 'Replaced when an older version was restored');
  await db.runAsync('DELETE FROM versions WHERE id = ?', versionId);
  await saveRecipe({ ...doc, visibility: current?.doc.visibility ?? doc.visibility, deleted_at: null });
}

// ---- bakes ----

export async function listBakes(recipeId?: string): Promise<LocalBake[]> {
  const rows = recipeId
    ? await db.getAllAsync<{ json: string }>(
        'SELECT json FROM bakes WHERE recipe_id = ? AND deleted_at IS NULL ORDER BY started_at DESC',
        recipeId,
      )
    : await db.getAllAsync<{ json: string }>('SELECT json FROM bakes WHERE deleted_at IS NULL ORDER BY started_at DESC');
  return rows.map((r) => JSON.parse(r.json));
}

export async function getLocalBake(id: string) {
  const row = await sqliteStore.getBake(id);
  if (!row || row.doc.deleted_at) return null;
  return row.doc;
}

/** Starts a bake on the phone with a snapshot of the (scaled) recipe; works offline. */
export async function startBake(recipe: Recipe, scaled: Ingredient[], scaleFactor: number, targetDoughG: number | null) {
  const snapshot: RecipeSnapshot = {
    id: recipe.id,
    name: recipe.name,
    input_mode: recipe.input_mode,
    ingredients: scaled,
    steps: recipe.steps,
    summary: summarize(scaled),
    snapshot_at: now(),
  };
  const bake: LocalBake = {
    id: newId(),
    recipe_id: recipe.id,
    started_at: now(),
    finished_at: null,
    scale_factor: scaleFactor,
    target_dough_g: targetDoughG,
    rating: null,
    notes: '',
    visibility: 'private',
    current_step_position: 0,
    recipe_snapshot: snapshot,
    modified_at: now(),
    deleted_at: null,
    steps: [],
    media: [],
    guided: { position: 0, timers: {}, notifications: {}, enteredAt: now() },
  };
  await saveBake(bake);
  return bake;
}

export async function saveBake(doc: LocalBake, { sync = true } = {}) {
  const prev = await sqliteStore.getBake(doc.id);
  const saved: LocalBake = { ...doc, modified_at: now() };
  await sqliteStore.putBake(saved, prev?.serverKnown ?? false);
  await enqueue('bake', saved.id);
  if (sync) syncRequester();
  return saved;
}

/** Guided-mode timer state only lives on the phone, so saving it doesn't queue a sync. */
export async function saveGuidedState(doc: LocalBake) {
  const prev = await sqliteStore.getBake(doc.id);
  await sqliteStore.putBake({ ...(prev?.doc ?? doc), guided: doc.guided }, prev?.serverKnown ?? false);
}

export async function deleteBake(id: string) {
  const row = await sqliteStore.getBake(id);
  if (!row) return;
  await sqliteStore.putBake({ ...row.doc, deleted_at: now(), modified_at: now() }, row.serverKnown);
  await db.runAsync('UPDATE media SET deleted = 1 WHERE bake_id = ?', id);
  await enqueue('bake', id);
  syncRequester();
}

export function upsertBakeStep(bake: Bake, stepId: string, patch: Partial<Bake['steps'][number]>): Bake {
  const existing = bake.steps.find((s) => s.step_id === stepId);
  const base = existing ?? { step_id: stepId, started_at: null, ended_at: null, actual_seconds: null, note: '' };
  const next = { ...base, ...patch };
  if (next.started_at && next.ended_at && patch.actual_seconds === undefined) {
    next.actual_seconds = Math.max(0, Math.round((Date.parse(next.ended_at) - Date.parse(next.started_at)) / 1000));
  }
  return {
    ...bake,
    steps: existing ? bake.steps.map((s) => (s.step_id === stepId ? next : s)) : [...bake.steps, next],
  };
}

// ---- media ----

export async function addMedia(m: Omit<LocalMedia, 'status' | 'deleted' | 'last_error' | 'created_at'>) {
  await db.runAsync(
    `INSERT INTO media (id, bake_id, kind, local_uri, content_type, bytes, duration_seconds, width, height, status, deleted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    m.id,
    m.bake_id,
    m.kind,
    m.local_uri,
    m.content_type,
    m.bytes,
    m.duration_seconds,
    m.width,
    m.height,
    now(),
  );
  emitChange();
  syncRequester();
}

export async function listLocalMedia(bakeId?: string): Promise<LocalMedia[]> {
  const rows = bakeId
    ? await db.getAllAsync<MediaRow>('SELECT * FROM media WHERE bake_id = ? AND deleted = 0 ORDER BY created_at', bakeId)
    : await db.getAllAsync<MediaRow>('SELECT * FROM media WHERE deleted = 0 ORDER BY created_at');
  return rows.map(toMedia);
}

/**
 * Deletes a photo or video. A local-only file goes at once; one that may be on the server is
 * marked and removed there on the next sync.
 */
export async function deleteMedia(id: string, onServer: boolean) {
  const row = await db.getFirstAsync<MediaRow>('SELECT * FROM media WHERE id = ?', id);
  if (!row) {
    // Only on the server (taken on another phone): remember it so sync deletes it.
    await db.runAsync(
      `INSERT INTO media (id, bake_id, kind, local_uri, content_type, bytes, status, deleted, created_at)
       VALUES (?, '', 'photo', '', '', 0, 'ready', 1, ?)`,
      id,
      now(),
    );
  } else if (onServer || row.status === 'ready') {
    await db.runAsync('UPDATE media SET deleted = 1 WHERE id = ?', id);
  } else {
    await sqliteStore.forgetMedia(id);
  }
  emitChange();
  syncRequester();
}

// ---- sync status ----

export async function pendingCounts() {
  const outbox = await db.getFirstAsync<{ n: number; errors: number }>(
    'SELECT COUNT(*) AS n, COUNT(last_error) AS errors FROM outbox',
  );
  const media = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM media WHERE (deleted = 0 AND status = 'pending') OR deleted = 1`,
  );
  return { changes: (outbox?.n ?? 0) + (media?.n ?? 0), errors: outbox?.errors ?? 0 };
}

export async function outboxErrors() {
  return db.getAllAsync<{ kind: string; entity_id: string; last_error: string }>(
    'SELECT kind, entity_id, last_error FROM outbox WHERE last_error IS NOT NULL',
  );
}
