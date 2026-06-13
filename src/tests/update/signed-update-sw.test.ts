import {describe, it, expect, beforeAll, beforeEach, vi} from 'vitest';
import 'fake-indexeddb/auto';
import * as ed from '@noble/ed25519';
import {sha512} from '@noble/hashes/sha2.js';
import {bytesToBase64} from '@lib/update/signing/verify';
import {handleUpdateApproved} from '@lib/serviceWorker/signed-update-sw';
import {setActiveVersion, getActiveVersion} from '@lib/serviceWorker/shell-cache';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
});

const store = new Map<string, Map<string, Response>>();
beforeEach(() => {
  store.clear();
  (globalThis as any).caches = {
    async open(name: string) {
      if(!store.has(name)) store.set(name, new Map());
      const m = store.get(name)!;
      return {
        async put(r: any, res: Response) { m.set(typeof r === 'string' ? r : r.url, res.clone()); },
        async match(r: any) { return m.get(typeof r === 'string' ? r : r.url); },
        async delete(r: any) { return m.delete(typeof r === 'string' ? r : r.url); },
        async keys() { return Array.from(m.keys()).map((u) => new Request(u.startsWith('http') ? u : 'https://localhost' + u)); }
      } as any;
    },
    async has(name: string) { return store.has(name); },
    async delete(name: string) { return store.delete(name); },
    async keys() { return Array.from(store.keys()); }
  };
});

async function sha256b64(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as any);
  let hex = '';
  for(const b of new Uint8Array(d)) hex += b.toString(16).padStart(2, '0');
  return 'sha256-' + hex;
}

describe('handleUpdateApproved', () => {
  it('downloads, verifies, and swaps atomically on all-match', async() => {
    const priv = ed.utils.randomSecretKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const indexHtml = new TextEncoder().encode('<html></html>');
    const swJs = new TextEncoder().encode('/* sw */');
    const manifest: any = {
      schemaVersion: 2, version: '0.13.0', gitSha: 'x', published: '2026-01-01',
      swUrl: './sw.js', signingKeyFingerprint: 'ed25519:x',
      securityRelease: false, securityRollback: false,
      bundleHashes: {
        './index.html': await sha256b64(indexHtml),
        './sw.js': await sha256b64(swJs)
      },
      changelog: '', alternateSources: {}, rotation: null
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const sig = bytesToBase64(await ed.signAsync(manifestBytes, priv));
    global.fetch = vi.fn(async(url: string) => {
      if(url.endsWith('index.html')) return new Response(indexHtml);
      if(url.endsWith('sw.js')) return new Response(swJs);
      throw new Error('unexpected url ' + url);
    }) as any;
    await setActiveVersion('0.12.0', 'ed25519:x');
    const res = await handleUpdateApproved(manifest, sig, bytesToBase64(pub));
    expect(res.outcome).toBe('applied');
    const active = await getActiveVersion();
    expect(active?.version).toBe('0.13.0');
  });

  it('aborts on chunk hash mismatch', async() => {
    const priv = ed.utils.randomSecretKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const indexHtml = new TextEncoder().encode('<html></html>');
    const manifest: any = {schemaVersion: 2, version: '0.13.0', gitSha: 'x', published: '2026-01-01', swUrl: './sw.js', signingKeyFingerprint: 'ed25519:x', securityRelease: false, securityRollback: false, bundleHashes: {'./index.html': 'sha256-DEADBEEF'}, changelog: '', alternateSources: {}, rotation: null};
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const sig = bytesToBase64(await ed.signAsync(manifestBytes, priv));
    global.fetch = vi.fn(async() => new Response(indexHtml)) as any;
    await setActiveVersion('0.12.0', 'ed25519:x');
    const res = await handleUpdateApproved(manifest, sig, bytesToBase64(pub));
    expect(res.outcome).toBe('chunk-mismatch');
    const active = await getActiveVersion();
    expect(active?.version).toBe('0.12.0');
  });

  it('preserves Content-Type from origin so cached ES modules pass strict-MIME on next load', async() => {
    // Regression for 0.23.0 white-screen: the SW used to cache via
    // `new Response(ab)` with no init, dropping all headers. Browsers then
    // reject ES module scripts served from that cache because the response
    // has no Content-Type ("Failed to load module script: Expected a
    // JavaScript-or-Wasm module script but the server responded with a MIME
    // type of """). The fix reconstructs the Response preserving res.headers.
    const priv = ed.utils.randomSecretKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const indexJs = new TextEncoder().encode('export const x = 1;');
    const swJs = new TextEncoder().encode('/* sw */');
    const manifest: any = {
      schemaVersion: 2, version: '0.13.0', gitSha: 'x', published: '2026-01-01',
      swUrl: './sw.js', signingKeyFingerprint: 'ed25519:x',
      securityRelease: false, securityRollback: false,
      bundleHashes: {
        './index-D4FOSvD8.js': await sha256b64(indexJs),
        './sw.js': await sha256b64(swJs)
      },
      changelog: '', alternateSources: {}, rotation: null
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const sig = bytesToBase64(await ed.signAsync(manifestBytes, priv));
    global.fetch = vi.fn(async(url: string) => {
      if(url.endsWith('index-D4FOSvD8.js')) {
        return new Response(indexJs, {headers: {'content-type': 'application/javascript'}});
      }
      if(url.endsWith('sw.js')) {
        return new Response(swJs, {headers: {'content-type': 'application/javascript'}});
      }
      throw new Error('unexpected url ' + url);
    }) as any;
    await setActiveVersion('0.12.0', 'ed25519:x');
    // Snoop on the pending cache: capture the Response objects the SW writes
    // BEFORE atomicSwap drains the cache. This is the exact write site where
    // the bug lived (`new Response(ab)` stripped Content-Type).
    const captured = new Map<string, Response>();
    const origCachesOpen = (globalThis as any).caches.open.bind((globalThis as any).caches);
    (globalThis as any).caches.open = async(name: string) => {
      const c = await origCachesOpen(name);
      if(name.endsWith('-pending')) {
        const origPut = c.put.bind(c);
        c.put = async(r: any, res: Response) => {
          captured.set(typeof r === 'string' ? r : r.url, res.clone());
          return origPut(r, res);
        };
      }
      return c;
    };
    const res = await handleUpdateApproved(manifest, sig, bytesToBase64(pub));
    expect(res.outcome).toBe('applied');
    const cached = captured.get('./index-D4FOSvD8.js');
    expect(cached).toBeDefined();
    expect(cached!.headers.get('content-type')).toBe('application/javascript');
  });

  it('rejects if signature is bad (defense in depth)', async() => {
    const priv = ed.utils.randomSecretKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const wrongPriv = ed.utils.randomSecretKey();
    const manifest: any = {schemaVersion: 2, version: '0.13.0', gitSha: 'x', published: '2026-01-01', swUrl: './sw.js', signingKeyFingerprint: 'ed25519:x', securityRelease: false, securityRollback: false, bundleHashes: {}, changelog: '', alternateSources: {}, rotation: null};
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const sig = bytesToBase64(await ed.signAsync(manifestBytes, wrongPriv));
    await setActiveVersion('0.12.0', 'ed25519:x');
    const res = await handleUpdateApproved(manifest, sig, bytesToBase64(pub));
    expect(res.outcome).toBe('invalid-signature');
  });
});
