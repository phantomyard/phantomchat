# P2P Media Send — Design

**Status:** Approved
**Date:** 2026-04-15
**Scope:** Images, generic files, voice notes. Video/GIF/compression excluded.

## Problem

`messages.sendMedia` in `virtual-mtproto-server.ts:870` is a stub. It drops attachments and sends only the caption as text. Users cannot share images, files, or voice notes over the P2P pipeline even though:

- `ChatAPI.sendFileMessage()` (chat-api.ts:430) can publish kind 15 rumors.
- `uploadToBlossom()` (blossom-upload.ts) uploads via the Blossom fallback chain.
- `extractFileMetadata()` (chat-api-receive.ts:111) already parses kind 15 incoming rumors with `keyHex`/`ivHex` fields.

The gap is the sender pipeline: upload + encrypt + wire VMT to `sendFileMessage` + render the outgoing bubble with media.

## Non-goals

- Video sending and video thumbnails.
- File compression (photo downscaling, opus re-encoding).
- Resumable uploads across reloads (failed-state retry is in-memory only).
- Persistent offline queue for media (tracked as a separate issue).
- Progress bar for the *receive-side* decrypt/fetch.

## Architecture

```
[UI] attach / record
   ↓ Blob + metadata (type, caption, duration?, width?, height?, waveform?)
[Worker] appMessagesManager.sendFile()
   ↓ if peerId >= 1e15 → shortcut, else unchanged MTProto path
   ↓ apiManager.invokeApi('nostraSendFile', {peerId, blob, type, caption, tempMid, ...})
[Worker→Main] port.invoke('nostraBridge', {method: 'nostraSendFile', params})
[Main] VirtualMTProtoServer.nostraSendFile()
   1. Inject optimistic bubble (tempMid, blob:URL preview, progress 0%)
   2. encryptFile(blob) → {ciphertext, keyHex, ivHex, sha256Hex}
   3. uploadToBlossomWithProgress(ciphertext, privkey, onProgress, signal)
      ├ dispatch 'nostra_file_upload_progress' {peerId, mid, percent}
      └ 3 retry 2s/4s/8s on total failure
   4. chatAPI.sendFileMessage(type, url, sha256, keyHex, ivHex, mime, size, dim, duration?, waveform?)
   5. message-store.saveMessage({..., fileMetadata, deliveryState: 'sent'})
   6. dispatch 'nostra_file_upload_completed', rename tempMid → realMid
   7. return {_: 'updates', ..., nostraMid, nostraEventId}
[Recv] kind 15 gift-wrap → extractFileMetadata → render
         ↓ fetchAndDecryptNostraFile(url, keyHex, ivHex) → blob:URL
         ↓ image/audio element consumes blob:URL
```

## Modules

### New files

| File | ~LOC | Purpose |
|---|---|---|
| `src/lib/nostra/file-crypto.ts` | 60 | `encryptFile(blob) → {ciphertext, keyHex, ivHex, sha256Hex}`, `decryptFile(bytes, keyHex, ivHex) → Blob`. WebCrypto AES-GCM 256. |
| `src/lib/nostra/blossom-upload-progress.ts` | 120 | XHR-based variant of `uploadToBlossom` with `onProgress(percent)` callback and `AbortSignal`. Same NIP-24242 auth event, same fallback chain. |
| `src/lib/nostra/nostra-send-file.ts` | 180 | Orchestrator: `sendFileViaNostra({peerId, blob, type, caption, ...}) → Promise<{mid, eventId}>`. Handles encrypt, upload with 3 retries, dispatches progress events, persists, injects bubble, tracks `pendingFileSends: Map<mid, PendingFileSend>` for manual retry. |
| `src/lib/nostra/nostra-file-fetch.ts` | 40 | `fetchAndDecryptNostraFile(url, keyHex, ivHex) → Blob`. In-memory `Map<url, Blob>` cache. Graceful on fetch 404 / decrypt error. |

### Modified files

