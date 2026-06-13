/*
 * Coverage for the CACHE-ONLY fetch handler's handling of redirected Response
 * objects. Cloudflare Pages 301's /index.html → / during precache install,
 * which leaves `response.redirected === true` in the stored Response. Serving
 * that Response to a navigation request (redirect mode: 'manual') makes the
 * browser abort with ERR_FAILED ("Impossibile raggiungere il sito" in Chrome).
 * Regression guard for the production incident on nostra.chat.
 */
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

vi.mock('@lib/serviceWorker/shell-cache', () => ({
  getActiveVersion: vi.fn(async() => ({
    version: '1.0.0',
    keyFingerprint: 'ed25519:test',
    at: 0
  }))
}));

import {requestCacheStrict, unwrapRedirected} from '@lib/serviceWorker/cache';

function makeRedirectedResponse(body: string, headers: Record<string, string> = {}): Response {
  const res = new Response(body, {status: 200, statusText: 'OK', headers});
  Object.defineProperty(res, 'redirected', {value: true, configurable: true});
  return res;
}

function makeFetchEvent(url: string, mode: RequestMode = 'navigate'): FetchEvent {
  return {
    request: {url, mode} as unknown as Request
  } as unknown as FetchEvent;
}

describe('unwrapRedirected helper', () => {
  it('returns the same Response when redirected is false', async() => {
    const res = new Response('ok', {status: 200});
    const out = await unwrapRedirected(res);
    expect(out).toBe(res);
  });

  it('returns a fresh non-redirected Response preserving body and status when redirected is true', async() => {
    const redirected = makeRedirectedResponse('<!doctype html><p>hi</p>', {'content-type': 'text/html'});
    const out = await unwrapRedirected(redirected);
    expect(out).not.toBe(redirected);
    expect(out.redirected).toBe(false);
    expect(out.status).toBe(200);
    expect(out.headers.get('content-type')).toBe('text/html');
    expect(await out.text()).toBe('<!doctype html><p>hi</p>');
  });
});

describe('requestCacheStrict — redirected Response sanitization', () => {
  let mockCache: {match: ReturnType<typeof vi.fn>; keys: ReturnType<typeof vi.fn>};

  beforeEach(() => {
    mockCache = {
      match: vi.fn(),
      keys: vi.fn(async(): Promise<readonly Request[]> => [])
    };
    (globalThis as unknown as {caches: CacheStorage}).caches = {
      open: vi.fn(async() => mockCache)
    } as unknown as CacheStorage;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as unknown as {caches?: CacheStorage}).caches;
  });

  it('strips the redirected flag when direct cache hit is a redirected response', async() => {
    const redirected = makeRedirectedResponse('direct-hit-body', {'content-type': 'text/html'});
    mockCache.match.mockResolvedValueOnce(redirected);

    const result = await requestCacheStrict(makeFetchEvent('https://nostra.chat/assets/foo.js', 'no-cors'));

    expect(result.redirected).toBe(false);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('direct-hit-body');
  });

  it('strips the redirected flag when index.html fallback hit is a redirected response (production scenario)', async() => {
    const redirected = makeRedirectedResponse('<!doctype html>root', {'content-type': 'text/html'});
    mockCache.match
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(redirected);

    const result = await requestCacheStrict(makeFetchEvent('https://nostra.chat/', 'navigate'));

    expect(result.redirected).toBe(false);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe('<!doctype html>root');
  });

  it('returns the cached Response unchanged when not redirected', async() => {
    const normal = new Response('plain', {status: 200});
    mockCache.match.mockResolvedValueOnce(normal);

    const result = await requestCacheStrict(makeFetchEvent('https://nostra.chat/x.js', 'no-cors'));

    expect(result).toBe(normal);
    expect(result.redirected).toBe(false);
  });
});
