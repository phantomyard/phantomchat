/**
 * Canonical Blossom server list.
 *
 * Served as a static file at `/blossom.json` — same pattern as `/relays.json`.
 * The PWA fetches it on demand; phantombot should fetch the same URL so both
 * sides stay on one list. Hardcoded DEFAULT_BLOSSOM_SERVERS below is the
 * disaster net only (offline / 404 / malformed).
 *
 * Shape: `{ "servers": ["https://...", ...] }`
 *
 * Solid free public set (live write-probe 2026-07-17):
 *   nostr.download / ditto.pub / data.haus
 * Requirement: NIP-24242 + application/octet-stream (encrypted media) upload 2xx
 * and hash-matched GET. Dropped: primal (now mime-filters octet-stream),
 * band / nostr.build (mime wall), nostrmedia (paid), satellite (auth/flaky).
 * Spares if any of the three go soft: dreamith.to, almond.slidestr.net,
 * upload.iris.to, blossom-01/02.uid.ovh, cdn.hzrd149.com.
 */

export const DEFAULT_BLOSSOM_SERVERS: readonly string[] = [
  'https://nostr.download',
  'https://blossom.ditto.pub',
  'https://blossom.data.haus'
];

/** Prefer ≥2 successful totals so a single CDN dying mid-day cannot brick the note. */
export const BLOSSOM_MIRROR_MIN = 2;

let cached: readonly string[] | null = null;
let inflight: Promise<readonly string[]> | null = null;

function isHttpsBlossomUrl(u: unknown): u is string {
  return typeof u === 'string' && u.startsWith('https://') && u.length > 'https://x'.length;
}

function normalizeServer(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Test hook. When set (string or string[]), loadCanonicalBlossomServers /
 * getBlossomServers skip the network and return the override.
 * Mirror of window.__phantomchatTestBlossom used by e2e MockBlossom.
 */
function testOverride(): readonly string[] | null {
  try {
    const w: any = typeof window !== 'undefined' ? window : null;
    const override = w?.__phantomchatTestBlossom;
    if(typeof override === 'string' && override) return [normalizeServer(override)];
    if(Array.isArray(override) && override.length > 0) {
      return override.filter(isHttpsBlossomUrl).map(normalizeServer);
    }
  } catch{ /* ignore */ }
  return null;
}

/**
 * Fetch `/blossom.json`. Returns null on any failure so callers fall back to
 * DEFAULT_BLOSSOM_SERVERS. Never throws.
 */
export async function loadCanonicalBlossomServers(): Promise<readonly string[] | null> {
  if(testOverride()) return null;
  try {
    const res = await fetch('/blossom.json', {cache: 'no-cache'});
    if(!res.ok) return null;
    const data = await res.json();
    const servers: unknown = data?.servers;
    if(!Array.isArray(servers)) return null;
    const valid = servers.filter(isHttpsBlossomUrl).map(normalizeServer);
    // de-dupe, keep order
    const seen = new Set<string>();
    const out: string[] = [];
    for(const s of valid) {
      if(seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out.length > 0 ? out : null;
  } catch{
    return null;
  }
}

/**
 * Resolve the server list once per session (cached). Always returns ≥1 URL —
 * either the website list, a test override, or the disaster-net default.
 */
export async function getBlossomServers(): Promise<readonly string[]> {
  const override = testOverride();
  if(override) return override;
  if(cached) return cached;
  if(!inflight) {
    inflight = (async() => {
      const fetched = await loadCanonicalBlossomServers();
      cached = fetched && fetched.length > 0 ? fetched : DEFAULT_BLOSSOM_SERVERS;
      return cached;
    })().finally(() => { inflight = null; });
  }
  return inflight;
}

/** Sync snapshot (used by tests / callers that can't await). Prefers cache. */
export function getBlossomServersSync(): readonly string[] {
  const override = testOverride();
  if(override) return override;
  return cached ?? DEFAULT_BLOSSOM_SERVERS;
}

/** Test-only: clear the session cache so subsequent calls re-fetch. */
export function __resetBlossomServersCacheForTests(): void {
  cached = null;
  inflight = null;
}

/**
 * Build a hash-addressed mirror URL on a given server for a known sha256.
 * Blossom is content-addressed: GET {server}/{sha256} returns the same blob
 * on any server that has it (BUD-01).
 */
export function blossomHashUrl(server: string, sha256: string): string {
  return `${normalizeServer(server)}/${sha256.toLowerCase()}`;
}

/**
 * Expand a primary URL + optional mirror list + global server set into an
 * ordered unique candidate list for receive: primary → listed mirrors →
 * hash GETs on our known servers.
 */
export function expandBlossomFetchUrls(
  primaryUrl: string,
  sha256: string | undefined,
  mirrors: readonly string[] | undefined,
  knownServers: readonly string[] = getBlossomServersSync()
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (u: string | undefined) => {
    if(!u || typeof u !== 'string') return;
    const n = u.trim();
    if(!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };

  add(primaryUrl);
  if(mirrors) {
    for(const m of mirrors) add(m);
  }
  if(sha256 && /^[0-9a-fA-F]{64}$/.test(sha256)) {
    for(const s of knownServers) add(blossomHashUrl(s, sha256));
  }
  return out;
}
