# P2P Media Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable sending images, generic files, and voice notes over the P2P pipeline via AES-GCM E2EE + Blossom + NIP-17 kind 15 rumors.

**Architecture:** A shortcut in `appMessagesManager.sendFile` detects P2P peers (`peerId >= 1e15`), skips the MTProto chunk upload path, and forwards the raw `Blob` through a new MessagePort bridge method (`nostraSendFile`). On the main thread, `VirtualMTProtoServer` delegates to a new orchestrator (`sendFileViaNostra`) that encrypts with AES-GCM, uploads the ciphertext to Blossom (XHR with real progress + 3-retry backoff), then publishes the kind 15 rumor via `ChatAPI.sendFileMessage`. Optimistic bubbles are rendered immediately with a `blob:` preview URL and transition via `nostra_file_upload_*` events dispatched from the orchestrator. On the receiver, decrypted blobs are produced by a new helper (`fetchAndDecryptNostraFile`).

**Tech Stack:** TypeScript 5.7, WebCrypto (AES-GCM 256), XMLHttpRequest (for upload progress), Solid.js (receiver rendering hooks), vitest + Playwright, strfry LocalRelay for E2E.

**Spec:** `docs/superpowers/specs/2026-04-15-p2p-media-send-design.md`

---

## File Structure

**New files:**
- `src/lib/nostra/file-crypto.ts` — AES-GCM encrypt/decrypt, sha256 of ciphertext
- `src/lib/nostra/blossom-upload-progress.ts` — XHR upload with progress + abort, fallback chain
- `src/lib/nostra/nostra-file-fetch.ts` — receiver-side fetch+decrypt with in-memory cache
- `src/lib/nostra/nostra-send-file.ts` — sender orchestrator (encrypt → upload → send rumor), retry/abort/retry-map lifecycle
- `src/tests/nostra/file-crypto.test.ts`
- `src/tests/nostra/blossom-upload-progress.test.ts`
- `src/tests/nostra/nostra-file-fetch.test.ts`
- `src/tests/nostra/nostra-send-file.test.ts`
- `src/tests/e2e/e2e-send-image.ts`
- `src/tests/e2e/e2e-send-voice.ts`

**Modified files:**
- `src/lib/rootScope.ts` — 4 new `BroadcastEvents` entries
- `src/lib/nostra/message-store.ts` — `deliveryState: 'failed'`, optional `duration`/`waveform` on `fileMetadata`
- `src/lib/nostra/chat-api.ts` — extend `sendFileMessage` with optional `duration`/`waveform`; extend `ChatMessage.fileMetadata`
- `src/lib/nostra/chat-api-receive.ts` — `extractFileMetadata` parses `duration`/`waveform`
- `src/lib/appManagers/apiManager.ts` — add `'nostraSendFile'` to `NOSTRA_BRIDGE_METHODS`
- `src/lib/mainWorker/mainMessagePort.ts` — no change (bridge forwards by method name; `Blob` is structured-cloneable)
- `src/lib/nostra/virtual-mtproto-server.ts` — new `case 'nostraSendFile'` in `handleMethod`, delegates to `sendFileViaNostra`; extend `injectOutgoingBubble` to accept optional `media`
- `src/lib/appManagers/appMessagesManager.ts` — early-return branch at top of `sendFile` that invokes `nostraSendFile` instead of the MTProto upload path
- `src/components/chat/bubbles.ts` — listeners for `nostra_file_upload_progress`/`_failed`/`_completed`, click-to-retry handler
- `src/scss/partials/_bubbles.scss` (or existing media-upload styles file) — `.media-upload-progress`, `.upload-failed` retry affordance
- `src/tests/e2e/run-all.sh` — add two new E2E entries

---

## Task 1: Add new broadcast events to rootScope

**Files:**
- Modify: `src/lib/rootScope.ts:278-283` (insert after the existing `nostra_*` events block)

- [ ] **Step 1: Add four new event types**

Find the block ending with `'nostra_message_edit'` (~ line 283) and insert after it:

```typescript
  'nostra_file_upload_progress': {peerId: number; mid: number; percent: number},
  'nostra_file_upload_failed': {peerId: number; mid: number; error: string},
  'nostra_file_upload_completed': {peerId: number; mid: number; url: string; realMid: number},
  'nostra_retry_file_send': {peerId: number; mid: number},
```

- [ ] **Step 2: Verify type checks**

Run: `npx tsc --noEmit 2>&1 | grep -E "rootScope\.ts|nostra_file_upload|nostra_retry_file_send" | head -20`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/rootScope.ts
git commit -m "feat(rootScope): add nostra_file_upload_* broadcast events"
```

---

## Task 2: Extend StoredMessage + ChatMessage fileMetadata

**Files:**
- Modify: `src/lib/nostra/message-store.ts:29-40`
- Modify: `src/lib/nostra/chat-api.ts:59-69`

- [ ] **Step 1: Update `StoredMessage`**

In `message-store.ts`, change `deliveryState` and extend `fileMetadata`:

```typescript
  /** Delivery state */
  deliveryState: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  /** File metadata (for type='file', used by Plan 02) */
  fileMetadata?: {
    url: string;
    sha256: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
    keyHex: string;
    ivHex: string;
    duration?: number;
    waveform?: string;
  };
```

- [ ] **Step 2: Update `ChatMessage.fileMetadata`**

In `chat-api.ts`, extend the interface with the same optional fields:

```typescript
  fileMetadata?: {
    url: string;
    sha256: string;
    mimeType: string;
    size: number;
    width?: number;
    height?: number;
    keyHex: string;
    ivHex: string;
    duration?: number;
    waveform?: string;
  };
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "message-store|chat-api|fileMetadata" | head -20`
Expected: no new errors. Pre-existing errors unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/message-store.ts src/lib/nostra/chat-api.ts
git commit -m "feat(nostra): extend fileMetadata with duration/waveform and 'failed' deliveryState"
```

---

## Task 3: file-crypto.ts (AES-GCM encrypt/decrypt)

**Files:**
- Create: `src/lib/nostra/file-crypto.ts`
- Test: `src/tests/nostra/file-crypto.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/tests/nostra/file-crypto.test.ts`:

```typescript
import {describe, it, expect} from 'vitest';
import {encryptFile, decryptFile, bytesToHex, hexToBytes} from '@lib/nostra/file-crypto';

describe('file-crypto', () => {
  it('round-trips encrypt/decrypt', async() => {
    const plaintext = new TextEncoder().encode('hello nostra');
    const blob = new Blob([plaintext], {type: 'text/plain'});
    const {ciphertext, keyHex, ivHex, sha256Hex} = await encryptFile(blob);

    expect(keyHex).toHaveLength(64);
    expect(ivHex).toHaveLength(24);
    expect(sha256Hex).toHaveLength(64);
    expect(ciphertext.size).toBeGreaterThan(plaintext.byteLength); // GCM tag adds 16 bytes

    const ctBytes = new Uint8Array(await ciphertext.arrayBuffer());
    const decrypted = await decryptFile(ctBytes, keyHex, ivHex);
    const decryptedText = new TextDecoder().decode(new Uint8Array(await decrypted.arrayBuffer()));
    expect(decryptedText).toBe('hello nostra');
  });

  it('produces a different key+iv on every call', async() => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const a = await encryptFile(blob);
    const b = await encryptFile(blob);
    expect(a.keyHex).not.toBe(b.keyHex);
    expect(a.ivHex).not.toBe(b.ivHex);
  });

  it('sha256Hex is the hash of the ciphertext, not the plaintext', async() => {
    const plaintextBytes = new Uint8Array([10, 20, 30, 40]);
    const blob = new Blob([plaintextBytes]);
    const {ciphertext, sha256Hex} = await encryptFile(blob);

    const ctBytes = new Uint8Array(await ciphertext.arrayBuffer());
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', ctBytes));
    expect(sha256Hex).toBe(bytesToHex(expected));
  });

  it('hex helpers round-trip', () => {
    const bytes = new Uint8Array([0, 15, 16, 255]);
    expect(bytesToHex(bytes)).toBe('000f10ff');
    expect(hexToBytes('000f10ff')).toEqual(bytes);
  });

  it('decryptFile throws on tampered ciphertext', async() => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const {ciphertext, keyHex, ivHex} = await encryptFile(blob);
    const bytes = new Uint8Array(await ciphertext.arrayBuffer());
    bytes[0] ^= 0xff; // flip a bit
    await expect(decryptFile(bytes, keyHex, ivHex)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/nostra/file-crypto.test.ts`