| File | Change | ~LOC |
|---|---|---|
| `src/lib/rootScope.ts` | Add `nostra_file_upload_progress`, `nostra_file_upload_failed`, `nostra_file_upload_completed`, `nostra_retry_file_send` to `BroadcastEvents`. | 8 |
| `src/lib/appManagers/apiManager.ts` | Add `nostraSendFile` to `NOSTRA_BRIDGE_METHODS`. | 1 |
| `src/lib/nostra/virtual-mtproto-server.ts` | New case `nostraSendFile` in `handleMethod`; delegates to `nostra-send-file.ts`. Extend `injectOutgoingBubble` to accept optional `media` payload. Keep `sendMedia` stub as fallback (caption-only) in case legacy path still hits it. | 80 |
| `src/lib/appManagers/appMessagesManager.ts` | Early-return branch in `sendFile()` when `peerId >= 1e15`: invoke `apiManager.invokeApi('nostraSendFile', {...})` with temp mid, skip `apiFileManager.upload` + `inputMediaUploadedPhoto/Document`. | 60 |
| `src/lib/nostra/chat-api.ts` | Extend `sendFileMessage` signature to accept optional `duration` + `waveform`. Extend `ChatMessage.fileMetadata` + `StoredMessage.fileMetadata` types. | 20 |
| `src/lib/nostra/chat-api-receive.ts` | Extend `extractFileMetadata` to parse `duration`, `waveform` fields. | 10 |
| `src/lib/nostra/message-store.ts` | Extend `StoredMessage.deliveryState` union with `'failed'`. Extend `fileMetadata` schema with `duration`, `waveform`. | 5 |
| `src/components/chat/bubbles.ts` | Listener for `nostra_file_upload_progress` (update `.bubble[data-mid="${mid}"] .media-upload-progress` width). Listener for `nostra_file_upload_failed` (add `.upload-failed` class). Click handler on `.upload-failed` → dispatch `nostra_retry_file_send`. | 50 |
| `src/scss/partials/_bubbles.scss` (or equivalent) | Styles for `.media-upload-progress` + `.upload-failed` retry affordance. | 30 |

### Test files

| File | Purpose |
|---|---|
| `src/tests/nostra/file-crypto.test.ts` | Round-trip encrypt/decrypt, key uniqueness, sha256-of-ciphertext. |
| `src/tests/nostra/blossom-upload-progress.test.ts` | Mock XHR, progress event propagation, fallback chain, abort signal, auth event format. |
| `src/tests/nostra/nostra-send-file.test.ts` | Orchestrator with mocked ChatAPI + blossom: retry 3x + hard-fail, event dispatch, `pendingFileSends` LRU eviction. |
| `src/tests/nostra/nostra-file-fetch.test.ts` | Cache hit/miss, decrypt error handling. |
| `src/tests/e2e/e2e-send-image.ts` | LocalRelay + two isolated contexts. Sender injects a JPEG Blob via `appImManager.chat.input`, verifies receiver bubble renders decrypted image. |
| `src/tests/e2e/e2e-send-voice.ts` | Inject an Opus Blob directly (bypass `MediaRecorder` since headless Chromium is unreliable), verify receiver bubble renders voice with waveform + duration. |

## Data flow details

### Encryption

WebCrypto AES-GCM with a 256-bit random key and 96-bit random IV per file. `sha256Hex` is the hash of the **ciphertext**, not the plaintext — Blossom's NIP-24242 auth event binds the upload hash to the PUT body, and Blossom computes the hash over the PUT body (ciphertext). The `sha256` field in the kind 15 rumor is the same ciphertext hash, usable for integrity check only.

```ts
// file-crypto.ts
export async function encryptFile(blob: Blob): Promise<{
  ciphertext: Blob; keyHex: string; ivHex: string; sha256Hex: string;
}> {
  const plaintext = new Uint8Array(await blob.arrayBuffer());
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey('raw', key, {name: 'AES-GCM'}, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, cryptoKey, plaintext));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', ct));
  return {
    ciphertext: new Blob([ct], {type: 'application/octet-stream'}),
    keyHex: bytesToHex(key),
    ivHex: bytesToHex(iv),
    sha256Hex: bytesToHex(digest)
  };
}
```

### Decryption

```ts
// nostra-file-fetch.ts
const CACHE = new Map<string, Blob>(); // url → decrypted plaintext Blob

export async function fetchAndDecryptNostraFile(
  url: string, keyHex: string, ivHex: string
): Promise<Blob> {
  if(CACHE.has(url)) return CACHE.get(url)!;
  const res = await fetch(url);
  if(!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const ciphertext = new Uint8Array(await res.arrayBuffer());
  const key = await crypto.subtle.importKey('raw', hexToBytes(keyHex), {name: 'AES-GCM'}, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({name: 'AES-GCM', iv: hexToBytes(ivHex)}, key, ciphertext);
  const blob = new Blob([plaintext]);
  CACHE.set(url, blob);
  return blob;
}
```

Cache is in-memory per-session. Reloads refetch. Persisting decrypted plaintexts to IndexedDB would require GC policies not worth designing now.

### Backward compatibility

`extractFileMetadata` already tolerates missing `keyHex`/`ivHex`. The renderer branches:
- `keyHex` present and non-empty → fetch ciphertext + decrypt → `blob:` URL.
- `keyHex` empty → use the Blossom URL directly (covers hypothetical future plaintext-publishing clients).

## Events

New `BroadcastEvents` entries:

