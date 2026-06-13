/**
 * Regression: manifestText must flow from probe → popup → SW unchanged.
 *
 * The consent popup bug shipped in earlier versions silently dropped
 * manifestText in src/index.ts and mount.tsx. The SW then fell back to
 * JSON.stringify(manifest) on signed-update-sw.ts which produces bytes with
 * different key order / whitespace than the original server bytes, so
 * signature verification failed and users saw "Error: invalid-signature"
 * on Accept.
 *
 * These tests lock the contract:
 *   1. handleUpdateApproved uses the provided manifestText as-is (no
 *      re-serialization) when verifying the detached signature.
 *   2. Without manifestText, the SW fallback can drift and fail — proves
 *      the bug preconditions.
 *   3. startUpdateSigned forwards manifestText into the SW postMessage.
 */
import {describe, it, expect, beforeAll, beforeEach, vi} from 'vitest';
import 'fake-indexeddb/auto';
import * as ed from '@noble/ed25519';
import {sha512} from '@noble/hashes/sha2.js';
import {bytesToBase64} from '@lib/update/signing/verify';
import {handleUpdateApproved} from '@lib/serviceWorker/signed-update-sw';
import {setActiveVersion} from '@lib/serviceWorker/shell-cache';
import {startUpdateSigned} from '@lib/update/update-flow';

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

describe('manifestText propagation — SW verification', () => {
  it('verifies signature against manifestText bytes, not JSON.stringify(manifest)', async() => {
    const priv = ed.utils.randomSecretKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const indexHtml = new TextEncoder().encode('<html></html>');
    // Hand-crafted JSON with a whitespace + key-order variant that will
    // NOT round-trip through JSON.stringify — mirrors real server output,
    // which is pretty-printed / stable-ordered by the release pipeline.
    const indexHash = await sha256b64(indexHtml);
    const manifestText = [
      '{',
      '  "version": "0.13.0",',
      '  "schemaVersion": 2,',
      '  "gitSha": "x",',
      '  "published": "2026-01-01",',
      '  "swUrl": "./sw.js",',
      '  "signingKeyFingerprint": "ed25519:x",',
      '  "securityRelease": false,',
      '  "securityRollback": false,',
      `  "bundleHashes": {"./index.html": "${indexHash}"},`,
      '  "changelog": "",',
      '  "rotation": null',
      '}'
    ].join('\n');
    const manifest = JSON.parse(manifestText);
    // Sanity: re-serialized bytes differ from the raw bytes.
    expect(JSON.stringify(manifest)).not.toBe(manifestText);

    const manifestBytes = new TextEncoder().encode(manifestText);
    const sig = bytesToBase64(await ed.signAsync(manifestBytes, priv));
    global.fetch = vi.fn(async(url: string) => {
      if(url.endsWith('index.html')) return new Response(indexHtml);
      throw new Error('unexpected url ' + url);
    }) as any;
    await setActiveVersion('0.12.0', 'ed25519:x');

    const res = await handleUpdateApproved(manifest, sig, bytesToBase64(pub), undefined, manifestText);
    expect(res.outcome).toBe('applied');
  });

  it('falls back to JSON.stringify when manifestText is missing and fails on byte drift', async() => {
    // Documents the bug's precondition: signed bytes diverge from
    // JSON.stringify output → fallback rejects a legitimate update.
    const priv = ed.utils.randomSecretKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const manifestText = '{\n  "version": "0.13.0",\n  "schemaVersion": 2,\n  "gitSha": "x",\n  "published": "2026-01-01",\n  "swUrl": "./sw.js",\n  "signingKeyFingerprint": "ed25519:x",\n  "securityRelease": false,\n  "securityRollback": false,\n  "bundleHashes": {},\n  "changelog": "",\n  "rotation": null\n}';
    const manifest = JSON.parse(manifestText);
    const sig = bytesToBase64(await ed.signAsync(new TextEncoder().encode(manifestText), priv));
    await setActiveVersion('0.12.0', 'ed25519:x');

    const res = await handleUpdateApproved(manifest, sig, bytesToBase64(pub));
    expect(res.outcome).toBe('invalid-signature');
  });
});

describe('manifestText propagation — main-thread postMessage', () => {
  it('startUpdateSigned forwards manifestText to the SW UPDATE_APPROVED payload', async() => {
    const captured: any[] = [];
    const activeWorker = {
      postMessage: (msg: any, _transfer?: any[]) => { captured.push(msg); }
    };
    const registration = {active: activeWorker};
    (globalThis as any).navigator.serviceWorker = {
      getRegistration: async() => registration
    };

    const manifest = {version: '1.2.3', bundleHashes: {}} as any;
    const signature = 'sig-b64';
    const manifestText = '{"version":"1.2.3","bundleHashes":{}}\n'; // trailing newline simulates server

    // Don't await — startUpdateSigned resolves only when the SW replies on
    // MessageChannel.port1. We only care that postMessage was called with
    // the expected payload.
    void startUpdateSigned(manifest, signature, manifestText);
    await new Promise((r) => setTimeout(r, 0));

    expect(captured.length).toBe(1);
    expect(captured[0].type).toBe('UPDATE_APPROVED');
    expect(captured[0].manifestText).toBe(manifestText);
    expect(captured[0].signature).toBe(signature);
    expect(captured[0].manifest).toBe(manifest);
  });
});
