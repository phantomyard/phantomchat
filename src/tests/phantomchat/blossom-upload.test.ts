/**
 * Unit tests for blossom-upload: verify signer builds a valid NIP-24242
 * event, the fallback chain tries servers in order, and failures surface.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {uploadToBlossom, BLOSSOM_SERVERS} from '@lib/phantomchat/blossom-upload';
import {__resetBlossomServersCacheForTests} from '@lib/phantomchat/blossom-servers';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Route /blossom.json away from the upload mock so getBlossomServers works. */
function withServerList(impl: typeof fetchMock) {
  return (async(url: any, init?: any) => {
    if(typeof url === 'string' && url.includes('blossom.json')) {
      return new Response(JSON.stringify({servers: [...BLOSSOM_SERVERS]}), {status: 200});
    }
    return impl(url, init);
  }) as typeof fetchMock;
}

describe('blossom-upload', () => {
  let privkeyHex: string;
  let pubkeyHex: string;

  beforeEach(() => {
    fetchMock.mockReset();
    __resetBlossomServersCacheForTests();
    // Ensure the session cache re-resolves via our mocked /blossom.json, not an empty cascade.
    if(typeof (globalThis as any).window === 'undefined') {
      (globalThis as any).window = {};
    }
    delete (globalThis as any).window.__phantomchatTestBlossom;
    const sk = generateSecretKey();
    privkeyHex = bytesToHex(sk);
    pubkeyHex = getPublicKey(sk);
  });

  it('uploads to first server on success', async() => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], {type: 'image/png'});

    // First call is /blossom.json (getBlossomServers); subsequent is the upload.
    const uploadResponse = new Response(JSON.stringify({
      url: 'https://blossom.primal.net/abc.png',
      sha256: 'abc',
      size: 4,
      type: 'image/png'
    }), {status: 200});
    globalThis.fetch = withServerList(vi.fn(async() => uploadResponse)) as any;

    const result = await uploadToBlossom(blob, privkeyHex);

    expect(result.url).toBe('https://blossom.primal.net/abc.png');
  });

  it('falls back to next server on 5xx', async() => {
    const blob = new Blob([new Uint8Array([1])], {type: 'image/png'});

    let uploadCalls = 0;
    globalThis.fetch = withServerList(vi.fn(async(url: string) => {
      if(String(url).endsWith('/upload')) {
        uploadCalls++;
        if(uploadCalls === 1) return new Response('boom', {status: 500});
        return new Response(JSON.stringify({
          url: 'https://blossom.band/def.png',
          sha256: 'def',
          size: 1,
          type: 'image/png'
        }), {status: 200});
      }
      return new Response('nope', {status: 404});
    })) as any;

    const result = await uploadToBlossom(blob, privkeyHex);

    expect(result.url).toBe('https://blossom.band/def.png');
    expect(uploadCalls).toBe(2);
  });

  it('throws if every server fails', async() => {
    const blob = new Blob([new Uint8Array([1])], {type: 'image/png'});
    let uploadCalls = 0;
    globalThis.fetch = withServerList(vi.fn(async(url: string) => {
      if(String(url).endsWith('/upload')) {
        uploadCalls++;
        return new Response('down', {status: 503});
      }
      return new Response('nope', {status: 404});
    })) as any;

    await expect(uploadToBlossom(blob, privkeyHex)).rejects.toThrow(/all blossom servers failed/i);
    expect(uploadCalls).toBe(BLOSSOM_SERVERS.length);
  });

  it('signs an auth event with the given privkey', async() => {
    const blob = new Blob([new Uint8Array([9, 9])], {type: 'image/png'});
    let lastAuth = '';
    globalThis.fetch = withServerList(vi.fn(async(url: string, init?: any) => {
      if(String(url).endsWith('/upload')) {
        lastAuth = init?.headers?.Authorization ?? '';
        return new Response(JSON.stringify({
          url: 'x', sha256: 'y', size: 2, type: 'image/png'
        }), {status: 200});
      }
      return new Response('nope', {status: 404});
    })) as any;

    await uploadToBlossom(blob, privkeyHex);

    const b64 = lastAuth.replace(/^Nostr /, '');
    const event = JSON.parse(atob(b64));

    expect(event.kind).toBe(24242);
    expect(event.pubkey).toBe(pubkeyHex);
    expect(event.tags).toEqual(expect.arrayContaining([
      expect.arrayContaining(['t', 'upload']),
      expect.arrayContaining(['x'])
    ]));
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
  });
});