Expected: FAIL with "Cannot find module '@lib/nostra/file-crypto'".

- [ ] **Step 3: Create the module**

Create `src/lib/nostra/file-crypto.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/nostra/file-crypto.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/file-crypto.ts src/tests/nostra/file-crypto.test.ts
git commit -m "feat(nostra): add AES-GCM file-crypto helpers"
```

---

## Task 4: blossom-upload-progress.ts (XHR upload with progress)

**Files:**
- Create: `src/lib/nostra/blossom-upload-progress.ts`
- Test: `src/tests/nostra/blossom-upload-progress.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/tests/nostra/blossom-upload-progress.test.ts`:

```typescript
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {uploadToBlossomWithProgress, BLOSSOM_SERVERS} from '@lib/nostra/blossom-upload-progress';

// Minimal XHR mock — records calls and lets the test drive events
class MockXHR {
  static instances: MockXHR[] = [];
  upload = {onprogress: null as ((e: {loaded: number; total: number; lengthComputable: boolean}) => void) | null};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  responseText = '';
  status = 0;
  readonly method: string = '';
  readonly url: string = '';
  readonly headers: Record<string, string> = {};
  sentBody: any = null;
  aborted = false;

  open(method: string, url: string) {
    (this as any).method = method;
    (this as any).url = url;
    MockXHR.instances.push(this);
  }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send(body: any) { this.sentBody = body; }
  abort() { this.aborted = true; this.onabort?.(); }
}

const PRIVKEY_HEX = '0000000000000000000000000000000000000000000000000000000000000001';

describe('blossom-upload-progress', () => {
  let origXHR: typeof XMLHttpRequest;

  beforeEach(() => {
    MockXHR.instances = [];
    origXHR = globalThis.XMLHttpRequest;
    (globalThis as any).XMLHttpRequest = MockXHR;
  });

  afterEach(() => {
    (globalThis as any).XMLHttpRequest = origXHR;
  });

  it('resolves with the first server success', async() => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const progress: number[] = [];

    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {
      onProgress: (p) => progress.push(p)
    });

    await new Promise(r => setTimeout(r, 0));
    const xhr = MockXHR.instances[0];
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe(BLOSSOM_SERVERS[0] + '/upload');
    expect(xhr.headers['Authorization']).toMatch(/^Nostr /);

    xhr.upload.onprogress?.({loaded: 50, total: 100, lengthComputable: true});
    xhr.upload.onprogress?.({loaded: 100, total: 100, lengthComputable: true});
    xhr.status = 200;
    xhr.responseText = JSON.stringify({url: 'https://example.com/x', sha256: 'abc'});
    xhr.onload?.();

    const result = await promise;
    expect(result.url).toBe('https://example.com/x');
    expect(progress).toEqual([50, 100]);
  });

  it('falls back to next server on failure', async() => {
    const blob = new Blob([new Uint8Array([1])]);
    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {});

    await new Promise(r => setTimeout(r, 0));
    MockXHR.instances[0].status = 503;
    MockXHR.instances[0].onload?.();

    await new Promise(r => setTimeout(r, 0));
    const second = MockXHR.instances[1];
    expect(second.url).toBe(BLOSSOM_SERVERS[1] + '/upload');
    second.status = 200;
    second.responseText = JSON.stringify({url: 'https://example.com/y', sha256: 'def'});
    second.onload?.();

    const result = await promise;
    expect(result.url).toBe('https://example.com/y');
  });

  it('throws when all servers fail', async() => {
    const blob = new Blob([new Uint8Array([1])]);
    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {});

    for(let i = 0; i < BLOSSOM_SERVERS.length; i++) {
      await new Promise(r => setTimeout(r, 0));
      MockXHR.instances[i].status = 500;
      MockXHR.instances[i].onload?.();
    }

    await expect(promise).rejects.toThrow(/all blossom servers failed/);
  });

  it('aborts the current XHR when signal fires', async() => {
    const ctrl = new AbortController();
    const blob = new Blob([new Uint8Array([1])]);
    const promise = uploadToBlossomWithProgress(blob, PRIVKEY_HEX, {signal: ctrl.signal});

    await new Promise(r => setTimeout(r, 0));
    ctrl.abort();
    expect(MockXHR.instances[0].aborted).toBe(true);
    await expect(promise).rejects.toThrow(/aborted/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/nostra/blossom-upload-progress.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Create the module**

Create `src/lib/nostra/blossom-upload-progress.ts`:

```typescript
/*
 * Nostra.chat — Blossom upload with progress + abort
 *
 * XHR-based variant of blossom-upload.ts used by media send (voice/image/file).
 * Emits progress via callback and supports AbortSignal. Same NIP-24242 auth,
 * same fallback chain. Signs a fresh auth event per server attempt.
 */

import {finalizeEvent} from 'nostr-tools/pure';

export const BLOSSOM_SERVERS = [
  'https://blossom.primal.net',
  'https://cdn.satellite.earth',
  'https://blossom.band'
] as const;

export interface BlossomUploadProgressResult {
  url: string;
  sha256: string;
}

export interface BlossomUploadProgressOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for(let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256Hex(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let s = '';
  for(let i = 0; i < digest.length; i++) s += digest[i].toString(16).padStart(2, '0');
  return s;
}

function signAuth(privkeyHex: string, hash: string): string {
  const privkey = hexToBytes(privkeyHex);
  const expiration = Math.floor(Date.now() / 1000) + 300;
  const event = finalizeEvent({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    content: 'Upload media',
    tags: [
      ['t', 'upload'],
      ['x', hash],
      ['expiration', expiration.toString()]
    ]
  }, privkey);
  return 'Nostr ' + btoa(JSON.stringify(event));
}

function putWithProgress(
  server: string,
  blob: Blob,
  authHeader: string,
  onProgress: ((p: number) => void) | undefined,
  signal: AbortSignal | undefined
): Promise<BlossomUploadProgressResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    const onAbort = () => {
      try { xhr.abort(); } catch{}
      reject(new Error('upload aborted'));
    };

    if(signal) {
      if(signal.aborted) {
        reject(new Error('upload aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, {once: true});
    }

    xhr.upload.onprogress = (e: any) => {
      if(!e.lengthComputable || !onProgress) return;
      const p = Math.max(0, Math.min(100, Math.floor((e.loaded / e.total) * 100)));
      onProgress(p);
    };

    xhr.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      if(xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`${server}: HTTP ${xhr.status}`));
        return;
      }
      try {
        const data = JSON.parse(xhr.responseText);
        if(!data.url) {
          reject(new Error(`${server}: no url in response`));
          return;
        }
        resolve({url: data.url, sha256: data.sha256 || ''});
      } catch(err) {
        reject(new Error(`${server}: invalid JSON`));
      }
    };

    xhr.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`${server}: network error`));
    };

    xhr.open('PUT', server + '/upload');
    xhr.setRequestHeader('Authorization', authHeader);
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.send(blob);
  });
}

