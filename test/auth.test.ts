import { describe, expect, it } from 'vitest';
import { setupApp, signUp } from './helpers.js';

const ctx = setupApp();

describe('auth and account', () => {
  it('signs up, rejects a duplicate email, and logs in', async () => {
    const user = await signUp(ctx.app);
    const dup = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: user.email.toUpperCase(), password: 'another password' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('email_taken');

    const bad = await ctx.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: user.email, password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    const good = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: 'correct horse battery' },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().access_token).toBeTruthy();
  });

  it('validates input with the standard error shape', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/v1/auth/signup', payload: { email: 'x', password: 'short' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'validation_failed' });
  });

  it('requires a token', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'unauthorized', message: 'Sign in required' } });
  });

  it('rotates refresh tokens and revokes on logout', async () => {
    const user = await signUp(ctx.app);
    const r1 = await ctx.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refresh_token: user.refresh } });
    expect(r1.statusCode).toBe(200);
    const reused = await ctx.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refresh_token: user.refresh } });
    expect(reused.statusCode).toBe(401);
    const next = r1.json().refresh_token;
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/auth/logout', payload: { refresh_token: next } })).statusCode).toBe(204);
    const after = await ctx.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refresh_token: next } });
    expect(after.statusCode).toBe(401);
  });

  it('reads and updates the profile', async () => {
    const user = await signUp(ctx.app);
    const res = await ctx.app.inject({ method: 'PATCH', url: '/v1/me', headers: user.auth, payload: { display_name: 'Brian' } });
    expect(res.json()).toMatchObject({ id: user.id, display_name: 'Brian', email: user.email });
    expect(res.json().password_hash).toBeUndefined();
  });

  it('resets a password with an emailed link', async () => {
    const user = await signUp(ctx.app);
    const unknown = await ctx.app.inject({ method: 'POST', url: '/v1/auth/password-reset', payload: { email: 'nobody@example.com' } });
    expect(unknown.statusCode).toBe(202);
    const before = ctx.resetLinks.length;
    await ctx.app.inject({ method: 'POST', url: '/v1/auth/password-reset', payload: { email: user.email } });
    expect(ctx.resetLinks.length).toBe(before + 1);
    const token = new URL(ctx.resetLinks.at(-1)!).searchParams.get('token')!;
    const confirm = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/confirm',
      payload: { token, password: 'a brand new password' },
    });
    expect(confirm.statusCode).toBe(204);
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/confirm',
      payload: { token, password: 'another new password' },
    });
    expect(again.statusCode).toBe(400);
    // Old sessions are signed out; the new password works.
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refresh_token: user.refresh } })).statusCode).toBe(401);
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user.email, password: 'a brand new password' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('deletes the account and its data', async () => {
    const user = await signUp(ctx.app);
    const { countryLoaf } = await import('./helpers.js');
    const recipe = await ctx.app.inject({ method: 'POST', url: '/v1/recipes', headers: user.auth, payload: countryLoaf() });
    expect((await ctx.app.inject({ method: 'DELETE', url: '/v1/me', headers: user.auth })).statusCode).toBe(204);
    const other = await signUp(ctx.app);
    const res = await ctx.app.inject({ method: 'GET', url: `/v1/recipes/${recipe.json().id}`, headers: other.auth });
    expect(res.statusCode).toBe(404);
  });
});
