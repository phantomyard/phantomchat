/*
 * Nostra.chat — File encryption helpers
 *
 * AES-GCM 256 encryption for media files uploaded to Blossom.
 * Key + IV are generated per file and travel inside the NIP-17 gift-wrap.
 */

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for(let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0');
  }
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for(let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if(typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

export interface EncryptedFile {
  ciphertext: Blob;
  keyHex: string;
  ivHex: string;
  sha256Hex: string;
}

export async function encryptFile(blob: Blob): Promise<EncryptedFile> {
  const plaintext = await blobToBytes(blob);
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, {name: 'AES-GCM'}, false, ['encrypt']
  );
  const ctBuffer = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv}, cryptoKey, plaintext
  );
  const ctBytes = new Uint8Array(ctBuffer);

  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', ctBytes));

  return {
    ciphertext: new Blob([ctBytes], {type: 'application/octet-stream'}),
    keyHex: bytesToHex(key),
    ivHex: bytesToHex(iv),
    sha256Hex: bytesToHex(digest)
  };
}

export async function decryptFile(
  ciphertext: Uint8Array,
  keyHex: string,
  ivHex: string
): Promise<Blob> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', hexToBytes(keyHex), {name: 'AES-GCM'}, false, ['decrypt']
  );
  const plaintextBuffer = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: hexToBytes(ivHex)}, cryptoKey, ciphertext
  );
  return new Blob([new Uint8Array(plaintextBuffer)]);
}
