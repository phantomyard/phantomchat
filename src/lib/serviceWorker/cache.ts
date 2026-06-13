/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import pause from '@helpers/schedulers/pause';

const ctx = self as any as ServiceWorkerGlobalScope;
export const CACHE_ASSETS_NAME = 'cachedAssets';

function isCorrectResponse(response: Response) {
  return response.ok && response.status === 200;
}

function timeoutRace<T extends Promise<any>>(promise: T) {
  return Promise.race([
    promise,
    pause(10000).then(() => Promise.reject())
  ]);
}

export async function requestCache(event: FetchEvent) {
  try {
    // const cache = await ctx.caches.open(CACHE_ASSETS_NAME);
    const cache = await timeoutRace(ctx.caches.open(CACHE_ASSETS_NAME));
    const file = await timeoutRace(cache.match(event.request, {ignoreVary: true}));

    if(file && isCorrectResponse(file)) {
      return file;
    }

    const headers: HeadersInit = {'Vary': '*'};
    let response = await fetch(event.request, {headers});
    if(isCorrectResponse(response)) {
      cache.put(event.request, response.clone());
    } else if(response.status === 304) { // possible fix for 304 in Safari
      const url = event.request.url.replace(/\?.+$/, '') + '?' + (Math.random() * 100000 | 0);
      response = await fetch(url, {headers});
      if(isCorrectResponse(response)) {
        cache.put(event.request, response.clone());
      }
    }

    return response;
  } catch(err) {
    return fetch(event.request);
  }
}

import {getActiveVersion} from './shell-cache';

async function currentShellCacheName(): Promise<string> {
  const active = await getActiveVersion();
  if(!active) throw new Error('no active version');
  return `shell-v${active.version}`;
}

// A Response obtained via a fetch that followed an HTTP redirect carries
// `redirected: true`. Returning such a Response from a SW fetch handler to a
// navigation request (whose redirect mode is 'manual') makes the browser abort
// the navigation with ERR_FAILED. Cloudflare Pages 301's /index.html → /, so
// the precache install captures the tainted Response unless we reconstruct it.
// See: https://w3c.github.io/ServiceWorker/#ref-for-dfn-redirected-navigation
export async function unwrapRedirected(res: Response): Promise<Response> {
  if(!res.redirected) return res;
  const body = await res.arrayBuffer();
  return new Response(body, {status: res.status, statusText: res.statusText, headers: res.headers});
}

async function notifyCacheMiss(url: string): Promise<void> {
  try {
    const swCtx = self as any as ServiceWorkerGlobalScope;
    const clients = await swCtx.clients.matchAll({type: 'window', includeUncontrolled: true});
    for(const client of clients) {
      try {
        client.postMessage({type: 'SW_CACHE_MISS', url});
      } catch{}
    }
  } catch{}
}

// Lazy-built set of pathnames that were precached at install. A miss for a path
// NOT in this set means the browser requested something we never owned (e.g. the
// auto `/favicon.ico` implicitly requested when opening a non-HTML tab at the
// same origin). Those are not corruption — they must NOT trigger the reinstall
// overlay. A miss for a path IN this set means the shell entry was evicted or
// tampered with — genuine corruption, keep the overlay broadcast.
let _precachedPathnamesPromise: Promise<Set<string>> | null = null;
async function getPrecachedPathnames(cache: Cache): Promise<Set<string>> {
  if(!_precachedPathnamesPromise) {
    _precachedPathnamesPromise = (async() => {
      try {
        const reqs = await cache.keys();
        const set = new Set<string>();
        for(const req of reqs) {
          try {
            set.add(new URL(req.url).pathname);
          } catch{}
        }
        return set;
      } catch{
        return new Set<string>();
      }
    })();
  }
  return _precachedPathnamesPromise;
}

export async function requestCacheStrict(event: FetchEvent): Promise<Response> {
  const cache = await caches.open(await currentShellCacheName());
  // ignoreSearch: vite/release assets often carry a cache-buster querystring
  // (e.g. site.webmanifest?v=xyz) that doesn't appear in the cached URL.
  let hit = await cache.match(event.request, {ignoreSearch: true});
  if(!hit) {
    // Navigation to root or explicit path → fall back to index.html
    const url = new URL(event.request.url);
    if(url.pathname === '/' || event.request.mode === 'navigate') {
      const indexUrl = new URL('./index.html', url).href;
      hit = await cache.match(indexUrl);
    }
  }
  if(hit) return unwrapRedirected(hit);

  const url = new URL(event.request.url);
  const isNavigation = event.request.mode === 'navigate';

  if(!isNavigation) {
    const precached = await getPrecachedPathnames(cache);
    if(!precached.has(url.pathname)) {
      // Browser auto-request for a path that was never part of our shell
      // (e.g. `/favicon.ico` requested by any raw-JSON tab opened at our
      // origin). Try network silently, fall back to 404 — no overlay.
      try {
        return await fetch(event.request);
      } catch{
        return new Response('', {status: 404});
      }
    }
  }

  // Cache miss on a path we DID precache (or a navigation with no index.html
  // fallback) → genuine corruption. Notify controlled clients so the main-
  // thread listener (initCacheMissOverlay) can render the reinstall UI. For
  // navigation requests we still return an inline-HTML fallback: the miss may
  // be on the root document itself, in which case the main thread has no JS
  // running yet to react to the postMessage.
  notifyCacheMiss(event.request.url);
  if(isNavigation) {
    const body = '<!DOCTYPE html><meta charset=utf-8><title>Nostra.chat — cache corrupted</title><style>body{font-family:system-ui;padding:2rem;max-width:40rem;margin:auto}button{padding:0.5rem 1rem;font-size:1rem;cursor:pointer}</style><h1>Nostra.chat — cache corrupted</h1><p>An app-shell asset is missing from the local cache. Reinstall the app to continue. Your identity seed is safe.</p><p><strong>Missing:</strong> <code>' + event.request.url + '</code></p><button onclick="caches.keys().then(k=>Promise.all(k.map(c=>caches.delete(c)))).then(()=>navigator.serviceWorker.getRegistration()).then(r=>r&&r.unregister()).then(()=>location.reload())">Reinstall</button>';
    return new Response(body, {status: 503, headers: {'content-type': 'text/html; charset=utf-8'}});
  }
  return new Response(`cache-miss: ${event.request.url}`, {status: 503, headers: {'content-type': 'text/plain; charset=utf-8'}});
}
