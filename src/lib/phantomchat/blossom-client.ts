/**
 * Blossom Blob Storage Client — Upload/Download via Tor Proxy
 *
 * Uploads encrypted media blobs to Blossom servers (BUD-02 protocol).
 * Downloads blobs by SHA-256 hash with server fallback chain.
 *
 * Transport-agnostic: accepts any fetch-compatible function.
 * In production, pass PrivacyTransport's Tor fetch wrapper for IP privacy.
 */

import {encryptMedia, sha256Hex, hexToBytes, decryptMedia} from './media-crypto';

// ─── Constants ───────────────────────────────────────────────────

export const DEFAULT_BLOSSOM_SERVERS = [
  'https://blossom.primal.net',
  'https://cdn.satellite.earth',
  'https://nostrmedia.com'
];

export const MAX_PHOTO_SIZE = 10 * 1024 * 1024;   // 10MB
export const MAX_VIDEO_SIZE = 50 * 1024 * 1024;    // 50MB

// ─── Types ───────────────────────────────────────────────────────

export interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
}

// ─── BlossomClient ───────────────────────────────────────────────

export class BlossomClient {
  private servers: string[];
  private fetchFn: typeof fetch;

  constructor(options: {servers?: string[]; fetchFn?: typeof fetch} = {}) {
    this.servers = options.servers || DEFAULT_BLOSSOM_SERVERS;
    this.fetchFn = options.fetchFn || (typeof window !== 'undefined' ? window.fetch.bind(window) : fetch);
  }

  /**
   * Update fetch function at runtime (e.g., when Tor mode changes).
   */
  setFetchFn(fn: typeof fetch): void {
    this.fetchFn = fn;
  }

  /**
   * Upload a blob to the first available Blossom server.
   *
   * Tries each server in order. On failure, falls through to next.
   * Throws if all servers fail.
   */
  async upload(data: ArrayBuffer, mimeType: string): Promise<BlobDescriptor> {
    const errors: string[] = [];

    for(const server of this.servers) {
      try {
        const response = await this.fetchFn(`${server}/upload`, {
          method: 'PUT',
          headers: {'Content-Type': 'application/octet-stream'},
          body: data
        });

        if(response.ok) {
          const descriptor: BlobDescriptor = await response.json();
          return descriptor;
        }

        errors.push(`${server}: HTTP ${response.status}`);
      } catch(err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${server}: ${msg}`);
      }
    }

    throw new Error(`All Blossom servers failed upload: ${errors.join('; ')}`);
  }

  /**
   * Download a blob by SHA-256 hash from the first available server.
   *
   * Tries each server in order. On failure, falls through to next.
   * Throws if all servers fail.
   */
  async download(sha256: string): Promise<ArrayBuffer> {
    const errors: string[] = [];

    for(const server of this.servers) {
      try {
        const response = await this.fetchFn(`${server}/${sha256}`);

        if(response.ok) {
          return response.arrayBuffer();
        }

        errors.push(`${server}: HTTP ${response.status}`);
      } catch(err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${server}: ${msg}`);
      }
    }

    throw new Error(`All Blossom servers failed download for ${sha256}: ${errors.join('; ')}`);
  }

  /**
   * Validate file size against media type limits.
   *
   * @throws Error if size exceeds limit
   */
  validateSize(size: number, type: 'photo' | 'video'): void {
    const limit = type === 'photo' ? MAX_PHOTO_SIZE : MAX_VIDEO_SIZE;
    const label = type === 'photo' ? '10MB' : '50MB';

    if(size > limit) {
      throw new Error(`File size ${size} bytes exceeds ${label} limit for ${type}`);
    }
  }
}

// ─── Convenience helpers ─────────────────────────────────────────

/**
 * Encrypt a media file and upload it to Blossom.
 *
 * Returns all metadata needed for NIP-17 kind 15 tags:
 * - BlobDescriptor (url, sha256 of encrypted blob, size)
 * - Raw AES key + IV for decryption-key/decryption-nonce tags
 * - SHA-256 of the original (unencrypted) file for ox tag
 */
export async function uploadEncryptedMedia(
  file: ArrayBuffer,
  mimeType: string,
  client: BlossomClient
): Promise<{descriptor: BlobDescriptor; key: Uint8Array; iv: Uint8Array; originalSha256: string}> {
  // Hash original before encryption (for ox tag)
  const originalSha256 = await sha256Hex(file);

  // Encrypt
  const encrypted = await encryptMedia(file);

  // Upload encrypted blob
  const descriptor = await client.upload(encrypted.encrypted, mimeType);

  return {
    descriptor,
    key: encrypted.key,
    iv: encrypted.iv,
    originalSha256
  };
}

/**
 * Download a blob from Blossom and decrypt it.
 *
 * @param sha256 - SHA-256 hash of the encrypted blob
 * @param keyHex - Hex-encoded AES key (from NIP-17 decryption-key tag)
 * @param ivHex - Hex-encoded IV (from NIP-17 decryption-nonce tag)
 */
export async function downloadDecryptedMedia(
  sha256: string,
  keyHex: string,
  ivHex: string,
  client: BlossomClient
): Promise<ArrayBuffer> {
  const encryptedBlob = await client.download(sha256);
  return decryptMedia(encryptedBlob, hexToBytes(keyHex), hexToBytes(ivHex));
}
