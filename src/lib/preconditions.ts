import type { FastifyRequest } from 'fastify';
import { badRequest, conflict } from './errors.js';

/**
 * Honors If-Unmodified-Since (HTTP date or ISO 8601). When the server copy changed after
 * the client's copy, responds 409 with the server version so the app can keep both.
 */
export function checkUnmodifiedSince(request: FastifyRequest, serverUpdatedAt: Date, current: () => unknown): void {
  const raw = request.headers['if-unmodified-since'];
  if (!raw || Array.isArray(raw)) return;
  const clientMs = Date.parse(raw);
  if (Number.isNaN(clientMs)) throw badRequest('If-Unmodified-Since is not a valid date');
  // HTTP dates only have second precision.
  const unit = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? 1 : 1000;
  if (Math.floor(serverUpdatedAt.getTime() / unit) > Math.floor(clientMs / unit)) {
    throw conflict('modified_since', 'This was changed on another device', { current: current() });
  }
}
