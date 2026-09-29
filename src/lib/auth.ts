import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { Queryable } from '../db.js';
import { unauthorized } from './errors.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(expected, actual);
}

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'access' }, config.jwtSecret, {
    expiresIn: config.accessTokenTtlSeconds,
    algorithm: 'HS256',
  });
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
}

export async function issueTokens(db: Queryable, userId: string): Promise<TokenPair> {
  const refresh = randomToken();
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [userId, sha256(refresh), config.refreshTokenTtlDays],
  );
  return {
    access_token: signAccessToken(userId),
    refresh_token: refresh,
    token_type: 'Bearer',
    expires_in: config.accessTokenTtlSeconds,
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

/** preHandler: requires a valid access token and sets request.userId. */
export async function requireAuth(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (payload.typ !== 'access' || typeof payload.sub !== 'string') throw new Error('wrong token type');
    request.userId = payload.sub;
  } catch {
    throw unauthorized('Access token is invalid or expired');
  }
}
