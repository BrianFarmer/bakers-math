/**
 * The phone's copy of the baker's data, in SQLite. Recipes and bakes are stored as the API's JSON
 * documents (the API always sends and receives them whole), with a few columns pulled out for
 * listing. The outbox holds what is waiting to sync; media rows point at files on the phone.
 */
import * as SQLite from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import type { EntityKind, LocalBake, LocalMedia, LocalStore, Origin, OutboxItem } from '../lib/syncEngine';
import type { Recipe } from '../lib/types';

let opening: Promise<SQLite.SQLiteDatabase> | null = null;
/**
 * Opened asynchronously on first use, so startup never blocks the UI thread. Every query waits
 * for the migrations, so nothing can run against a missing table.
 */
const open = () =>
  (opening ??= (async () => {
    const conn = await SQLite.openDatabaseAsync('bakers-math.db');
    await runMigrations(conn);
    return conn;
  })());

type Params = SQLite.SQLiteBindValue[];
export const db = {
  getFirstAsync: async <T>(sql: string, ...params: Params) => (await open()).getFirstAsync<T>(sql, params),
  getAllAsync: async <T>(sql: string, ...params: Params) => (await open()).getAllAsync<T>(sql, params),
  runAsync: async (sql: string, ...params: Params) => (await open()).runAsync(sql, params),
  execAsync: async (sql: string) => (await open()).execAsync(sql),
  withTransactionAsync: async (task: () => Promise<void>) => (await open()).withTransactionAsync(task),
};

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT);
  CREATE TABLE IF NOT EXISTS recipes (
    id TEXT PRIMARY KEY NOT NULL,
    origin TEXT NOT NULL,
    name TEXT NOT NULL,
    json TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS bakes (
    id TEXT PRIMARY KEY NOT NULL,
    recipe_id TEXT NOT NULL,
    json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    deleted_at TEXT,
    server_known INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS bakes_recipe ON bakes (recipe_id, started_at);
  CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    json TEXT NOT NULL,
    reason TEXT NOT NULL,
    saved_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outbox (
    kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    queued_at TEXT NOT NULL,
    last_error TEXT,
    PRIMARY KEY (kind, entity_id)
  );
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY NOT NULL,
    bake_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    local_uri TEXT NOT NULL,
    content_type TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    duration_seconds REAL,
    width INTEGER,
    height INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    deleted INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS media_bake ON media (bake_id);
  `,
];

async function runMigrations(conn: SQLite.SQLiteDatabase) {
  await conn.execAsync('PRAGMA journal_mode = WAL;');
  const row = await conn.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    await conn.withTransactionAsync(async () => {
      await conn.execAsync(MIGRATIONS[v]);
      await conn.execAsync(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Opens the database and brings its tables up to date. */
export async function migrate() {
  await open();
}

/** Removes everything the signed-in baker had on this phone. */
export async function wipe() {
  await db.execAsync(`DELETE FROM recipes; DELETE FROM bakes; DELETE FROM versions; DELETE FROM outbox; DELETE FROM media;
    DELETE FROM kv WHERE key NOT IN ('server_url', 'sound');`);
  emitChange();
}

// ---- change notifications: screens re-query when local data changes ----

type Listener = () => void;
const listeners = new Set<Listener>();
export function emitChange() {
  for (const l of listeners) l();
}
export function onChange(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Runs an async query and re-runs it whenever local data changes. */
export function useLiveQuery<T>(query: () => Promise<T>, deps: unknown[]): T | undefined {
  const [value, setValue] = useState<T>();
  const q = useRef(query);
  q.current = query;
  useEffect(() => {
    let alive = true;
    const run = () =>
      q
        .current()
        .then((v) => alive && setValue(v))
        .catch((e) => console.warn('query failed', e));
    run();
    const off = onChange(run);
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}

// ---- key/value settings ----

export async function getKv(key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string | null }>('SELECT value FROM kv WHERE key = ?', key);
  return row?.value ?? null;
}

export async function setKv(key: string, value: string | null) {
  if (value === null) await db.runAsync('DELETE FROM kv WHERE key = ?', key);
  else await db.runAsync('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
}

// ---- the sync engine's view of storage ----

interface MediaRow extends Omit<LocalMedia, 'deleted'> {
  deleted: number;
}
const toMedia = (r: MediaRow): LocalMedia => ({ ...r, deleted: !!r.deleted });

export const sqliteStore: LocalStore = {
  async getRecipe(id) {
    const row = await db.getFirstAsync<{ json: string; origin: Origin }>('SELECT json, origin FROM recipes WHERE id = ?', id);
    return row ? { doc: JSON.parse(row.json) as Recipe, origin: row.origin } : null;
  },
  async putRecipe(doc, origin) {
    await db.runAsync(
      `INSERT INTO recipes (id, origin, name, json, modified_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET origin = excluded.origin, name = excluded.name, json = excluded.json,
         modified_at = excluded.modified_at, deleted_at = excluded.deleted_at`,
      doc.id,
      origin,
      doc.name,
      JSON.stringify(doc),
      doc.modified_at,
      doc.deleted_at ?? null,
    );
    emitChange();
  },
  async removeRecipe(id) {
    await db.runAsync('DELETE FROM recipes WHERE id = ?', id);
    emitChange();
  },
  async getBake(id) {
    const row = await db.getFirstAsync<{ json: string; server_known: number }>('SELECT json, server_known FROM bakes WHERE id = ?', id);
    return row ? { doc: JSON.parse(row.json) as LocalBake, serverKnown: !!row.server_known } : null;
  },
  async putBake(doc, serverKnown) {
    await db.runAsync(
      `INSERT INTO bakes (id, recipe_id, json, started_at, deleted_at, server_known) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET recipe_id = excluded.recipe_id, json = excluded.json, started_at = excluded.started_at,
         deleted_at = excluded.deleted_at, server_known = excluded.server_known`,
      doc.id,
      doc.recipe_id,
      JSON.stringify(doc),
      doc.started_at,
      doc.deleted_at ?? null,
      serverKnown ? 1 : 0,
    );
    emitChange();
  },
  async removeBake(id) {
    await db.runAsync('DELETE FROM bakes WHERE id = ?', id);
    const media = await db.getAllAsync<{ id: string }>('SELECT id FROM media WHERE bake_id = ?', id);
    for (const m of media) await sqliteStore.forgetMedia(m.id);
    emitChange();
  },
  async saveVersion(kind, doc, reason) {
    await db.runAsync(
      'INSERT INTO versions (kind, entity_id, json, reason, saved_at) VALUES (?, ?, ?, ?, ?)',
      kind,
      doc.id,
      JSON.stringify(doc),
      reason,
      new Date().toISOString(),
    );
    emitChange();
  },
  async listOutbox() {
    // Recipes first, so a bake of a recipe made offline follows its recipe.
    return db.getAllAsync<OutboxItem>(
      `SELECT kind, entity_id AS id, last_error FROM outbox ORDER BY CASE kind WHEN 'recipe' THEN 0 ELSE 1 END, queued_at`,
    );
  },
  async isQueued(kind, id) {
    return !!(await db.getFirstAsync('SELECT 1 FROM outbox WHERE kind = ? AND entity_id = ?', kind, id));
  },
  async dequeue(kind, id) {
    await db.runAsync('DELETE FROM outbox WHERE kind = ? AND entity_id = ?', kind, id);
    emitChange();
  },
  async markOutboxError(kind, id, message) {
    await db.runAsync('UPDATE outbox SET last_error = ? WHERE kind = ? AND entity_id = ?', message, kind, id);
    emitChange();
  },
  async getCursor() {
    return getKv('sync_cursor');
  },
  async setCursor(cursor) {
    await setKv('sync_cursor', cursor);
  },
  async listMedia(filter) {
    const rows = await db.getAllAsync<MediaRow>(
      filter === 'deleted'
        ? 'SELECT * FROM media WHERE deleted = 1'
        : `SELECT * FROM media WHERE deleted = 0 AND status = 'pending' ORDER BY created_at`,
    );
    return rows.map(toMedia);
  },
  async setMediaStatus(id, status, lastError) {
    await db.runAsync('UPDATE media SET status = ?, last_error = ? WHERE id = ?', status, lastError, id);
    emitChange();
  },
  async forgetMedia(id) {
    const row = await db.getFirstAsync<{ local_uri: string }>('SELECT local_uri FROM media WHERE id = ?', id);
    await db.runAsync('DELETE FROM media WHERE id = ?', id);
    if (row) deleteLocalFile(row.local_uri);
    emitChange();
  },
};

let deleteLocalFile: (uri: string) => void = () => {};
/** Set by the media module, which owns the files (keeps this file free of file-system imports). */
export function setLocalFileDeleter(fn: (uri: string) => void) {
  deleteLocalFile = fn;
}

export async function enqueue(kind: EntityKind, id: string) {
  await db.runAsync(
    `INSERT INTO outbox (kind, entity_id, queued_at, last_error) VALUES (?, ?, ?, NULL)
     ON CONFLICT (kind, entity_id) DO UPDATE SET queued_at = excluded.queued_at, last_error = NULL`,
    kind,
    id,
    new Date().toISOString(),
  );
  emitChange();
}

export { toMedia, type MediaRow };
