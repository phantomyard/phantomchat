/**
 * Tor consensus cache — Cache Storage-backed persistence for the brotli
 * consensus + microdescriptors that webtor-rs needs during bootstrap.
 *
 * Why this exists: every Tor bootstrap refetches ~1.8 MB of raw data from
 * the local dev server (or the stale privacy-ethereum.github.io host in
 * production). The network portion is fast but arti still has to decompress
 * and parse on each launch. Persisting the raw bytes in Cache Storage means
 * subsequent launches within the TTL skip the refetch entirely and arti's
 * parser has the bytes immediately available.
 *
 * Cache Storage was chosen over IndexedDB because:
 *   - Response objects store the raw bytes with zero copy
 *   - `Cache.match()` returns a real Response that the fetch shim can
 *     return unchanged, avoiding any re-construction overhead
 *   - Quota is generous (tens of MB) for an asset this small
 *
 * TTL is a fixed 2 hours. Tor consensus documents are formally valid for
 * ~3 hours from `valid-after`; 2 hours gives comfortable headroom while
 * avoiding a stale-key catastrophe. Microdescriptors are valid much longer
 * but we use the same TTL for simplicity — they change slowly and a 2 hour
 * cache rotation is cheap.
 */

const CACHE_NAME = 'nostra-tor-consensus-v1';
const CONSENSUS_URL = '/__tor-cache__/consensus';
const MICRODESCS_URL = '/__tor-cache__/microdescriptors';
const META_URL = '/__tor-cache__/meta';
const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

interface CacheMeta {
  consensusSavedAt: number;
  microdescsSavedAt: number;
}

async function openCache(): Promise<Cache | null> {
  if(typeof caches === 'undefined') return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch{
    return null;
  }
}

async function readMeta(cache: Cache): Promise<CacheMeta | null> {
  try {
    const resp = await cache.match(META_URL);
    if(!resp) return null;
    return await resp.json() as CacheMeta;
  } catch{
    return null;
  }
}

async function writeMeta(cache: Cache, meta: CacheMeta): Promise<void> {
  try {
    await cache.put(META_URL, new Response(JSON.stringify(meta), {
      headers: {'content-type': 'application/json'}
    }));
  } catch{
    // Cache write errors are non-fatal
  }
}

function isFresh(savedAt: number): boolean {
  return Date.now() - savedAt < TTL_MS;
}

/**
 * Return a cached consensus Response if present and fresh, else null.
 * The returned Response has `application/octet-stream` content-type —
 * the caller can hand it straight back to the WASM fetch shim.
 */
export async function getCachedConsensus(): Promise<Response | null> {
  const cache = await openCache();
  if(!cache) return null;

  const meta = await readMeta(cache);
  if(!meta || !isFresh(meta.consensusSavedAt)) return null;

  const resp = await cache.match(CONSENSUS_URL);
  return resp ? resp.clone() : null;
}

/**
 * Persist a consensus Response. The caller passes a Response obtained
 * from the network fetch; we clone it so the caller can still consume it.
 */
export async function saveCachedConsensus(resp: Response): Promise<void> {
  const cache = await openCache();
  if(!cache) return;

  try {
    await cache.put(CONSENSUS_URL, resp.clone());
  } catch{
    return;
  }

  const meta = (await readMeta(cache)) ?? {
    consensusSavedAt: 0,
    microdescsSavedAt: 0
  };
  meta.consensusSavedAt = Date.now();
  await writeMeta(cache, meta);
}

export async function getCachedMicrodescs(): Promise<Response | null> {
  const cache = await openCache();
  if(!cache) return null;

  const meta = await readMeta(cache);
  if(!meta || !isFresh(meta.microdescsSavedAt)) return null;

  const resp = await cache.match(MICRODESCS_URL);
  return resp ? resp.clone() : null;
}

export async function saveCachedMicrodescs(resp: Response): Promise<void> {
  const cache = await openCache();
  if(!cache) return;

  try {
    await cache.put(MICRODESCS_URL, resp.clone());
  } catch{
    return;
  }

  const meta = (await readMeta(cache)) ?? {
    consensusSavedAt: 0,
    microdescsSavedAt: 0
  };
  meta.microdescsSavedAt = Date.now();
  await writeMeta(cache, meta);
}

/**
 * Forget everything. Useful for tests and for a future "reset Tor" button.
 */
export async function clearConsensusCache(): Promise<void> {
  if(typeof caches === 'undefined') return;
  try {
    await caches.delete(CACHE_NAME);
  } catch{
    // ignore
  }
}
