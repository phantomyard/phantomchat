/**
 * Media Encryption — AES-256-GCM for Blossom blob storage
 *
 * Encrypts media files client-side before uploading to Blossom servers.
 * Decryption key + IV are shared in the NIP-17 gift-wrapped message.
 *
 * Uses Web Crypto API only — no npm dependencies.
 */

export interface EncryptedMedia {
  encrypted: ArrayBuffer;
  key: Uint8Array;    // 32 bytes, raw AES-256 key
  iv: Uint8Array;     // 12 bytes, GCM nonce
}

/**
 * Encrypt a media file with AES-256-GCM.
 *
 * Generates a fresh random key and IV for each call.
 * Returns the ciphertext + raw key bytes + IV for inclusion in NIP-17 tags.
 */
export async function encryptMedia(file: ArrayBuffer): Promise<EncryptedMedia> {
  // Generate random AES-256 key
  const cryptoKey = await crypto.subtle.generateKey(
    {name: 'AES-GCM', length: 256},
    true, // extractable — we need raw bytes for NIP-17 tags
    ['encrypt']
  );

  // Generate random 12-byte IV (standard for GCM)
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);

  // Encrypt
  const encrypted = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv},
    cryptoKey,
    file
  );

  // Export raw key bytes (32 bytes for AES-256)
  const rawKey = await crypto.subtle.exportKey('raw', cryptoKey);

  return {
    encrypted,
    key: new Uint8Array(rawKey),
    iv
  };
}

/**
 * Decrypt a media file encrypted with AES-256-GCM.
 *
 * @param encrypted - The ciphertext (includes GCM auth tag)
 * @param keyBytes - 32-byte raw AES key
 * @param iv - 12-byte GCM nonce
 */
export async function decryptMedia(
  encrypted: ArrayBuffer,
  keyBytes: Uint8Array,
  iv: Uint8Array
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    {name: 'AES-GCM'},
    false,
    ['decrypt']
  );

  return crypto.subtle.decrypt(
    {name: 'AES-GCM', iv},
    cryptoKey,
    encrypted
  );
}

/**
 * Compute SHA-256 hash of data, returned as lowercase hex string.
 * Used for Blossom blob addressing (BUD-02).
 */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(hash));
}

/**
 * Convert bytes to lowercase hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for(let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Convert hex string to bytes.
 */
export function hexToBytes(hex: string): Uint8Array {
  if(hex.length === 0) return new Uint8Array(0);
  const bytes = new Uint8Array(hex.length / 2);
  for(let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