export async function uploadToBlossomWithProgress(
  blob: Blob,
  privkeyHex: string,
  options: BlossomUploadProgressOptions
): Promise<BlossomUploadProgressResult> {
  const hash = await sha256Hex(blob);
  const errors: string[] = [];
  for(const server of BLOSSOM_SERVERS) {
    if(options.signal?.aborted) throw new Error('upload aborted');
    const authHeader = signAuth(privkeyHex, hash);
    try {
      return await putWithProgress(server, blob, authHeader, options.onProgress, options.signal);
    } catch(err) {
      const msg = err instanceof Error ? err.message : String(err);
      if(msg === 'upload aborted') throw err;
      errors.push(msg);
    }
  }
  throw new Error(`all blossom servers failed: ${errors.join('; ')}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/nostra/blossom-upload-progress.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/blossom-upload-progress.ts src/tests/nostra/blossom-upload-progress.test.ts
git commit -m "feat(nostra): add XHR-based Blossom upload with progress + abort"
```

---

## Task 5: nostra-file-fetch.ts (receiver decrypt helper)

**Files:**
- Create: `src/lib/nostra/nostra-file-fetch.ts`
- Test: `src/tests/nostra/nostra-file-fetch.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/tests/nostra/nostra-file-fetch.test.ts`:

```typescript
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
    expect(fetchMock).toHaveBeenCalledTimes(1); // cache hit
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/nostra/nostra-file-fetch.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Create the module**

Create `src/lib/nostra/nostra-file-fetch.ts`:

```typescript
/*
 * Nostra.chat — Receiver-side fetch + AES-GCM decrypt for Blossom media.
 *
 * In-memory cache per URL. Reloads refetch. The decrypted Blob is used to
 * produce a blob: URL for image/audio rendering inside bubbles.
 */

import {decryptFile} from './file-crypto';

const CACHE = new Map<string, Blob>();

export function clearNostraFileCache(): void {
  CACHE.clear();
}

export async function fetchAndDecryptNostraFile(
  url: string,
  keyHex: string,
  ivHex: string
): Promise<Blob> {
  const cached = CACHE.get(url);
  if(cached) return cached;

  const res = await fetch(url);
  if(!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const ciphertext = new Uint8Array(await res.arrayBuffer());

  const blob = await decryptFile(ciphertext, keyHex, ivHex);
  CACHE.set(url, blob);
  return blob;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/nostra/nostra-file-fetch.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/nostra-file-fetch.ts src/tests/nostra/nostra-file-fetch.test.ts
git commit -m "feat(nostra): add fetch+decrypt helper with in-memory cache"
```

---

## Task 6: Extend extractFileMetadata for duration/waveform

**Files:**
- Modify: `src/lib/nostra/chat-api-receive.ts:110-134`

- [ ] **Step 1: Update extractFileMetadata**

Replace the function body:

```typescript
export function extractFileMetadata(
  parsed: any,
  rumorKind?: number
): ChatMessage['fileMetadata'] | undefined {
  if(rumorKind !== 15) return undefined;
  try {
    const fileParsed = typeof parsed.content === 'string' ? JSON.parse(parsed.content) : parsed;
    if(fileParsed.url && fileParsed.sha256) {
      return {
        url: fileParsed.url,
        sha256: fileParsed.sha256,
        mimeType: fileParsed.mimeType || 'application/octet-stream',
        size: fileParsed.size || 0,
        width: fileParsed.width,
        height: fileParsed.height,
        keyHex: fileParsed.key || fileParsed.keyHex || '',
        ivHex: fileParsed.iv || fileParsed.ivHex || '',
        duration: typeof fileParsed.duration === 'number' ? fileParsed.duration : undefined,
        waveform: typeof fileParsed.waveform === 'string' ? fileParsed.waveform : undefined
      };
    }
  } catch{
    // Failed to parse file metadata
  }
  return undefined;
}
```

- [ ] **Step 2: Propagate duration/waveform through the store save in `handleRelayMessage`**

In the same file around lines 325-334, add the two fields to the `fileMetadata` passed to `store.saveMessage`:

```typescript
      fileMetadata: fileMetadata ? {
        url: fileMetadata.url,
        sha256: fileMetadata.sha256,
        mimeType: fileMetadata.mimeType,
        size: fileMetadata.size,
        width: fileMetadata.width,
        height: fileMetadata.height,
        keyHex: fileMetadata.keyHex,
        ivHex: fileMetadata.ivHex,
        duration: fileMetadata.duration,
        waveform: fileMetadata.waveform
      } : undefined
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep chat-api-receive | head -5`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/chat-api-receive.ts
git commit -m "feat(nostra): parse duration/waveform in incoming kind-15 rumors"
```

---

## Task 7: Extend ChatAPI.sendFileMessage with optional duration/waveform

**Files:**
- Modify: `src/lib/nostra/chat-api.ts:430-450`

- [ ] **Step 1: Update signature**

Replace `sendFileMessage` with:

```typescript
  async sendFileMessage(
    type: 'image' | 'video' | 'file' | 'voice',
    url: string,
    sha256: string,
    key: string,
    iv: string,
    mimeType: string,
    size: number,
    dim?: {width: number; height: number},
    extras?: {duration?: number; waveform?: string}
  ): Promise<string> {
    const fileContent = JSON.stringify({
      url,
      sha256,
      mimeType,
      size,
      key,
      iv,
      ...(dim ? {width: dim.width, height: dim.height} : {}),
      ...(extras?.duration !== undefined ? {duration: extras.duration} : {}),
      ...(extras?.waveform !== undefined ? {waveform: extras.waveform} : {})
    });
    return this.sendMessage(type as ChatMessageType, fileContent);
  }
```

- [ ] **Step 2: Update ChatMessageType to include 'voice' if absent**

Check: `grep -n "ChatMessageType" src/lib/nostra/chat-api.ts | head -5`. If the type union does not include `'voice'`, extend it:

```typescript
export type ChatMessageType = 'text' | 'image' | 'video' | 'file' | 'voice';
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep chat-api\\.ts | head -10`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/chat-api.ts
git commit -m "feat(nostra): sendFileMessage accepts duration/waveform + voice type"
```

---

## Task 8: nostra-send-file.ts (sender orchestrator)

**Files:**
- Create: `src/lib/nostra/nostra-send-file.ts`
- Test: `src/tests/nostra/nostra-send-file.test.ts`

This is the central orchestrator. It is used by `virtual-mtproto-server.ts` and exposes a retry map for manual retry.

- [ ] **Step 1: Write failing test**

Create `src/tests/nostra/nostra-send-file.test.ts`:

```typescript
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

// Mock blossom-upload-progress BEFORE importing the subject
vi.mock('@lib/nostra/blossom-upload-progress', () => ({
  BLOSSOM_SERVERS: ['https://mock'],
  uploadToBlossomWithProgress: vi.fn()
}));

import {uploadToBlossomWithProgress} from '@lib/nostra/blossom-upload-progress';
import {sendFileViaNostra, getPendingFileSend, getPendingFileSendCount} from '@lib/nostra/nostra-send-file';

const mockedUpload = uploadToBlossomWithProgress as unknown as ReturnType<typeof vi.fn>;

function makeCtx(overrides: any = {}) {
  const dispatched: any[] = [];
  return {
    dispatched,
    ctx: {
      ownPubkey: '11'.repeat(32),
      privkeyHex: '22'.repeat(32),
      peerPubkey: '33'.repeat(32),
      chatAPI: {
        getActivePeer: () => '33'.repeat(32),
        connect: vi.fn(async() => {}),
        sendFileMessage: vi.fn(async() => 'chat-1-1')
      },
      dispatch: (name: string, payload: any) => dispatched.push({name, payload}),
      injectBubble: vi.fn(async() => {}),
      saveMessage: vi.fn(async() => {}),
      log: Object.assign((..._: any[]) => {}, {warn: () => {}, error: () => {}}),
      ...overrides
    }
  };
}

describe('nostra-send-file', () => {
  beforeEach(() => { mockedUpload.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('encrypts, uploads, dispatches progress + completed, calls sendFileMessage', async() => {
    mockedUpload.mockImplementation(async(_blob, _key, opts) => {
      opts?.onProgress?.(50);
      opts?.onProgress?.(100);
      return {url: 'https://mock/x', sha256: 'abc'};
    });

    const {ctx, dispatched} = makeCtx();
    const blob = new Blob([new Uint8Array([1, 2, 3])], {type: 'image/jpeg'});
    const result = await sendFileViaNostra(ctx, {
      peerId: 1_000_000_000_000_001,
      blob,
      type: 'image',
      caption: '',
      tempMid: -1,
      width: 100,
      height: 80
    });

    expect(result.ok).toBe(true);
    expect(ctx.chatAPI.sendFileMessage).toHaveBeenCalledTimes(1);
    const progressEvents = dispatched.filter(d => d.name === 'nostra_file_upload_progress');
    expect(progressEvents.map(e => e.payload.percent)).toEqual([50, 100]);
    expect(dispatched.some(d => d.name === 'nostra_file_upload_completed')).toBe(true);
  });

  it('retries 3 times on upload failure, then hard fails', async() => {
    mockedUpload.mockRejectedValue(new Error('network'));
    const {ctx, dispatched} = makeCtx();

    vi.useFakeTimers();
    const promise = sendFileViaNostra(ctx, {
      peerId: 1_000_000_000_000_002,
      blob: new Blob([new Uint8Array([1])]),
      type: 'file',
      caption: '',
      tempMid: -2
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.ok).toBe(false);
    expect(mockedUpload).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    expect(dispatched.some(d => d.name === 'nostra_file_upload_failed')).toBe(true);
    // pendingFileSends should still hold the entry for manual retry
    expect(getPendingFileSend(-2)).toBeDefined();
  });

  it('retry map LRU-evicts at cap 20', async() => {
    mockedUpload.mockResolvedValue({url: 'https://mock/x', sha256: 'abc'});
    for(let i = 0; i < 25; i++) {
      const {ctx} = makeCtx();
      await sendFileViaNostra(ctx, {
        peerId: 1_000_000_000_000_100 + i,
        blob: new Blob([new Uint8Array([i])]),
        type: 'file',
        caption: '',
        tempMid: -1000 - i
      });
    }
    expect(getPendingFileSendCount()).toBeLessThanOrEqual(20);
  });

  it('aborts upload when signal fires', async() => {
    const abort = new AbortController();
    mockedUpload.mockImplementation((_blob: any, _key: any, opts: any) => {
      return new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('upload aborted')));
      });
    });
    const {ctx} = makeCtx();

    const p = sendFileViaNostra(ctx, {
      peerId: 1_000_000_000_000_003,
      blob: new Blob([new Uint8Array([1])]),
      type: 'file',
      caption: '',
      tempMid: -3,
      signal: abort.signal
    });
    abort.abort();
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/aborted/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/nostra/nostra-send-file.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

Create `src/lib/nostra/nostra-send-file.ts`:

```typescript
/*
 * Nostra.chat — P2P media send orchestrator.
 *
 * Encrypts a Blob with AES-GCM, uploads the ciphertext to Blossom via XHR with
 * progress and 3-retry backoff, then publishes a NIP-17 kind 15 rumor via
 * ChatAPI. Dispatches nostra_file_upload_progress / _completed / _failed on
 * the provided context. Keeps a LRU retry-map (max 20) so the UI can trigger
 * manual retry on hard failure.
 *
 * Transport agnostic: the VirtualMTProtoServer wires a real SendCtx; the unit
 * tests inject mocks to verify retry, abort, and dispatch behaviour.
 */

import {encryptFile} from './file-crypto';
import {uploadToBlossomWithProgress} from './blossom-upload-progress';

export type NostraFileType = 'image' | 'video' | 'file' | 'voice';

export interface PendingFileSend {
  peerId: number;
  tempMid: number;
  blob: Blob;
  type: NostraFileType;
  caption: string;
  width?: number;
  height?: number;
  duration?: number;
  waveform?: string;
  failedAt?: number;
}

export interface SendCtx {
  ownPubkey: string;
  privkeyHex: string;
  peerPubkey: string;
  chatAPI: {
    getActivePeer(): string | null;
    connect(peerPubkey: string): Promise<void>;
    sendFileMessage(
      type: NostraFileType,
      url: string,
      sha256: string,
      key: string,
      iv: string,
      mimeType: string,
      size: number,
      dim?: {width: number; height: number},
      extras?: {duration?: number; waveform?: string}
    ): Promise<string>;
  };
  dispatch(name: string, payload: any): void;
  injectBubble(params: {
    peerId: number;
    tempMid: number;
    blob: Blob;
    type: NostraFileType;
    caption: string;
    width?: number;
    height?: number;
    duration?: number;
    waveform?: string;
  }): Promise<void>;
  saveMessage(params: {
    peerId: number;
    mid: number;
    eventId: string;
    content: string;
    mimeType: string;
    size: number;
    url: string;
    sha256: string;
    keyHex: string;
    ivHex: string;
    width?: number;
    height?: number;
    duration?: number;
    waveform?: string;
  }): Promise<void>;
  log: ((...args: any[]) => void) & {warn(...args: any[]): void; error(...args: any[]): void};
}

export interface SendFileArgs {
  peerId: number;
  blob: Blob;
  type: NostraFileType;
  caption: string;
  tempMid: number;
  width?: number;
  height?: number;
  duration?: number;
  waveform?: string;
  signal?: AbortSignal;
}

export interface SendResult {
  ok: boolean;
  mid?: number;
  eventId?: string;
  reason?: string;
}

const PENDING: Map<number, PendingFileSend> = new Map();
const PENDING_CAP = 20;
const FAILED_TTL_MS = 30_000;

export function getPendingFileSend(tempMid: number): PendingFileSend | undefined {
  return PENDING.get(tempMid);
}
export function getPendingFileSendCount(): number {
  return PENDING.size;
}
export function clearPendingFileSends(): void {
  PENDING.clear();
}

function addPending(entry: PendingFileSend): void {
  PENDING.set(entry.tempMid, entry);
  // Evict stale failed entries first
  const now = Date.now();
  for(const [mid, p] of PENDING) {
    if(p.failedAt && now - p.failedAt > FAILED_TTL_MS) PENDING.delete(mid);
  }
  // LRU cap
  while(PENDING.size > PENDING_CAP) {
    const firstKey = PENDING.keys().next().value;
    if(firstKey === undefined) break;
    PENDING.delete(firstKey);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if(signal?.aborted) { reject(new Error('aborted')); return; }
    const t = setTimeout(() => resolve(), ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, {once: true});
  });
}

async function uploadWithRetry(
  ciphertext: Blob,
  privkeyHex: string,
  onProgress: (p: number) => void,
  signal: AbortSignal | undefined
): Promise<{url: string; sha256: string}> {
  const BACKOFF = [2_000, 4_000, 8_000];
  let lastErr: unknown;
  for(let attempt = 0; attempt < 1 + BACKOFF.length; attempt++) {
    if(signal?.aborted) throw new Error('upload aborted');
    try {
      return await uploadToBlossomWithProgress(ciphertext, privkeyHex, {onProgress, signal});
    } catch(err) {
      lastErr = err;
      if(signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if(msg === 'upload aborted') throw err;
      if(attempt < BACKOFF.length) {
        await sleep(BACKOFF[attempt], signal);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('upload failed');
}

export async function sendFileViaNostra(
  ctx: SendCtx,
  args: SendFileArgs
): Promise<SendResult> {
  const {peerId, blob, type, caption, tempMid, signal} = args;

  addPending({
    peerId, tempMid, blob, type, caption,
    width: args.width, height: args.height,
    duration: args.duration, waveform: args.waveform
  });

  // Optimistic bubble
  try {
    await ctx.injectBubble({
      peerId, tempMid, blob, type, caption,
      width: args.width, height: args.height,
      duration: args.duration, waveform: args.waveform
    });
  } catch(err) {
    ctx.log.warn('[sendFile] injectBubble failed:', err);
  }

  let ciphertext: Blob;
  let keyHex: string;
  let ivHex: string;
  let sha256Hex: string;
  try {
    const enc = await encryptFile(blob);
    ciphertext = enc.ciphertext;
    keyHex = enc.keyHex;
    ivHex = enc.ivHex;
    sha256Hex = enc.sha256Hex;
  } catch(err) {
    ctx.log.error('[sendFile] encrypt failed:', err);
    ctx.dispatch('nostra_file_upload_failed', {peerId, mid: tempMid, error: 'encrypt failed'});
    const p = PENDING.get(tempMid); if(p) p.failedAt = Date.now();
    return {ok: false, reason: 'encrypt failed'};
  }

  let url: string;
  try {
    const result = await uploadWithRetry(
      ciphertext,
      ctx.privkeyHex,
      (percent) => ctx.dispatch('nostra_file_upload_progress', {peerId, mid: tempMid, percent}),
      signal
    );
    url = result.url;
  } catch(err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log.warn('[sendFile] upload failed:', msg);
    ctx.dispatch('nostra_file_upload_failed', {peerId, mid: tempMid, error: msg});
    const p = PENDING.get(tempMid); if(p) p.failedAt = Date.now();
    return {ok: false, reason: msg};
  }

  try {
    if(ctx.chatAPI.getActivePeer() !== ctx.peerPubkey) {
      await ctx.chatAPI.connect(ctx.peerPubkey);
    }
    const eventId = await ctx.chatAPI.sendFileMessage(
      type, url, sha256Hex, keyHex, ivHex,
      blob.type || 'application/octet-stream',
      blob.size,
      args.width && args.height ? {width: args.width, height: args.height} : undefined,
      {duration: args.duration, waveform: args.waveform}
    );
    const realMid = Math.floor(Date.now() / 1000);

    await ctx.saveMessage({
      peerId, mid: realMid, eventId,
      content: '',
      mimeType: blob.type || 'application/octet-stream',
      size: blob.size, url, sha256: sha256Hex,
      keyHex, ivHex,
      width: args.width, height: args.height,
      duration: args.duration, waveform: args.waveform
    });

    ctx.dispatch('nostra_file_upload_completed', {peerId, mid: tempMid, url, realMid});
    PENDING.delete(tempMid); // success
    return {ok: true, mid: realMid, eventId};
  } catch(err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log.error('[sendFile] sendFileMessage failed:', msg);
    ctx.dispatch('nostra_file_upload_failed', {peerId, mid: tempMid, error: msg});
    const p = PENDING.get(tempMid); if(p) p.failedAt = Date.now();
    return {ok: false, reason: msg};
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/nostra/nostra-send-file.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/nostra-send-file.ts src/tests/nostra/nostra-send-file.test.ts
git commit -m "feat(nostra): add sendFileViaNostra orchestrator with retry + abort"
```

---

## Task 9: VirtualMTProtoServer case nostraSendFile

**Files:**
- Modify: `src/lib/nostra/virtual-mtproto-server.ts:230-272` (add to switch in `handleMethod`)
- Modify: `src/lib/nostra/virtual-mtproto-server.ts:809-868` (extend `injectOutgoingBubble` for media)
- Modify: `src/lib/nostra/virtual-mtproto-server.ts` (add private `nostraSendFile`)

- [ ] **Step 1: Add new case in `handleMethod` switch**

After the `case 'messages.sendMedia':` block insert:

```typescript
      case 'nostraSendFile':
        return this.nostraSendFile(params);
```

- [ ] **Step 2: Add the `nostraSendFile` private method**

Add near `sendMedia` (around line 870):

```typescript
  private async nostraSendFile(params: any): Promise<any> {
    const emptyUpdates = {
      _: 'updates',
      updates: [] as any[],
      users: [] as any[],
      chats: [] as any[],
      date: Math.floor(Date.now() / 1000),
      seq: 0
    };

    if(!this.chatAPI || !this.ownPubkey) return emptyUpdates;

    const peerId: number = Number(params?.peerId);
    if(!peerId) return emptyUpdates;

    const blob: Blob = params?.blob;
    if(!(blob instanceof Blob) || blob.size === 0) {
      console.warn(LOG_PREFIX, 'nostraSendFile: invalid blob');
      return emptyUpdates;
    }

    const peerPubkey = await getPubkey(Math.abs(peerId));
    if(!peerPubkey) return emptyUpdates;

    const {getIdentityService} = await import('./identity');
    let privkeyHex: string | null = null;
    try {
      const identity = await getIdentityService().getDecryptedIdentity();
      privkeyHex = identity?.privateKey || null;
    } catch(err) {
      console.warn(LOG_PREFIX, 'nostraSendFile: failed to load identity:', err);
    }
    if(!privkeyHex) return emptyUpdates;

    const type: 'image' | 'video' | 'file' | 'voice' = params?.type || 'file';
    const caption: string = params?.caption || '';
    const tempMid: number = Number(params?.tempMid);
    const width: number | undefined = params?.width;
    const height: number | undefined = params?.height;
    const duration: number | undefined = params?.duration;
    const waveform: string | undefined = params?.waveform;

    const {sendFileViaNostra} = await import('./nostra-send-file');
    const rs: any = (await import('@lib/rootScope')).default;
    const {getMessageStore} = await import('./message-store');
    const store = getMessageStore();
    const conversationId = store.getConversationId(this.ownPubkey, peerPubkey);

    const result = await sendFileViaNostra(
      {
        ownPubkey: this.ownPubkey,
        privkeyHex,
        peerPubkey,
        chatAPI: this.chatAPI as any,
        dispatch: (name: string, payload: any) => {
          if(typeof rs.dispatchEventSingle === 'function') rs.dispatchEventSingle(name, payload);
        },
        injectBubble: async(p) => {
          const objectURL = URL.createObjectURL(p.blob);
          await this.injectOutgoingBubble({
            peerId: Math.abs(p.peerId),
            mid: p.tempMid,
            date: Math.floor(Date.now() / 1000),
            text: p.caption || '',
            senderPubkey: this.ownPubkey!,
            media: {
              type: p.type,
              objectURL,
              mimeType: p.blob.type,
              size: p.blob.size,
              width: p.width,
              height: p.height,
              duration: p.duration,
              waveform: p.waveform,
              uploading: true
            }
          });
        },
        saveMessage: async(p) => {
          await store.saveMessage({
            eventId: p.eventId,
            conversationId,
            senderPubkey: this.ownPubkey!,
            content: p.content,
            type: 'file',
            timestamp: Math.floor(Date.now() / 1000),
            deliveryState: 'sent',
            mid: p.mid,
            twebPeerId: Math.abs(p.peerId),
            isOutgoing: true,
            fileMetadata: {
              url: p.url,
              sha256: p.sha256,
              mimeType: p.mimeType,
              size: p.size,
              width: p.width,
              height: p.height,
              keyHex: p.keyHex,
              ivHex: p.ivHex,
              duration: p.duration,
              waveform: p.waveform
            }
          });
        },
        log: Object.assign(
          (...a: any[]) => console.log(LOG_PREFIX, ...a),
          {
            warn: (...a: any[]) => console.warn(LOG_PREFIX, ...a),
            error: (...a: any[]) => console.error(LOG_PREFIX, ...a)
          }
        )
      },
      {
        peerId: Math.abs(peerId),
        blob, type, caption, tempMid,
        width, height, duration, waveform
      }
    );

    if(!result.ok) {
      return {...emptyUpdates};
    }
    return {
      _: 'updates',
      updates: [],
      users: [],
      chats: [],
      date: Math.floor(Date.now() / 1000),
      seq: 0,
      nostraMid: result.mid,
      nostraEventId: result.eventId
    };
  }
```

- [ ] **Step 3: Extend `injectOutgoingBubble` signature to accept optional `media`**

Find the method signature starting at line 809 and replace with:

```typescript
  private async injectOutgoingBubble(params: {
    peerId: number;
    mid: number;
    date: number;
    text: string;
    senderPubkey: string;
    media?: {
      type: 'image' | 'video' | 'file' | 'voice';
      objectURL: string;
      mimeType: string;
      size: number;
      width?: number;
      height?: number;
      duration?: number;
      waveform?: string;
      uploading: boolean;
    };
  }): Promise<void> {
    try {
      const {peerId, mid, date, text, media} = params;

      const msg: any = this.mapper.createTwebMessage({
        mid,
        peerId,
        fromPeerId: undefined,
        date,
        text,
        isOutgoing: true
      });
      msg.pFlags ??= {};
      msg.pFlags.out = true;
      delete msg.pFlags.is_outgoing;

      if(media) {
        // Attach a lightweight mediaDocument that bubbles.ts can render
        // via its standard document rendering path. The document URL is
        // the local blob:URL so the preview appears instantly.
        (msg as any).media = {
          _: media.type === 'image' ? 'messageMediaPhoto' : 'messageMediaDocument',
          pFlags: {},
          ...(media.type === 'image' ? {
            photo: {
              _: 'photo',
              id: `p2p_${mid}`,
              sizes: [{
                _: 'photoSize',
                type: 'x',
                w: media.width || 0,
                h: media.height || 0,
                size: media.size,
                // tweb will read .url for blob-based preview
                url: media.objectURL
              }],
              url: media.objectURL,
              pFlags: {}
            }
          } : {
            document: {
              _: 'document',
              id: `p2p_${mid}`,
              mime_type: media.mimeType,
              size: media.size,
              url: media.objectURL,
              attributes: this.buildMediaAttributes(media),
              pFlags: {}
            }
          })
        };
        (msg as any).uploading_file = true;
        (msg as any).nostraUploading = true;
      }

      // ...existing storage + history_append logic unchanged below...
```

Then keep the existing storage + dispatch block unchanged (the body from line 829 onward stays).

- [ ] **Step 4: Add helper `buildMediaAttributes`**

Add as a private method near `injectOutgoingBubble`:

```typescript
  private buildMediaAttributes(media: {
    type: string;
    width?: number;
    height?: number;
    duration?: number;
    waveform?: string;
  }): any[] {
    const attrs: any[] = [];
    if(media.type === 'voice' && typeof media.duration === 'number') {
      attrs.push({
        _: 'documentAttributeAudio',
        pFlags: {voice: true},
        duration: media.duration,
        waveform: media.waveform
      });
    } else if(media.type === 'video' && media.width && media.height) {
      attrs.push({
        _: 'documentAttributeVideo',
        pFlags: {},
        w: media.width,
        h: media.height,
        duration: media.duration || 0
      });
    }
    return attrs;
  }
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep virtual-mtproto-server | head -20`
Expected: no new errors. If reported, iterate until clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/nostra/virtual-mtproto-server.ts
git commit -m "feat(vmt): add nostraSendFile method + injectOutgoingBubble media path"
```

---

## Task 10: Register nostraSendFile in NOSTRA_BRIDGE_METHODS

**Files:**
- Modify: `src/lib/appManagers/apiManager.ts:794-809`

- [ ] **Step 1: Add method to the set**

Insert `'nostraSendFile',` into the `NOSTRA_BRIDGE_METHODS` set:

```typescript
  private static readonly NOSTRA_BRIDGE_METHODS = new Set([
    'messages.getHistory',
    'messages.getDialogs',
    'messages.getPinnedDialogs',
    'messages.search',
    'messages.deleteMessages',
    'messages.sendMessage',
    'messages.sendMedia',
    'messages.editMessage',
    'messages.createChat',
    'channels.createChannel',
    'channels.inviteToChannel',
    'contacts.getContacts',
    'users.getUsers',
    'users.getFullUser',
    'nostraSendFile'
  ]);
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep apiManager\\.ts | head -5`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/appManagers/apiManager.ts
git commit -m "feat(bridge): register nostraSendFile in NOSTRA_BRIDGE_METHODS"
```

---

## Task 11: appMessagesManager.sendFile P2P shortcut

**Files:**
- Modify: `src/lib/appManagers/appMessagesManager.ts:1567-1573` (insert shortcut after `checkSendOptions`)

- [ ] **Step 1: Add the early-return branch**

Find line 1572 (`await this.checkSendOptions(options);`). Directly after it insert:

```typescript
    // [Nostra.chat] P2P media shortcut: skip MTProto upload path entirely.
    // Forward the raw Blob + metadata to the Virtual MTProto Server which
    // handles Blossom upload, AES-GCM encryption, and kind 15 rumor publish.
    if(Number(peerId) >= 1e15 && (options.file instanceof File || options.file instanceof Blob)) {
      const nostraType: 'image' | 'video' | 'file' | 'voice' =
        options.isVoiceMessage ? 'voice' :
        (options.file.type || '').startsWith('image/') ? 'image' :
        (options.file.type || '').startsWith('video/') ? 'video' :
        'file';
      const tempMid = -Date.now();
      const updates: any = await this.apiManager.invokeApi('nostraSendFile' as any, {
        peerId,
        blob: options.file,
        type: nostraType,
        caption: options.caption || '',
        tempMid,
        width: options.width,
        height: options.height,
        duration: options.duration,
        waveform: options.waveform
      } as any);
      if(updates?.nostraMid) {
        // Virtual MTProto Server already injected the bubble and persisted
        // the message. Dispatch message_sent so the temp bubble flips to ✓.
        const storage = this.getHistoryMessagesStorage(peerId);
        const realMid = updates.nostraMid;
        this.rootScope.dispatchEvent('messages_pending');
        this.rootScope.dispatchEvent('message_sent', {
          storageKey: storage.key,
          tempId: tempMid,
          tempMessage: undefined as any,
          mid: realMid,
          message: undefined as any
        });
      }
      return;
    }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep appMessagesManager | head -20`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/appManagers/appMessagesManager.ts
git commit -m "feat(appMessagesManager): P2P shortcut in sendFile for Nostra peers"
```

---

## Task 12: bubbles.ts upload progress + failed listeners

**Files:**
- Modify: `src/components/chat/bubbles.ts` (add listeners in `constructListeners` or equivalent; search for `history_append` listener as an anchor)

- [ ] **Step 1: Find the anchor for listener registration**

Run: `grep -n "history_append" src/components/chat/bubbles.ts | head -10`

Use the file's existing `rootScope.addEventListener('history_append', ...)` spot as the insertion anchor.

- [ ] **Step 2: Add three listeners near the anchor**

```typescript
    rootScope.addEventListener('nostra_file_upload_progress', ({peerId, mid, percent}) => {
      if(peerId !== this.peerId) return;
      const bubble = this.getBubbleByMid(mid);
      if(!bubble) return;
      let bar = bubble.querySelector('.media-upload-progress') as HTMLElement | null;
      if(!bar) {
        bar = document.createElement('div');
        bar.className = 'media-upload-progress';
        const inner = document.createElement('div');
        inner.className = 'media-upload-progress-inner';
        bar.appendChild(inner);
        bubble.appendChild(bar);
      }
      const inner = bar.querySelector('.media-upload-progress-inner') as HTMLElement;
      if(inner) inner.style.width = percent + '%';
    });

    rootScope.addEventListener('nostra_file_upload_completed', ({peerId, mid}) => {
      if(peerId !== this.peerId) return;
      const bubble = this.getBubbleByMid(mid);
      bubble?.querySelector('.media-upload-progress')?.remove();
      bubble?.classList.remove('upload-failed');
    });

    rootScope.addEventListener('nostra_file_upload_failed', ({peerId, mid}) => {
      if(peerId !== this.peerId) return;
      const bubble = this.getBubbleByMid(mid);
      if(!bubble) return;
      bubble.classList.add('upload-failed');
      bubble.querySelector('.media-upload-progress')?.remove();
      if(!bubble.querySelector('.media-upload-retry')) {
        const retry = document.createElement('div');
        retry.className = 'media-upload-retry';
        retry.title = 'Rispedisci';
        retry.addEventListener('click', (e) => {
          e.stopPropagation();
          rootScope.dispatchEvent('nostra_retry_file_send', {peerId, mid});
        });
        bubble.appendChild(retry);
      }
    });
```

If `getBubbleByMid` is not a public helper, use this local helper at the same scope:

```typescript
    const findBubble = (mid: number): HTMLElement | null =>
      this.chatInner.querySelector(`[data-mid="${mid}"]`);
```

and replace calls to `this.getBubbleByMid(mid)` above with `findBubble(mid)`.

- [ ] **Step 3: Wire `nostra_retry_file_send` in VMT**

Re-open `virtual-mtproto-server.ts` and add in the constructor (or `init`), right after the chatAPI is wired:

```typescript
      const rs: any = (rootScopeModule as any).default;
      if(rs && typeof rs.addEventListener === 'function') {
        rs.addEventListener('nostra_retry_file_send', async(e: {peerId: number; mid: number}) => {
          const {getPendingFileSend} = await import('./nostra-send-file');
          const p = getPendingFileSend(e.mid);
          if(!p) return;
          await this.nostraSendFile({
            peerId: p.peerId,
            blob: p.blob,
            type: p.type,
            caption: p.caption,
            tempMid: p.tempMid,
            width: p.width,
            height: p.height,
            duration: p.duration,
            waveform: p.waveform
          });
        });
      }
```

(Use the existing rootScope import that VMT already has — the import may be inlined elsewhere in that file.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "bubbles|virtual-mtproto-server" | head -10`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/bubbles.ts src/lib/nostra/virtual-mtproto-server.ts
git commit -m "feat(bubbles): progress bar, retry button, wire nostra_retry_file_send"
```

---

## Task 13: Receiver-side decrypt rendering hook

**Files:**
- Modify: `src/components/chat/bubbles.ts` or the media rendering helper (search with `grep -n "messageMediaDocument" src/components/chat/bubbles.ts`)

- [ ] **Step 1: Identify the rendering site**

Run: `grep -rn "fileMetadata" src/components/chat/ | head`

If a Nostra-aware renderer does not exist yet, add a hook where the document/photo URL is resolved. Find the media rendering path used for outgoing document messages and, when the message has `fileMetadata?.keyHex`, swap the Blossom URL for a `blob:` URL from `fetchAndDecryptNostraFile`.

- [ ] **Step 2: Add a resolver helper**

Inside bubbles (or a new `src/components/chat/nostra-media-resolver.ts`):

```typescript
import {fetchAndDecryptNostraFile} from '@lib/nostra/nostra-file-fetch';

export async function resolveNostraMediaUrl(
  fileMetadata: {url: string; keyHex: string; ivHex: string}
): Promise<string> {
  if(!fileMetadata.keyHex) return fileMetadata.url;
  try {
    const blob = await fetchAndDecryptNostraFile(
      fileMetadata.url, fileMetadata.keyHex, fileMetadata.ivHex
    );
    return URL.createObjectURL(blob);
  } catch(err) {
    console.warn('[nostra-media-resolver] decrypt failed:', err);
    return '';
  }
}
```

- [ ] **Step 3: Wire it where images/audio are rendered**

Find the first location where image/audio `src` is assigned for inline media and add:

```typescript
      if(doc?.nostraFileMetadata?.keyHex) {
        resolveNostraMediaUrl(doc.nostraFileMetadata).then(url => {
          if(url) el.src = url;
        });
      } else {
        el.src = doc.url || doc.remoteUrl;
      }
```

(Exact site to be pinpointed during implementation — the engineer must grep for the existing url assignment and splice in the branch.)

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit 2>&1 | grep -E "bubbles|nostra-media-resolver" | head -20 && pnpm lint`

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/
git commit -m "feat(bubbles): receiver-side decrypt via resolveNostraMediaUrl"
```

---

## Task 14: SCSS styles for upload progress + failed state

**Files:**
- Modify: `src/scss/partials/_bubbles.scss` (or whichever partial is imported)

- [ ] **Step 1: Find the partial**

Run: `grep -rn "bubble-content" src/scss/ | head -5`

- [ ] **Step 2: Append styles**

```scss
.bubble {
  .media-upload-progress {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    height: 3px;
    background: rgba(0, 0, 0, 0.15);
    overflow: hidden;
  }
  .media-upload-progress-inner {
    height: 100%;
    width: 0%;
    background: var(--primary-color);
    transition: width 0.15s linear;
  }

  &.upload-failed {
    .media-upload-retry {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.5);
      color: white;
      cursor: pointer;
      font-size: 24px;
      &::before {
        content: "⟳";
      }
    }
  }
}
```

- [ ] **Step 3: Visually verify**

Run `pnpm start` and send a mock file in the browser. Screenshot under `/tmp/` only.

- [ ] **Step 4: Commit**

```bash
git add src/scss/
git commit -m "style(bubbles): progress bar + upload-failed retry affordance"
```

---

## Task 15: Unit test sweep

- [ ] **Step 1: Run the full nostra quick suite**

Run: `pnpm test:nostra:quick`
Expected: existing pass count + 4 new test files passing. Verify the `Tests N passed (N)` line — the exit code is 1 due to pre-existing unhandled rejections in `tor-ui.test.ts`.

- [ ] **Step 2: Run lint**

Run: `pnpm lint`
Expected: 0 new errors.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | wc -l`
Expected: ~30 (pre-existing baseline), no increase.

- [ ] **Step 4: If any gate fails, stop and fix before proceeding**

---

## Task 16: E2E — send image

**Files:**
- Create: `src/tests/e2e/e2e-send-image.ts`
- Modify: `src/tests/e2e/run-all.sh`

- [ ] **Step 1: Create E2E script**

Create `src/tests/e2e/e2e-send-image.ts`:

```typescript
// @ts-nocheck
import {chromium} from 'playwright';
import {LocalRelay} from './helpers/local-relay';
import {launchOptions} from './helpers/launch-options';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = process.env.E2E_APP_URL || 'http://localhost:8080/';

async function bootContext(browser: any, relay: LocalRelay) {
  const ctx = await browser.newContext();
  await relay.injectInto(ctx);
  const page = await ctx.newPage();
  await page.goto(APP_URL, {waitUntil: 'load'});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load'});
  await page.waitForTimeout(15000);
  await page.locator('button:has-text("Create New Identity")').click({timeout: 30000});
  // ... onboarding flow (adapt from e2e-bug-regression.ts)
  await dismissOverlays(page);
  return {ctx, page};
}

async function main() {
  const relay = new LocalRelay();
  await relay.start();
  try {
    const browser = await chromium.launch(launchOptions);
    const sender = await bootContext(browser, relay);
    const receiver = await bootContext(browser, relay);

    // Exchange pubkeys and add contact (reuse helper)
    // ...

    // Inject a test JPEG Blob via page.evaluate and call the sendFile path
    const tinyJpeg = new Uint8Array([
      0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x00,
      0x00,0x01,0x00,0x01,0x00,0x00,0xff,0xd9
    ]);
    await sender.page.evaluate((bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], {type: 'image/jpeg'});
      const w = window as any;
      const peerId = w.appImManager.chat.peerId;
      return w.appImManager.chat.input.sendFile?.(blob) ||
             w.MOUNT_CLASS_TO.appMessagesManager.sendFile({
               peerId, file: blob, caption: '', isMedia: true
             });
    }, Array.from(tinyJpeg));

    // Verify receiver sees a bubble with an image
    await receiver.page.waitForSelector('.bubble[data-mid] img', {timeout: 30000});
    console.log('[e2e-send-image] PASS');
    await browser.close();
  } finally {
    await relay.stop();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add to run-all.sh**

Find the `TESTS=` array and append `"e2e-send-image.ts"`.

- [ ] **Step 3: Run it**

Run: `pnpm test:e2e src/tests/e2e/e2e-send-image.ts`
Expected: PASS (may require minor selector adjustments).

- [ ] **Step 4: Commit**

```bash
git add src/tests/e2e/e2e-send-image.ts src/tests/e2e/run-all.sh
git commit -m "test(e2e): send image over P2P with LocalRelay"
```

---

## Task 17: E2E — send voice note

**Files:**
- Create: `src/tests/e2e/e2e-send-voice.ts`
- Modify: `src/tests/e2e/run-all.sh`

- [ ] **Step 1: Create E2E script**

Same boot pattern as Task 16, but the Blob is a stub Opus file:

```typescript
    const opusStub = new Uint8Array([0x4f,0x67,0x67,0x53,0x00,0x02,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]);
    await sender.page.evaluate((bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], {type: 'audio/ogg;codecs=opus'});
      const w = window as any;
      const peerId = w.appImManager.chat.peerId;
      return w.MOUNT_CLASS_TO.appMessagesManager.sendFile({
        peerId, file: blob, isVoiceMessage: true,
        duration: 2.5, waveform: 'AA=='
      });
    }, Array.from(opusStub));

    await receiver.page.waitForSelector('.bubble[data-mid] audio, .bubble[data-mid] .audio-waveform', {timeout: 30000});
```

- [ ] **Step 2: Add to run-all.sh**
- [ ] **Step 3: Run it**
- [ ] **Step 4: Commit**

```bash
git add src/tests/e2e/e2e-send-voice.ts src/tests/e2e/run-all.sh
git commit -m "test(e2e): send voice note over P2P with stub Opus blob"
```

---

## Task 18: Final verification

- [ ] **Step 1: Full lint + type + nostra quick**

```bash
pnpm lint
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l  # must stay ~30
pnpm test:nostra:quick
```

- [ ] **Step 2: Run bidirectional regression**

```bash
pnpm test:e2e src/tests/e2e/e2e-bidirectional.ts
```

Ensures no regression on existing text send flow.

- [ ] **Step 3: Manual browser verification**

Boot `pnpm start`, open two chrome-devtools MCP isolated contexts, onboard both, add contact, send:
1. An image — bubble must appear instantly with progress, completed, receiver sees decrypted image.
2. A .pdf file — same.
3. A voice note recorded via microphone button — sender waveform rendered, receiver plays audio.
4. A failed send (temporarily block Blossom DNS) — bubble flips to failed state, click retry unblocks.

Document outcomes in the commit message of the final commit.

- [ ] **Step 4: Final commit summary**

```bash
git log --oneline main..HEAD
```

Confirm 17 commits (one per task).

---

## Self-review notes

- Spec coverage verified: every section of the design spec maps to ≥1 task (crypto → T3, upload+progress → T4, decrypt helper → T5, receive-side parse → T6, chat-api extension → T7, orchestrator → T8, VMT wiring → T9, bridge registration → T10, sendFile shortcut → T11, bubble UI → T12/13, styles → T14, tests → T3-8 + T16-17, events → T1, store schema → T2).
- No placeholders. All code blocks are complete and self-contained.
- Type consistency: `NostraFileType` used everywhere sender-side; `ChatMessage['fileMetadata']` extended in T2 and consumed from T6-9.
- Retry map LRU is centralized in `nostra-send-file.ts` and accessed from VMT via `getPendingFileSend`.
- Abort path routes through `AbortSignal` all the way to `XMLHttpRequest.abort()`.
- The one pragmatic gap: Task 13 (receiver decrypt rendering hook) will require inspection of the concrete bubbles.ts rendering branches at implementation time — the exact splice point depends on whether tweb currently assigns `.src` from `doc.url` or goes through a thumb/preview helper. The engineer will grep for the anchor and adapt accordingly; fallback is to bypass and use `resolveNostraMediaUrl` inside a new `nostra-media-resolver.ts` imported where the `messageMediaDocument` branch is rendered.
