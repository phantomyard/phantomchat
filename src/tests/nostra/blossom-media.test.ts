/**
 * Tests for Nostra.chat media encryption (AES-256-GCM) and Blossom client
 *
 * Covers:
 * - encryptMedia / decryptMedia roundtrip
 * - Key/IV size validation
 * - Wrong key rejection
 * - sha256Hex correctness
 * - bytesToHex / hexToBytes roundtrip
 */

import '../setup';
import {
  encryptMedia,
  decryptMedia,
  sha256Hex,
  bytesToHex,
  hexToBytes
} from '@lib/nostra/media-crypto';
import {
  BlossomClient,
  DEFAULT_BLOSSOM_SERVERS,
  MAX_PHOTO_SIZE,
  MAX_VIDEO_SIZE,
  uploadEncryptedMedia,
  downloadDecryptedMedia
} from '@lib/nostra/blossom-client';

describe('media-crypto', () => {
  const sampleData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).buffer;

  describe('encryptMedia', () => {
    it('returns encrypted buffer, 32-byte key, 12-byte IV', async() => {
      const result = await encryptMedia(sampleData);

      expect(result.encrypted.byteLength).toBeGreaterThan(0);
      expect(result.key.length).toBe(32);
      expect(result.iv.length).toBe(12);
    });

    it('produces output different from input', async() => {
      const result = await encryptMedia(sampleData);
      const encryptedView = new Uint8Array(result.encrypted);
      const inputView = new Uint8Array(sampleData);

      // Encrypted data should differ from plaintext
      let allSame = encryptedView.length === inputView.length;
      if(allSame) {
        for(let i = 0; i < inputView.length; i++) {
          if(encryptedView[i] !== inputView[i]) {
            allSame = false;
            break;
          }
        }
      }
      expect(allSame).toBe(false);
    });

    it('generates different keys and IVs on each call', async() => {
      const result1 = await encryptMedia(sampleData);
      const result2 = await encryptMedia(sampleData);

      const key1Hex = bytesToHex(result1.key);
      const key2Hex = bytesToHex(result2.key);
      const iv1Hex = bytesToHex(result1.iv);
      const iv2Hex = bytesToHex(result2.iv);

      expect(key1Hex).not.toBe(key2Hex);
      expect(iv1Hex).not.toBe(iv2Hex);
    });
  });

  describe('decryptMedia', () => {
    it('roundtrips: decryptMedia(encryptMedia(data)) === original', async() => {
      const result = await encryptMedia(sampleData);
      const decrypted = await decryptMedia(result.encrypted, result.key, result.iv);

      const original = new Uint8Array(sampleData);
      const restored = new Uint8Array(decrypted);

      expect(restored.length).toBe(original.length);
      for(let i = 0; i < original.length; i++) {
        expect(restored[i]).toBe(original[i]);
      }
    });

    it('throws with wrong key', async() => {
      const result = await encryptMedia(sampleData);
      const wrongKey = new Uint8Array(32);
      crypto.getRandomValues(wrongKey);

      await expect(decryptMedia(result.encrypted, wrongKey, result.iv))
        .rejects.toThrow();
    });
  });

  describe('sha256Hex', () => {
    it('returns 64-character hex string', async() => {
      const hash = await sha256Hex(sampleData);
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces consistent hash for same data', async() => {
      const hash1 = await sha256Hex(sampleData);
      const hash2 = await sha256Hex(sampleData);
      expect(hash1).toBe(hash2);
    });
  });

  describe('bytesToHex / hexToBytes', () => {
    it('roundtrips bytes to hex and back', () => {
      const bytes = new Uint8Array([0, 1, 127, 128, 255]);
      const hex = bytesToHex(bytes);
      const back = hexToBytes(hex);

      expect(hex).toBe('00017f80ff');
      expect(back.length).toBe(bytes.length);
      for(let i = 0; i < bytes.length; i++) {
        expect(back[i]).toBe(bytes[i]);
      }
    });

    it('handles empty input', () => {
      expect(bytesToHex(new Uint8Array(0))).toBe('');
      expect(hexToBytes('')).toEqual(new Uint8Array(0));
    });
  });
});

// ─── Blossom Client Tests ────────────────────────────────────────

