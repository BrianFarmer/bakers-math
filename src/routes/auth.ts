import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { withTransaction } from '../db.js';
import { hashPassword, issueTokens, randomToken, sha256, verifyPassword } from '../lib/auth.js';
import { ApiError, conflict, unauthorized } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { publicUser } from './me.js';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8, 'must be at least 8 characters').max(200);

const signupBody = z.object({ email, password, display_name: z.string().trim().max(80).optional() });
const loginBody = z.object({ email, password: z.string().min(1).max(200) });
const refreshBody = z.object({ refresh_token: z.string().min(1) });
const resetRequestBody = z.object({ email });
const resetConfirmBody = z.object({ token: z.string().min(1), password });

// A stable hash to compare against when the email is unknown, so login timing doesn't reveal accounts.
const dummyHash = hashPassword(randomToken());

const routes: FastifyPluginAsync = async (app) => {
  const { pool, mailer } = app.deps;

  app.post('/auth/signup', async (request, reply) => {
    const body = parse(signupBody, request.body);
    const passwordHash = await hashPassword(body.password);
    const result = await withTransaction(pool, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING *`,
        [body.email, passwordHash, body.display_name ?? body.email.split('@')[0]],
      );
      if (!rows[0]) throw conflict('email_taken', 'An account with that email already exists');
      return { user: publicUser(rows[0]), ...(await issueTokens(db, rows[0].id)) };
    });
    return reply.status(201).send(result);
  });

  app.post('/auth/login', async (request) => {
    const body = parse(loginBody, request.body);
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(email) = $1', [body.email]);
    const user = rows[0];
    const ok = await verifyPassword(body.password, user?.password_hash ?? (await dummyHash));
    if (!user || !ok) throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
    return { user: publicUser(user), ...(await issueTokens(pool, user.id)) };
  });

  app.post('/auth/refresh', async (request) => {
    const body = parse(refreshBody, request.body);
    return withTransaction(pool, async (db) => {
      // Rotate: the old refresh token is revoked as the new pair is issued.
      const { rows } = await db.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
         RETURNING user_id`,
        [sha256(body.refresh_token)],
      );
      if (!rows[0]) throw unauthorized('Refresh token is invalid or expired');
      return issueTokens(db, rows[0].user_id);
    });
  });

  app.post('/auth/logout', async (request, reply) => {
    const body = parse(refreshBody, request.body);
    await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [
      sha256(body.refresh_token),
    ]);
    return reply.status(204).send();
  });

  app.post('/auth/password-reset', async (request, reply) => {
    const body = parse(resetRequestBody, request.body);
    const { rows } = await pool.query('SELECT id, email FROM users WHERE lower(email) = $1', [body.email]);
    if (rows[0]) {
      const token = randomToken();
      await pool.query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
        [rows[0].id, sha256(token)],
      );
      const link = `${config.passwordResetUrl}?token=${encodeURIComponent(token)}`;
      await mailer.sendPasswordReset(rows[0].email, link);
    }
    // Same answer whether or not the account exists.
    return reply.status(202).send({ ok: true });
  });

  app.post('/auth/password-reset/confirm', async (request, reply) => {
    const body = parse(resetConfirmBody, request.body);
    const passwordHash = await hashPassword(body.password);
    await withTransaction(pool, async (db) => {
      const { rows } = await db.query(
        `UPDATE password_resets SET used_at = now()
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
        [sha256(body.token)],
      );
      if (!rows[0]) throw new ApiError(400, 'invalid_token', 'Reset link is invalid or has expired');
      await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, rows[0].user_id]);
      // Sign out every device.
      await db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [rows[0].user_id]);
    });
    return reply.status(204).send();
  });
};

export default routes;
