import { z } from 'zod';
import { badRequest } from './errors.js';

export const pageQuery = {
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export interface Cursor {
  t: string; // sort timestamp (ISO)
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof c.t === 'string' && typeof c.id === 'string') return c;
  } catch {
    // fall through
  }
  throw badRequest('Invalid cursor');
}

/** Given limit+1 rows, trims the extra row and returns the next cursor. */
export function page<T>(rows: T[], limit: number, key: (row: T) => Cursor) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, next_cursor: hasMore && last ? encodeCursor(key(last)) : null };
}
