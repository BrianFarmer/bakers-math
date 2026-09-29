import { useEffect, useState } from 'react';
import type { Api } from '../lib/api';
import { useSession } from './session';

/** Short-lived download URLs for photos and videos on the server, cached until they expire. */
const cache = new Map<string, { url: string; expires: number }>();

async function fetchUrl(api: Api, id: string) {
  const hit = cache.get(id);
  if (hit && hit.expires > Date.now() + 30_000) return hit.url;
  const res = await api.get<{ url: string; expires_at: string }>(`/media/${id}`);
  cache.set(id, { url: res.url, expires: Date.parse(res.expires_at) });
  return res.url;
}

/** A local file wins; otherwise the server copy (null while loading or offline). */
export function useMediaUri(id: string, localUri?: string | null) {
  const { api } = useSession();
  const [uri, setUri] = useState<string | null>(localUri ?? cache.get(id)?.url ?? null);
  useEffect(() => {
    if (localUri) {
      setUri(localUri);
      return;
    }
    let alive = true;
    fetchUrl(api, id)
      .then((u) => alive && setUri(u))
      .catch(() => alive && setUri(null));
    return () => {
      alive = false;
    };
  }, [api, id, localUri]);
  return uri;
}