describe('BlossomClient', () => {
  const sampleData = new Uint8Array([10, 20, 30, 40, 50]).buffer;

  describe('DEFAULT_BLOSSOM_SERVERS', () => {
    it('has 3 servers configured', () => {
      expect(DEFAULT_BLOSSOM_SERVERS).toHaveLength(3);
    });
  });

  describe('upload with fallback', () => {
    it('returns descriptor from first successful server', async() => {
      const mockDescriptor = {
        url: 'https://blossom.primal.net/abc123',
        sha256: 'abc123',
        size: 5,
        type: 'application/octet-stream',
        uploaded: Date.now()
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockDescriptor)
      });

      const client = new BlossomClient({fetchFn: mockFetch as any});
      const result = await client.upload(sampleData, 'image/jpeg');

      expect(result).toEqual(mockDescriptor);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('falls through to next server on failure', async() => {
      const mockDescriptor = {
        url: 'https://cdn.satellite.earth/abc123',
        sha256: 'abc123',
        size: 5,
        type: 'application/octet-stream',
        uploaded: Date.now()
      };

      const mockFetch = vi.fn()
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockDescriptor)
        });

      const client = new BlossomClient({fetchFn: mockFetch as any});
      const result = await client.upload(sampleData, 'image/jpeg');

      expect(result).toEqual(mockDescriptor);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws when all servers fail', async() => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('fail'));

      const client = new BlossomClient({fetchFn: mockFetch as any});

      await expect(client.upload(sampleData, 'image/jpeg'))
        .rejects.toThrow('All Blossom servers failed upload');
    });
  });

  describe('download with fallback', () => {
    it('returns array buffer from first successful server', async() => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(sampleData)
      });

      const client = new BlossomClient({fetchFn: mockFetch as any});
      const result = await client.download('abc123');

      expect(new Uint8Array(result)).toEqual(new Uint8Array(sampleData));
    });

    it('falls through on HTTP error', async() => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({ok: false, status: 404})
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: () => Promise.resolve(sampleData)
        });

      const client = new BlossomClient({fetchFn: mockFetch as any});
      const result = await client.download('abc123');

      expect(new Uint8Array(result)).toEqual(new Uint8Array(sampleData));
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws when all servers fail', async() => {
      const mockFetch = vi.fn().mockResolvedValue({ok: false, status: 500});
      const client = new BlossomClient({fetchFn: mockFetch as any});

      await expect(client.download('abc123'))
        .rejects.toThrow('All Blossom servers failed download');
    });
  });

  describe('validateSize', () => {
    it('passes for photo under 10MB', () => {
      const client = new BlossomClient();
      expect(() => client.validateSize(5 * 1024 * 1024, 'photo')).not.toThrow();
    });

    it('throws for photo over 10MB', () => {
      const client = new BlossomClient();
      expect(() => client.validateSize(MAX_PHOTO_SIZE + 1, 'photo'))
        .toThrow('10MB');
    });

    it('passes for video under 50MB', () => {
      const client = new BlossomClient();
      expect(() => client.validateSize(40 * 1024 * 1024, 'video')).not.toThrow();
    });

    it('throws for video over 50MB', () => {
      const client = new BlossomClient();
      expect(() => client.validateSize(MAX_VIDEO_SIZE + 1, 'video'))
        .toThrow('50MB');
    });
  });

  describe('setFetchFn', () => {
    it('updates fetch function at runtime', async() => {
      const mockFetch1 = vi.fn().mockRejectedValue(new Error('old'));
      const mockFetch2 = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(sampleData)
      });

      const client = new BlossomClient({fetchFn: mockFetch1 as any});
      client.setFetchFn(mockFetch2 as any);

      const result = await client.download('abc123');
      expect(mockFetch1).not.toHaveBeenCalled();
      expect(mockFetch2).toHaveBeenCalled();
      expect(new Uint8Array(result)).toEqual(new Uint8Array(sampleData));
    });
  });
});

describe('uploadEncryptedMedia / downloadDecryptedMedia', () => {
  it('roundtrips: upload then download returns original data', async() => {
    const original = new Uint8Array([99, 88, 77, 66, 55]).buffer;

    // Mock fetch that stores the uploaded blob and returns it on download
    let storedBlob: ArrayBuffer | null = null;
    let storedSha256 = '';

    const mockFetch = vi.fn().mockImplementation(async(url: string, opts?: any) => {
      if(opts && opts.method === 'PUT') {
        storedBlob = opts.body;
        storedSha256 = 'mock-sha256';
        return {
          ok: true,
          json: () => Promise.resolve({
            url: `https://blossom.test/${storedSha256}`,
            sha256: storedSha256,
            size: (opts.body as ArrayBuffer).byteLength,
            type: 'application/octet-stream',
            uploaded: Date.now()
          })
        };
      }
      // GET download
      return {
        ok: true,
        arrayBuffer: () => Promise.resolve(storedBlob!)
      };
    });

    const client = new BlossomClient({fetchFn: mockFetch as any});

    // Upload
    const uploaded = await uploadEncryptedMedia(original, 'image/jpeg', client);
    expect(uploaded.key.length).toBe(32);
    expect(uploaded.iv.length).toBe(12);
    expect(uploaded.originalSha256).toHaveLength(64);

    // Download and decrypt
    const decrypted = await downloadDecryptedMedia(
      uploaded.descriptor.sha256,
      bytesToHex(uploaded.key),
      bytesToHex(uploaded.iv),
      client
    );

    const restored = new Uint8Array(decrypted);
    const orig = new Uint8Array(original);
    expect(restored.length).toBe(orig.length);
    for(let i = 0; i < orig.length; i++) {
      expect(restored[i]).toBe(orig[i]);
    }
  });
});
