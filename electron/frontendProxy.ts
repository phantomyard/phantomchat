/*
 * Serves app://localhost from the live PWA.
 *
 * The app keeps its app:// origin, so existing installs keep their identity,
 * history and permission grants without any migration, while the frontend
 * ships through the PWA pipeline with no desktop rebuild.
 *
 * The service worker does not cache assets on app:// (the Cache API rejects
 * the scheme), so offline launches are served from a copy on disk:
 *  - hashed build assets never change: disk first
 *  - everything else: network first, revalidated, disk when offline
 *
 * The upstream origin is pinned. Redirects are refused, and a request whose
 * path would resolve to another origin never leaves the app.
 */
import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {buildCsp} from './csp';
import {READY_PATH, SPLASH_HTML, SPLASH_PATH} from './splash';

export const DEFAULT_FRONTEND_ORIGIN = 'https://chat.phantomyard.ai';
export const ENTRY_PATH = '/index.html';

const HASHED_ASSET = /[-.][A-Za-z0-9_-]{8}\.(?:js|mjs|css|wasm|map)$/;
const DOCUMENT = /(?:^|\/)index\.html$/;
const CACHED_NETWORK_TIMEOUT_MS = 4_000;
const UNCACHED_NETWORK_TIMEOUT_MS = 60_000;
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A packaged app only ever talks to the real site; the override is for tests. */
export function resolveFrontendOrigin(isPackaged: boolean, override: string | undefined): string {
  if(isPackaged || !override) return DEFAULT_FRONTEND_ORIGIN;
  return new URL(override).origin;
}

function securityHeaders(html?: string): Record<string, string> {
  return {
    'Content-Security-Policy': buildCsp(html),
    // Lets a frozen renderer's JS stack reach the diagnostics log.
    'Document-Policy': 'include-js-call-stacks-in-crash-reports'
  };
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {'Content-Type': 'text/html; charset=utf-8', ...securityHeaders(html)}
  });
}

type CacheEntry = {body: Buffer, contentType: string};

export type FrontendProxyOptions = {
  origin: string;
  cacheDir: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
};

export function createFrontendProxy({origin, cacheDir, fetch}: FrontendProxyOptions) {
  const fileFor = (pathname: string) => {
    const name = createHash('sha256').update(pathname).digest('hex');
    return {body: join(cacheDir, name), meta: join(cacheDir, name + '.json')};
  };

  const readCache = async(pathname: string): Promise<CacheEntry | undefined> => {
    const file = fileFor(pathname);
    try {
      const [body, meta] = await Promise.all([readFile(file.body), readFile(file.meta, 'utf8')]);
      const now = new Date();
      void utimes(file.body, now, now).catch(() => {});
      return {body, contentType: JSON.parse(meta).contentType};
    } catch{
      return undefined;
    }
  };

  const writeCache = async(pathname: string, entry: CacheEntry): Promise<void> => {
    const file = fileFor(pathname);
    const suffix = '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
    try {
      await mkdir(cacheDir, {recursive: true});
      await writeFile(file.body + suffix, entry.body);
      await writeFile(file.meta + suffix, JSON.stringify({contentType: entry.contentType}));
      await rename(file.body + suffix, file.body);
      await rename(file.meta + suffix, file.meta);
    } catch(err) {
      console.error('frontend cache write failed', err);
      await Promise.all([rm(file.body + suffix, {force: true}), rm(file.meta + suffix, {force: true})]);
    }
  };

  const respond = (entry: CacheEntry, isDocument: boolean): Response => {
    const html = isDocument ? entry.body.toString('utf8') : undefined;
    return new Response(new Uint8Array(entry.body), {
      status: 200,
      headers: {'Content-Type': entry.contentType, ...securityHeaders(html)}
    });
  };

  const fetchUpstream = async(url: string, method: string, headers: HeadersInit, hasCopy: boolean, revalidate: boolean) => {
    const timeout = AbortSignal.timeout(hasCopy ? CACHED_NETWORK_TIMEOUT_MS : UNCACHED_NETWORK_TIMEOUT_MS);
    const init: RequestInit = {method, headers, redirect: 'error', signal: timeout};
    // Deploys must be seen straight away, through the 10 minute Pages max-age.
    if(revalidate) init.cache = 'no-cache';
    return fetch(url, init);
  };

  const pruneOldEntries = async(): Promise<void> => {
    const cutoff = Date.now() - CACHE_MAX_AGE_MS;
    const names = await readdir(cacheDir).catch((): string[] => []);
    await Promise.all(names.map(async(name) => {
      const path = join(cacheDir, name);
      const info = await stat(path).catch((): undefined => undefined);
      if(info && info.mtimeMs < cutoff) await rm(path, {force: true}).catch(() => {});
    }));
  };

  let pruned = false;

  const handle = async(request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method;
    if(method !== 'GET' && method !== 'HEAD') return new Response('method not allowed', {status: 405});

    if(url.pathname === SPLASH_PATH) return htmlResponse(SPLASH_HTML);

    if(url.pathname === READY_PATH) {
      try {
        const response = await fetchUpstream(origin + ENTRY_PATH, 'GET', {}, false, true);
        if(!response.ok) return new Response(null, {status: 503});
        await writeCache(ENTRY_PATH, {
          body: Buffer.from(await response.arrayBuffer()),
          contentType: response.headers.get('content-type') || 'text/html; charset=utf-8'
        });
        return new Response(null, {status: 204});
      } catch{
        return new Response(null, {status: 503});
      }
    }

    const pathname = url.pathname === '/' ? ENTRY_PATH : url.pathname;
    const target = new URL(pathname + url.search, origin);
    // '//host/x' would otherwise resolve to a different host.
    if(target.origin !== origin) return new Response('forbidden', {status: 403});

    const isDocument = DOCUMENT.test(pathname);
    const range = request.headers.get('range');
    if(method === 'HEAD' || range) {
      const response = await fetchUpstream(target.href, method, range ? {Range: range} : {}, false, false);
      const headers: Record<string, string> = securityHeaders();
      for(const name of ['content-type', 'content-range', 'accept-ranges']) {
        const value = response.headers.get(name);
        if(value) headers[name] = value;
      }
      return new Response(method === 'HEAD' ? null : await response.arrayBuffer(), {status: response.status, headers});
    }

    const isImmutable = HASHED_ASSET.test(pathname);
    const cached = await readCache(pathname);
    if(cached && isImmutable) return respond(cached, false);

    try {
      const response = await fetchUpstream(target.href, 'GET', {}, !!cached, !isImmutable);
      if(response.status === 200) {
        const entry: CacheEntry = {
          body: Buffer.from(await response.arrayBuffer()),
          contentType: response.headers.get('content-type') || 'application/octet-stream'
        };
        await writeCache(pathname, entry);
        if(isDocument && !pruned) {
          pruned = true;
          void pruneOldEntries();
        }
        return respond(entry, isDocument);
      }
      if(response.status >= 500 && cached) return respond(cached, isDocument);
      if(response.status >= 500 && isDocument) return htmlResponse(SPLASH_HTML);
      return new Response(await response.arrayBuffer(), {status: response.status, headers: securityHeaders()});
    } catch{
      if(cached) return respond(cached, isDocument);
      if(isDocument) return htmlResponse(SPLASH_HTML);
      return new Response('frontend unavailable', {status: 502, headers: securityHeaders()});
    }
  };

  return {
    handle,
    /** False on first launch, which starts on the splash instead of a blank window. */
    hasEntry: () => existsSync(fileFor(ENTRY_PATH).body) && existsSync(fileFor(ENTRY_PATH).meta)
  };
}
