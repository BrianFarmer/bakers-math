import type { EntityKind, LocalBake, LocalMedia, LocalStore, Origin, OutboxItem } from '../src/lib/syncEngine';
import type { Recipe } from '../src/lib/types';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** In-memory LocalStore for tests; mirrors what the SQLite store does. */
export class MemoryStore implements LocalStore {
  recipes = new Map<string, { doc: Recipe; origin: Origin }>();
  bakes = new Map<string, { doc: LocalBake; serverKnown: boolean }>();
  versions: { kind: EntityKind; doc: any; reason: string }[] = [];
  outbox = new Map<string, OutboxItem>();
  media = new Map<string, LocalMedia>();
  cursor: string | null = null;

  /** What the app does on a local save. */
  saveRecipe(doc: Recipe) {
    this.recipes.set(doc.id, { doc: clone(doc), origin: 'own' });
    this.outbox.set(`recipe:${doc.id}`, { kind: 'recipe', id: doc.id, last_error: null });
  }
  saveBake(doc: LocalBake) {
    const prev = this.bakes.get(doc.id);
    this.bakes.set(doc.id, { doc: clone(doc), serverKnown: prev?.serverKnown ?? false });
    this.outbox.set(`bake:${doc.id}`, { kind: 'bake', id: doc.id, last_error: null });
  }

  async getRecipe(id: string) {
    const r = this.recipes.get(id);
    return r ? clone(r) : null;
  }
  async putRecipe(doc: Recipe, origin: Origin) {
    this.recipes.set(doc.id, { doc: clone(doc), origin });
  }
  async removeRecipe(id: string) {
    this.recipes.delete(id);
  }
  async getBake(id: string) {
    const b = this.bakes.get(id);
    return b ? clone(b) : null;
  }
  async putBake(doc: LocalBake, serverKnown: boolean) {
    this.bakes.set(doc.id, { doc: clone(doc), serverKnown });
  }
  async removeBake(id: string) {
    this.bakes.delete(id);
  }
  async saveVersion(kind: EntityKind, doc: any, reason: string) {
    this.versions.push({ kind, doc: clone(doc), reason });
  }
  async listOutbox() {
    return [...this.outbox.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'recipe' ? -1 : 1));
  }
  async isQueued(kind: EntityKind, id: string) {
    return this.outbox.has(`${kind}:${id}`);
  }
  async dequeue(kind: EntityKind, id: string) {
    this.outbox.delete(`${kind}:${id}`);
  }
  async markOutboxError(kind: EntityKind, id: string, message: string) {
    const item = this.outbox.get(`${kind}:${id}`);
    if (item) item.last_error = message;
  }
  async getCursor() {
    return this.cursor;
  }
  async setCursor(c: string) {
    this.cursor = c;
  }
  async listMedia(filter: 'pending' | 'deleted') {
    return [...this.media.values()].filter((m) => (filter === 'deleted' ? m.deleted : !m.deleted && m.status === 'pending'));
  }
  async setMediaStatus(id: string, status: LocalMedia['status'], lastError: string | null) {
    const m = this.media.get(id);
    if (m) Object.assign(m, { status, last_error: lastError });
  }
  async forgetMedia(id: string) {
    this.media.delete(id);
  }
}
