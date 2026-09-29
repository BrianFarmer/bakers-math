import { z } from 'zod';
import { ApiError } from './errors.js';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    throw new ApiError(400, 'validation_failed', first ? `${first.path || 'body'}: ${first.message}` : 'Invalid request', issues);
  }
  return result.data;
}

export const uuid = z.string().uuid();
export const idParams = z.object({ id: uuid });
export const isoDate = z.string().datetime({ offset: true });
