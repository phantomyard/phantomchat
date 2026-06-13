import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {fetchAndDecryptNostraFile, clearNostraFileCache} from '@lib/nostra/nostra-file-fetch';
import {encryptFile} from '@lib/nostra/file-crypto';

describe('nostra-file-fetch', () => {
  let origFetch: typeof fetch;
  beforeEach(() => { origFetch = globalThis.fetch; clearNostraFileCache(); });
  afterEach(() => { globalThis.fetch = origFetch; });

  it('fetches, decrypts, and caches', async() => {
    const plaintext = new TextEncoder().encode('secret bytes');
    const {ciphertext, keyHex, ivHex} = await encryptFile(new Blob([plaintext]));
    const ctBytes = new Uint8Array(await ciphertext.arrayBuffer());

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async() => ctBytes.buffer.slice(ctBytes.byteOffset, ctBytes.byteOffset + ctBytes.byteLength)
    });
    globalThis.fetch = fetchMock as any;

    const blob1 = await fetchAndDecryptNostraFile('https://x/a', keyHex, ivHex);
    expect(new TextDecoder().decode(new Uint8Array(await blob1.arrayBuffer()))).toBe('secret bytes');

    const blob2 = await fetchAndDecryptNostraFile('https://x/a', keyHex, ivHex);
    expect(blob2).toBe(blob1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects on 404', async() => {
    globalThis.fetch = vi.fn().mockResolvedValue({ok: false, status: 404}) as any;
    await expect(
      fetchAndDecryptNostraFile('https://x/b', '00'.repeat(32), '00'.repeat(12))
    ).rejects.toThrow(/404/);
  });

  it('rejects on bad key', async() => {
    const {ciphertext, ivHex} = await encryptFile(new Blob([new Uint8Array([1, 2, 3])]));
    const ctBytes = new Uint8Array(await ciphertext.arrayBuffer());
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async() => ctBytes.buffer.slice(0)
    }) as any;

    await expect(
      fetchAndDecryptNostraFile('https://x/c', '11'.repeat(32), ivHex)
    ).rejects.toThrow();
  });
});
