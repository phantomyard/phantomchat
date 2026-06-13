/**
 * Unit tests for blossom-upload: verify signer builds a valid NIP-24242
 * event, the fallback chain tries servers in order, and failures surface.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {uploadToBlossom, BLOSSOM_SERVERS} from '@lib/nostra/blossom-upload';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('blossom-upload', () => {
  let privkeyHex: string;
  let pubkeyHex: string;

  beforeEach(() => {
    fetchMock.mockReset();
    const sk = generateSecretKey();
    privkeyHex = bytesToHex(sk);
    pubkeyHex = getPublicKey(sk);
  });

  it('uploads to first server on success', async() => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], {type: 'image/png'});

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      url: 'https://blossom.primal.net/abc.png',
      sha256: 'abc',
      size: 4,
      type: 'image/png'
    }), {status: 200}));

    const result = await uploadToBlossom(blob, privkeyHex);

    expect(result.url).toBe('https://blossom.primal.net/abc.png');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(BLOSSOM_SERVERS[0] + '/upload');
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toMatch(/^Nostr [A-Za-z0-9+/=]+$/);
  });

  it('falls back to next server on 5xx', async() => {
    const blob = new Blob([new Uint8Array([1])], {type: 'image/png'});

    fetchMock
    .mockResolvedValueOnce(new Response('boom', {status: 500}))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      url: 'https://cdn.satellite.earth/def.png',
      sha256: 'def',
      size: 1,
      type: 'image/png'
    }), {status: 200}));

    const result = await uploadToBlossom(blob, privkeyHex);

    expect(result.url).toBe('https://cdn.satellite.earth/def.png');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(BLOSSOM_SERVERS[0] + '/upload');
    expect(fetchMock.mock.calls[1][0]).toBe(BLOSSOM_SERVERS[1] + '/upload');
  });

  it('throws if every server fails', async() => {
    const blob = new Blob([new Uint8Array([1])], {type: 'image/png'});
    fetchMock.mockResolvedValue(new Response('down', {status: 503}));

    await expect(uploadToBlossom(blob, privkeyHex)).rejects.toThrow(/all blossom servers failed/i);
    expect(fetchMock).toHaveBeenCalledTimes(BLOSSOM_SERVERS.length);
  });

  it('signs an auth event with the given privkey', async() => {
    const blob = new Blob([new Uint8Array([9, 9])], {type: 'image/png'});
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      url: 'x', sha256: 'y', size: 2, type: 'image/png'
    }), {status: 200}));

    await uploadToBlossom(blob, privkeyHex);

    const authHeader = fetchMock.mock.calls[0][1].headers.Authorization as string;
    const b64 = authHeader.replace(/^Nostr /, '');
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
