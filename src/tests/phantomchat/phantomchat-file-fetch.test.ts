import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {fetchAndDecryptPhantomChatFile, clearPhantomChatFileCache} from '@lib/phantomchat/phantomchat-file-fetch';
import {encryptFile} from '@lib/phantomchat/file-crypto';
import {__resetBlossomServersCacheForTests} from '@lib/phantomchat/blossom-servers';

describe('phantomchat-file-fetch', () => {
  let origFetch: typeof fetch;
  beforeEach(() => {
    origFetch = globalThis.fetch;
    clearPhantomChatFileCache();
    __resetBlossomServersCacheForTests();
    // Pin known server list to empty via test override so expand only uses
    // the urls we trade explicitly (primary + mirrors). Empty string override
    // would refuse; pass a nonsense domain so hash expansion is deterministic.
    if(typeof (globalThis as any).window === 'undefined') {
      (globalThis as any).window = {};
    }
    (globalThis as any).window.__phantomchatTestBlossom = 'https://known.test';
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    __resetBlossomServersCacheForTests();
    if(typeof (globalThis as any).window !== 'undefined') {
      delete (globalThis as any).window.__phantomchatTestBlossom;
    }
  });

  it('fetches, decrypts, and caches', async() => {
    const plaintext = new TextEncoder().encode('secret bytes');
    const {ciphertext, keyHex, ivHex, sha256Hex} = await encryptFile(new Blob([plaintext]));
    const ctBytes = new Uint8Array(await ciphertext.arrayBuffer());

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async() => ctBytes.buffer.slice(ctBytes.byteOffset, ctBytes.byteOffset + ctBytes.byteLength)
    });
    globalThis.fetch = fetchMock as any;

    const blob1 = await fetchAndDecryptPhantomChatFile('https://x/a', keyHex, ivHex, {sha256: sha256Hex});
    expect(new TextDecoder().decode(new Uint8Array(await blob1.arrayBuffer()))).toBe('secret bytes');

    const blob2 = await fetchAndDecryptPhantomChatFile('https://x/a', keyHex, ivHex);
    expect(blob2).toBe(blob1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to a mirror when primary 404s', async() => {
    const plaintext = new TextEncoder().encode('mirror-ok');
    const {ciphertext, keyHex, ivHex, sha256Hex} = await encryptFile(new Blob([plaintext]));
    const ctBytes = new Uint8Array(await ciphertext.arrayBuffer());

    const fetchMock = vi.fn(async(url: string) => {
      if(String(url).includes('primary')) {
        return {ok: false, status: 404};
      }
      if(String(url).includes('mirror')) {
        return {
          ok: true,
          arrayBuffer: async() => ctBytes.buffer.slice(ctBytes.byteOffset, ctBytes.byteOffset + ctBytes.byteLength)
        };
      }
      return {ok: false, status: 404};
    });
    globalThis.fetch = fetchMock as any;

    const blob = await fetchAndDecryptPhantomChatFile(
      'https://primary.example/dead',
      keyHex,
      ivHex,
      {sha256: sha256Hex, mirrors: ['https://mirror.example/alive']}
    );
    expect(new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()))).toBe('mirror-ok');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('rejects when every candidate fails', async() => {
    globalThis.fetch = vi.fn().mockResolvedValue({ok: false, status: 404}) as any;
    await expect(
      fetchAndDecryptPhantomChatFile('https://x/b', '00'.repeat(32), '00'.repeat(12))
    ).rejects.toThrow(/blossom fetch failed/);
  });

  it('rejects on bad key after a successful fetch', async() => {
    const {ciphertext, ivHex, sha256Hex} = await encryptFile(new Blob([new Uint8Array([1, 2, 3])]));
    const ctBytes = new Uint8Array(await ciphertext.arrayBuffer());
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async() => ctBytes.buffer.slice(0)
    }) as any;

    await expect(
      fetchAndDecryptPhantomChatFile('https://x/c', '11'.repeat(32), ivHex, {sha256: sha256Hex})
    ).rejects.toThrow();
  });
});
