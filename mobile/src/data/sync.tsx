/**
 * Runs the sync engine: at start, when the app comes to the foreground, when the network comes
 * back, every minute, and shortly after any local change. Also tracks whether the server is
 * reachable, which is what "offline" means here (Wi-Fi can be up while the computer is off).
 */
import NetInfo from '@react-native-community/netinfo';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { createSyncEngine, type SyncResult } from '../lib/syncEngine';
import { db, sqliteStore, useLiveQuery } from './db';
import { uploadFile } from './media';
import { pendingCounts, setSyncRequester } from './repo';
import { useSession } from './session';

interface SyncState {
  online: boolean | null;
  syncing: boolean;
  lastResult: SyncResult | null;
  pending: { changes: number; errors: number };
  syncNow(): Promise<SyncResult | null>;
  /** Marks the server reachable or not after a direct API call. */
  reportReachable(ok: boolean): void;
}

const SyncContext = createContext<SyncState | null>(null);
const INTERVAL_MS = 60_000;
const DEBOUNCE_MS = 1500;

export function SyncProvider({ children }: { children: ReactNode }) {
  const { api, user } = useSession();
  const [online, setOnline] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);
  const pending = useLiveQuery(pendingCounts, []) ?? { changes: 0, errors: 0 };
  const userId = useRef<string | null>(user?.id ?? null);
  userId.current = user?.id ?? null;

  const engine = useMemo(
    () => createSyncEngine({ api, store: sqliteStore, upload: uploadFile, userId: () => userId.current }),
    [api],
  );

  const syncNow = useCallback(async () => {
    if (!userId.current) return null;
    setSyncing(true);
    try {
      const result = await engine.sync();
      setOnline(!result.offline);
      setLastResult(result);
      return result;
    } finally {
      setSyncing(false);
    }
  }, [engine]);

  // Local changes ask for a sync; a short debounce batches bursts of edits.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setSyncRequester(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void syncNow(), DEBOUNCE_MS);
    });
    return () => setSyncRequester(() => {});
  }, [syncNow]);

  useEffect(() => {
    if (!user) return;
    // Uploads cut off when the app was killed are retried with a fresh URL.
    void db.runAsync(`UPDATE media SET last_error = NULL WHERE status = 'pending'`);
    void syncNow();
    const interval = setInterval(() => void syncNow(), INTERVAL_MS);
    const appState = AppState.addEventListener('change', (s) => {
      if (s === 'active') void syncNow();
    });
    let wasConnected: boolean | null = null;
    const net = NetInfo.addEventListener((s) => {
      const connected = !!s.isConnected;
      if (!connected) setOnline(false);
      if (connected && wasConnected === false) void syncNow();
      wasConnected = connected;
    });
    return () => {
      clearInterval(interval);
      appState.remove();
      net();
    };
  }, [user, syncNow]);

  const value: SyncState = {
    online,
    syncing,
    lastResult,
    pending,
    syncNow,
    reportReachable: (ok) => setOnline(ok),
  };
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync() {
  const s = useContext(SyncContext);
  if (!s) throw new Error('useSync outside SyncProvider');
  return s;
}
