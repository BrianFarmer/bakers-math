import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError, createApi, normalizeServerUrl, type Tokens } from '../src/lib/api';

describe('server address', () => {
  it('accepts a bare LAN address and fills in the port and /v1', () => {
    expect(normalizeServerUrl('192.168.1.20')).toBe('http://192.168.1.20:3000/v1');
    expect(normalizeServerUrl('192.168.1.20:4000')).toBe('http://192.168.1.20:4000/v1');
    expect(normalizeServerUrl('http://192.168.1.20:3000/v1/')).toBe('http://192.168.1.20:3000/v1');
    expect(normalizeServerUrl('https://bakers.example.com')).toBe('https://bakers.example.com/v1');
    expect(normalizeServerUrl('not a url')).toBeNull();
  });
});

describe('api client', () => {
  it('refreshes the access token once on a 401 and retries', async () => {
    let tokens: Tokens | null = { access_token: 'old', refresh_token: 'r1' };
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push(`${init.method} ${url} ${init.headers.Authorization ?? ''}`);
      if (url.endsWith('/auth/refresh')) return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2' }));
      if (init.headers.Authorization === 'Bearer old') return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ ok: true }));
    }) as typeof fetch;
    const api = createApi({
      getBaseUrl: () => 'http://x/v1',
      getTokens: () => tokens,
      setTokens: (t) => {
        tokens = t;
      },
      onSignedOut: () => {},
      fetchImpl,
    });
    expect(await api.get('/me')).toEqual({ ok: true });
    expect(tokens).toEqual({ access_token: 'new', refresh_token: 'r2' });
    expect(calls).toEqual(['GET http://x/v1/me Bearer old', 'POST http://x/v1/auth/refresh ', 'GET http://x/v1/me Bearer new']);
  });

  it('signs out when the refresh token is rejected, and reports API and network errors', async () => {
    let signedOut = false;
    const api = createApi({
      getBaseUrl: () => 'http://x/v1',
      getTokens: () => ({ access_token: 'a', refresh_token: 'r' }),
      setTokens: () => {},
      onSignedOut: () => {
        signedOut = true;
      },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'nope' } }), { status: 401 })) as unknown as typeof fetch,
    });
    await expect(api.get('/me')).rejects.toBeInstanceOf(ApiError);
    expect(signedOut).toBe(true);

    const offline = createApi({
      getBaseUrl: () => 'http://x/v1',
      getTokens: () => null,
      setTokens: () => {},
      onSignedOut: () => {},
      fetchImpl: (async () => {
        throw new TypeError('Network request failed');
      }) as unknown as typeof fetch,
    });
    await expect(offline.get('/me')).rejects.toBeInstanceOf(NetworkError);
  });
});
