/**
 * Small client for the Bakers Math API. Knows nothing about React Native, so it runs under tests.
 * Access tokens are refreshed once on a 401; a failed refresh signs the baker out.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

/** The server couldn't be reached (offline, wrong address, computer asleep). */
export class NetworkError extends Error {
  constructor(message = "Can't reach the server") {
    super(message);
  }
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
}

export interface ApiClientOptions {
  getBaseUrl: () => string | null;
  getTokens: () => Tokens | null;
  setTokens: (tokens: Tokens) => Promise<void> | void;
  /** Called when the refresh token is rejected; the app signs out. */
  onSignedOut: () => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Accepts "192.168.1.20", "192.168.1.20:3000" or a full URL and returns ".../v1". */
export function normalizeServerUrl(input: string): string | null {
  // Plain parsing rather than URL: React Native's URL support is partial.
  const m = /^(?:(https?):\/\/)?([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?(\/[^?#]*)?$/i.exec(input.trim());
  if (!m) return null;
  const [, scheme, host, port, rawPath] = m;
  // A bare address like "192.168.1.20": the API listens on 3000.
  const portPart = port ? `:${port}` : scheme ? '' : ':3000';
  let path = (rawPath ?? '').replace(/\/+$/, '');
  if (!path.endsWith('/v1')) path = `${path}/v1`;
  return `${(scheme ?? 'http').toLowerCase()}://${host}${portPart}${path}`;
}

export function createApi(opts: ApiClientOptions) {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15000;
  let refreshing: Promise<boolean> | null = null;

  async function raw(method: Method, path: string, body: unknown, token: string | null) {
    const base = opts.getBaseUrl();
    if (!base) throw new NetworkError('Set the server address first');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
      return await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new NetworkError();
    } finally {
      clearTimeout(timer);
    }
  }

  async function parse<T>(res: Response): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const err = json?.error;
      throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `Request failed (${res.status})`, err?.details);
    }
    return json as T;
  }

  async function refresh(): Promise<boolean> {
    const tokens = opts.getTokens();
    if (!tokens) return false;
    const res = await raw('POST', '/auth/refresh', { refresh_token: tokens.refresh_token }, null);
    if (res.status === 401) {
      opts.onSignedOut();
      return false;
    }
    const next = await parse<Tokens>(res);
    await opts.setTokens({ access_token: next.access_token, refresh_token: next.refresh_token });
    return true;
  }

  async function request<T>(method: Method, path: string, body?: unknown, { auth = true } = {}): Promise<T> {
    const token = auth ? (opts.getTokens()?.access_token ?? null) : null;
    let res = await raw(method, path, body, token);
    if (res.status === 401 && auth && opts.getTokens()) {
      // One refresh at a time; concurrent requests wait for it.
      refreshing ??= refresh().finally(() => {
        refreshing = null;
      });
      if (await refreshing) res = await raw(method, path, body, opts.getTokens()?.access_token ?? null);
    }
    return parse<T>(res);
  }

  return {
    request,
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
    patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
    del: <T = void>(path: string) => request<T>('DELETE', path),
    /** Sign-up, login and password reset don't send a token. */
    anon: <T>(method: Method, path: string, body?: unknown) => request<T>(method, path, body, { auth: false }),
  };
}

export type Api = ReturnType<typeof createApi>;

export const isNetworkError = (e: unknown): e is NetworkError => e instanceof NetworkError;

/** A message fit to show the baker. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError || e instanceof NetworkError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Something went wrong';
}
