/**
 * Who is signed in, the server address, and the API client. Tokens live in the secure store;
 * the baker stays signed in offline and the app refreshes tokens when the server is back.
 */
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createApi, normalizeServerUrl, type Api, type Tokens } from '../lib/api';
import type { User } from '../lib/types';
import { getKv, migrate, setKv, wipe } from './db';

const TOKENS_KEY = 'bakers-math.tokens';

interface AuthResponse extends Tokens {
  user: User;
}

interface Session {
  ready: boolean;
  user: User | null;
  serverUrl: string | null;
  api: Api;
  setServerUrl(input: string): Promise<string | null>;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, displayName: string): Promise<void>;
  signOut(): Promise<void>;
  updateUser(user: User): Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

/** In Expo Go the phone loads the app from the same computer that runs the API, so guess its address. */
export function guessServerUrl(): string | null {
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  if (!host || host === 'localhost' || host === '127.0.0.1') return null;
  return normalizeServerUrl(host);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [serverUrl, setServerUrlState] = useState<string | null>(null);
  const tokens = useRef<Tokens | null>(null);
  const url = useRef<string | null>(null);

  const clearSession = useCallback(async () => {
    tokens.current = null;
    await SecureStore.deleteItemAsync(TOKENS_KEY).catch(() => {});
    await setKv('user', null);
    setUser(null);
  }, []);

  const api = useMemo(
    () =>
      createApi({
        getBaseUrl: () => url.current,
        getTokens: () => tokens.current,
        setTokens: async (t) => {
          tokens.current = t;
          await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(t));
        },
        onSignedOut: () => {
          void clearSession();
        },
      }),
    [clearSession],
  );

  useEffect(() => {
    (async () => {
      await migrate();
      url.current = (await getKv('server_url')) ?? guessServerUrl();
      setServerUrlState(url.current);
      const saved = await SecureStore.getItemAsync(TOKENS_KEY).catch(() => null);
      const savedUser = await getKv('user');
      if (saved && savedUser) {
        tokens.current = JSON.parse(saved);
        setUser(JSON.parse(savedUser));
      }
      setReady(true);
    })().catch((e) => {
      console.error('startup failed', e);
      setReady(true);
    });
  }, []);

  const finishAuth = useCallback(async (res: AuthResponse) => {
    // Another account's data never mixes with this one's.
    const previous = await getKv('user_id');
    if (previous && previous !== res.user.id) await wipe();
    tokens.current = { access_token: res.access_token, refresh_token: res.refresh_token };
    await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(tokens.current));
    await setKv('user_id', res.user.id);
    await setKv('user', JSON.stringify(res.user));
    setUser(res.user);
  }, []);

  const value: Session = {
    ready,
    user,
    serverUrl,
    api,
    async setServerUrl(input) {
      const normalized = normalizeServerUrl(input);
      if (!normalized) return null;
      url.current = normalized;
      setServerUrlState(normalized);
      await setKv('server_url', normalized);
      return normalized;
    },
    async signIn(email, password) {
      await finishAuth(await api.anon<AuthResponse>('POST', '/auth/login', { email, password }));
    },
    async signUp(email, password, displayName) {
      await finishAuth(
        await api.anon<AuthResponse>('POST', '/auth/signup', { email, password, display_name: displayName || undefined }),
      );
    },
    async signOut() {
      const refresh = tokens.current?.refresh_token;
      if (refresh) await api.anon('POST', '/auth/logout', { refresh_token: refresh }).catch(() => {});
      await clearSession();
      await wipe();
      await setKv('user_id', null);
    },
    async updateUser(next) {
      await setKv('user', JSON.stringify(next));
      setUser(next);
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

/** For screens that only render when signed in. */
export function useUser(): User {
  const { user } = useSession();
  if (!user) throw new Error('not signed in');
  return user;
}