```ts
nostra_file_upload_progress: {peerId: number; mid: number; percent: number};
nostra_file_upload_failed: {peerId: number; mid: number; error: string};
nostra_file_upload_completed: {peerId: number; mid: number; url: string; realMid: number};
nostra_retry_file_send: {peerId: number; mid: number};
```

All dispatched via `rootScope.dispatchEventSingle` on the main thread (VMT rule: never use `dispatchEvent` from main-thread Nostra code).

## Error handling and retries

- **Upload retry:** 3 attempts with 2s → 4s → 8s backoff. The same `{ciphertext, keyHex, ivHex, sha256Hex}` is reused across retries (IV is generated once). A fresh NIP-24242 auth event is signed per attempt (5-minute expiry, safe margin).
- **`AbortSignal`:** wired through `blossom-upload-progress.ts`. Triggered on user-initiated delete of the pending bubble. NOT triggered on `peer_changed` — uploads continue in background.
- **Hard fail:** after all retries, the bubble enters `deliveryState: 'failed'`. The original Blob + metadata stay in `pendingFileSends: Map<mid, PendingFileSend>` with LRU cap 20 entries and 30s TTL after failure. Click-to-retry dispatches `nostra_retry_file_send` → VMT re-enters the upload pipeline.
- **Reload after fail:** Blob is lost (in-memory only). Bubble shows failed state + tooltip "Rispedisci manualmente" and tap-to-delete. No auto-retry.

## Edge cases

| Case | Behavior |
|---|---|
| User closes chat during upload | Upload continues in background. Bubble reappears on re-entry with current progress. |
| User deletes bubble during upload | `AbortController.abort()`, remove from `pendingFileSends`, no chatAPI call. |
| File > 50 MB | Primal rejects (limit). Fallback to satellite/band. If all reject → hard fail "File too large". |
| Empty file (0 bytes) | Reject in `sendFile` shortcut before upload, toast "File vuoto". |
| `pendingFileSends` growth | Evict entry on `sent`/`delivered`, or after 30s from `failed`. Cap at 20 (LRU). |
| AES-GCM decrypt fail on receiver | Bubble renders "File corrotto" placeholder, chat rendering unaffected. |
| Blossom URL 404 on receiver fetch | Cache miss, placeholder "File non disponibile, riprova più tardi". |
| Voice note without waveform | Receiver renders flat baseline, duration still shown. |
| Multi-device sender echo | Own published kind 15 comes back via self-subscription. `ChatAPI.handleRelayMessage` already dedups via `getByEventId`. Not a regression. |

## Voice note schema

Rumor kind 15 JSON content for voice notes:

```json
{
  "url": "https://blossom.primal.net/abc...",
  "sha256": "hex",
  "mimeType": "audio/ogg;codecs=opus",
  "size": 12345,
  "key": "hex64",
  "iv": "hex24",
  "duration": 3.7,
  "waveform": "base64-packed-bytes"
}
```

`duration` seconds (float). `waveform` is tweb's existing packed 5-bit per-sample encoding (100 samples), base64-wrapped. `extractFileMetadata` extends to parse both.

## Testing

**Unit (vitest):**
- `file-crypto.test.ts` — round-trip, key uniqueness per call, sha256 hashes ciphertext.
- `blossom-upload-progress.test.ts` — mock XHR, progress 0→100 events, fallback on 503, abort mid-upload, auth event tag shape.
- `nostra-send-file.test.ts` — 3-retry sequence, event dispatch order, `pendingFileSends` LRU, optimistic bubble injection.
- `nostra-file-fetch.test.ts` — cache hit, cache miss, 404, decrypt error.

**E2E (playwright, LocalRelay strfry):**
- `e2e-send-image.ts` — sender inject JPEG Blob → receiver bubble with decrypted image.
- `e2e-send-voice.ts` — sender inject Opus Blob (bypass `MediaRecorder`) → receiver bubble with waveform + duration.

Add both to `src/tests/e2e/run-all.sh`.

**Quality gates before commit:**
- `pnpm lint`
- `npx tsc --noEmit 2>&1 | grep "error TS" | wc -l` (must stay ~30 pre-existing).
- `pnpm test:nostra:quick` — must pass.
- E2E send-image + e2e-bidirectional (existing regression) before final commit.

## Rollout

Single merge to `main`. No feature flag — the shortcut branch in `sendFile` is gated on `peerId >= 1e15`, which is already the P2P discriminator used throughout the codebase. Telegram MTProto paths are untouched.

## Open items (out of scope, tracked for follow-up)

- Video send + compression + thumbnail extraction.
- Persistent offline queue for media (serialize Blob to IndexedDB, TTL Blossom auth events, multi-device echo on retry).
- Progress bar on receiver-side decrypt/download.
- Resumable uploads on failed state after reload.
- Waveform generation from recorded audio (currently relies on `recorder.min.js` output).
- Blossom server list configurability.
