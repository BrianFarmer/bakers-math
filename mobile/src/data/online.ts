import { useCallback, useState } from 'react';
import { Alert } from 'react-native';
import { errorMessage, isNetworkError } from '../lib/api';
import type { Recipe } from '../lib/types';
import { useSync } from './sync';

/**
 * Runs something that needs the server (Discover, copying, publishing). Offline, it says so
 * instead of failing quietly, and it keeps the offline indicator honest.
 */
export function useOnlineAction() {
  const { reportReachable } = useSync();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      try {
        const result = await fn();
        reportReachable(true);
        return result;
      } catch (e) {
        if (isNetworkError(e)) {
          reportReachable(false);
          Alert.alert("You're offline", `${what} needs a connection to the server.`);
        } else {
          Alert.alert(`Couldn't ${what.toLowerCase()}`, errorMessage(e));
        }
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [reportReachable],
  );
  return { run, busy };
}

/** Public recipes opened from Discover but not downloaded, kept for this app session. */
const remote = new Map<string, Recipe>();
export const cacheRemoteRecipe = (r: Recipe) => void remote.set(r.id, r);
export const getRemoteRecipe = (id: string) => remote.get(id) ?? null;
