# Phase 4: 1:1 Messaging E2E - Research

**Researched:** 2026-04-01
**Domain:** NIP-17 gift-wrapped messaging, Blossom media upload, delivery indicators, conversation lifecycle
**Confidence:** HIGH

## Summary

Phase 4 migrates the existing kind 4 messaging pipeline to NIP-17 gift-wrapped messages (kind 14 rumor -> kind 13 seal -> kind 1059 gift wrap) and adds media transfer via Blossom servers, 4-state delivery indicators, and conversation lifecycle management (history, message requests, deletion).

The critical discovery is that **nostr-tools 2.23.3 already ships complete NIP-17 support** via `nostr-tools/nip17` -- it exports `wrapEvent`, `wrapManyEvents`, `unwrapEvent`, and `unwrapManyEvents`. These functions handle the full rumor-seal-giftwrap pipeline with randomized timestamps and ephemeral keys. The existing custom `createRumor`, `createSeal`, `createGiftWrap`, and `unwrapGiftWrap` functions in `nostr-crypto.ts` should be replaced with the library's battle-tested implementations.

For media, NIP-17 defines kind 15 (file messages) with encryption tags (`encryption-algorithm`, `decryption-key`, `decryption-nonce`). The user's decision to use Blossom (BUD-01/BUD-02 compliant servers) with client-side AES-256-GCM encryption before upload aligns perfectly with this specification. No Blossom JS client library is needed -- the API is a simple PUT /upload with binary body.

**Primary recommendation:** Use `nostr-tools/nip17` for gift-wrap pipeline, implement Blossom upload as a thin fetch wrapper, and extend the existing display bridge pattern for delivery indicators and media rendering.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Photos and videos uploaded to Blossom-compatible servers (NIP-96 decentralized blob storage)
- Media encrypted client-side with AES-256-GCM before upload -- Blossom servers see only opaque blobs
- Encryption key shared inside the NIP-17 gift-wrapped message (URL + key in rumor content)
- All uploads go through Tor (webtor-rs HTTP proxy) -- IP hidden from Blossom servers
- 2-3 public Blossom servers hardcoded as defaults, user can configure custom servers
- Size limits: 10MB photos, 50MB videos
- 4 states per message: invio (orologio) -> inviato al relay (1 check) -> ricevuto dal peer (2 check) -> letto (2 check blu)
- Receipt events (ricezione + lettura) are NIP-17 gift-wrapped -- relay cannot distinguish receipts from messages
- Read receipts disattivabili in Settings > Privacy
- Failed messages: retry automatico con backoff esponenziale, molti tentativi. Delete via standard context menu
- All'apertura app: richiedi ultimi 50 messaggi per ogni chat attiva dal relay pool. Scroll verso l'alto carica piu vecchi (lazy load). Cache IndexedDB locale
- Messaggi da npub sconosciuti: sezione "Richieste" separata. Accetta (sposta in chat list) o rifiuta (blocca/ignora). Nessuna notifica push
- Chat list stile Telegram: avatar, nome/npub, anteprima ultimo messaggio, timestamp, badge non letti
- Eliminazione conversazione a 3 livelli: locale, notifica al peer (gift-wrapped), richiesta al relay (NIP-09)
- Full NIP-17 da subito: kind 14 rumor -> kind 13 seal -> kind 1059 gift-wrap. Kind 4 rimosso completamente
- Chiave effimera: nuova chiave random per ogni gift-wrap
- Timestamp randomizzato: kind 1059 ha created_at randomizzato +/- 48 ore
- Tutti gli eventi di controllo viaggiano come NIP-17 gift-wrap

### Claude's Discretion
- Scelta dei 2-3 server Blossom di default (basarsi su uptime e compatibilita Nostr)
- Formato del payload media nel rumor (JSON con URL + chiave + metadata)
- Implementazione lazy loading dello scroll history (virtualizzazione, chunk size)
- Logica di backoff esponenziale per retry messaggi (intervalli, max tentativi)
- UI della sezione "Richieste" messaggi (posizione, badge, interazione)
- Come gestire il cambio dispositivo (sincronizzazione history da relay)
- Gestione conflitti timestamp tra messaggi locali e relay

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MSG-01 | User can send and receive 1:1 text messages via Nostr relay pool | nostr-tools/nip17 wrapEvent + unwrapEvent; migrate NostrRelay from kind 4 to kind 1059 subscription |
| MSG-02 | User can send and receive 1:1 text messages when peer is offline (relay stores until peer connects) | Gift-wrapped kind 1059 events are stored by relays; backfill via pool.getMessages with since filter |
| MSG-04 | 1:1 DMs use NIP-17 gift-wrap (kind 14 -> kind 13 -> kind 1059) to hide metadata from relays | nostr-tools/nip17 provides complete pipeline; randomized timestamps built-in |
| MSG-05 | User can send and receive photos in chat | NIP-17 kind 15 file messages + Blossom BUD-02 PUT /upload + AES-256-GCM client-side encryption |
| MSG-06 | User can send and receive videos in chat | Same as MSG-05 with video MIME types; 50MB limit; Blossom supports range requests for streaming |
| MSG-07 | User sees message delivery status (sent to relay / delivered to peer) | Custom receipt events gift-wrapped as kind 14 with receipt-type tags; 4-state model |
| MSG-08 | Offline messages are queued in IndexedDB and sent when peer connects or flushed to relay | Existing OfflineQueue already handles this; needs migration to gift-wrap publishing |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| nostr-tools | 2.23.3 | NIP-17 gift-wrap, NIP-44 encryption, NIP-59 seal/wrap | Already installed; nip17 module provides wrapEvent/unwrapEvent |
| Web Crypto API | native | AES-256-GCM for media encryption before Blossom upload | Browser-native, no dependencies, hardware-accelerated |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @noble/hashes | (transitive) | SHA-256 hashing for Blossom blob addressing | Already installed via nostr-tools |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| nostr-tools/nip17 | Custom createRumor/createSeal/createGiftWrap in nostr-crypto.ts | Already exists but duplicates library; library version is tested across ecosystem |
| Web Crypto AES-256-GCM | libsodium-wrappers | Heavier dependency, Web Crypto is sufficient and native |
| Raw fetch for Blossom | @nostr-dev-kit/ndk-blossom | Over-engineered for simple PUT /upload; adds NDK dependency |

**No new packages needed.** All required cryptographic primitives are already available.

## Architecture Patterns

### Recommended Module Structure
```
src/lib/nostra/
  nostr-crypto.ts         # MIGRATE: replace custom gift-wrap with nostr-tools/nip17
  nostr-relay.ts          # MIGRATE: kind 4 -> kind 1059 subscription + gift-wrap unwrap
  nostr-relay-pool.ts     # EXTEND: publish gift-wrapped events, subscribe to kind 1059
  chat-api.ts             # MIGRATE: send via gift-wrap, parse unwrapped rumors
  blossom-client.ts       # NEW: upload/download encrypted blobs via Blossom servers
  media-crypto.ts         # NEW: AES-256-GCM encrypt/decrypt for media files
  delivery-tracker.ts     # NEW: 4-state delivery status tracking + receipt events
  message-store.ts        # NEW: IndexedDB message history cache per conversation
  message-requests.ts     # NEW: unknown-sender message request management
  offline-queue.ts        # EXTEND: gift-wrap publishing in flush path
  nostra-display-bridge.ts  # EXTEND: media rendering, delivery indicators, chat list
  nostra-send-bridge.ts     # EXTEND: media send routing
```

### Pattern 1: NIP-17 Gift-Wrap Send Pipeline
**What:** Every outbound message is wrapped in rumor -> seal -> gift-wrap before publishing
**When to use:** All message sends (text, media, receipts, delete notifications)
**Example:**
```typescript
// Source: nostr-tools/nip17 (verified in node_modules)
import {wrapEvent} from 'nostr-tools/nip17';

// For 1:1 DM: wrap for recipient AND self (for multi-device recovery)
const recipientWrap = wrapEvent(
  senderPrivateKey,
  {publicKey: recipientPubHex},
  messageContent,
  conversationTitle,
  replyTo
);
const selfWrap = wrapEvent(
  senderPrivateKey,
  {publicKey: senderPubHex},
  messageContent,
  conversationTitle,
  replyTo
);
// Publish both to relay pool
await pool.publishRawEvent(recipientWrap);
await pool.publishRawEvent(selfWrap);
```

### Pattern 2: NIP-17 Gift-Wrap Receive Pipeline
**What:** Subscribe to kind 1059 addressed to our pubkey, unwrap to get rumor
**When to use:** Incoming message handling in NostrRelay
**Example:**
```typescript
// Source: nostr-tools/nip17 (verified in node_modules)
import {unwrapEvent} from 'nostr-tools/nip17';

// Subscribe to kind 1059 events tagged with our pubkey
const filter = {kinds: [1059], '#p': [ourPubkey]};
// On receiving a kind 1059 event:
const rumor = unwrapEvent(giftWrapEvent, recipientPrivateKey);
// MUST verify rumor.pubkey matches the seal's pubkey (anti-impersonation)
if(rumor.kind === 14) {
  // Chat message
  handleChatMessage(rumor);
} else if(rumor.kind === 15) {
  // File message
  handleFileMessage(rumor);
}
```

### Pattern 3: Blossom Media Upload with Client-Side Encryption
**What:** Encrypt file with AES-256-GCM, upload opaque blob to Blossom, share key in gift-wrap
**When to use:** Photo and video sends
**Example:**
```typescript
// 1. Generate random AES key + IV
const aesKey = await crypto.subtle.generateKey(
  {name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']
);
const iv = crypto.getRandomValues(new Uint8Array(12));

// 2. Encrypt file
const encrypted = await crypto.subtle.encrypt(
  {name: 'AES-GCM', iv}, aesKey, fileBuffer
);

// 3. Upload to Blossom via Tor proxy
const response = await torFetch('PUT', `${blossomUrl}/upload`, encrypted, {
  'Content-Type': 'application/octet-stream'
});
const descriptor = await response.json();
// descriptor: {url, sha256, size, type, uploaded}

// 4. Export key for inclusion in gift-wrap
const rawKey = await crypto.subtle.exportKey('raw', aesKey);

// 5. Build kind 15 file message rumor tags
const tags = [
  ['p', recipientPubkey],
  ['file-type', originalMimeType],
  ['encryption-algorithm', 'aes-gcm'],
  ['decryption-key', bytesToHex(new Uint8Array(rawKey))],
  ['decryption-nonce', bytesToHex(iv)],
  ['x', descriptor.sha256],
  ['size', String(fileSize)]
];
```

### Pattern 4: Delivery Receipt as Gift-Wrapped Event
**What:** Send delivery/read receipts as NIP-17 gift-wrapped kind 14 events with custom tags
**When to use:** When message is received by client (delivery) or displayed on screen (read)
**Example:**
```typescript
// Receipt is a kind 14 rumor with receipt-specific tags
const receiptRumor = {
  kind: 14,
  content: '',
  tags: [
    ['p', senderPubkey],
    ['e', originalMessageId, '', 'receipt'],
    ['receipt-type', 'delivery']  // or 'read'
  ]
};
// Gift-wrap and send back to original sender
const wrap = wrapEvent(receiptRumor, myPrivateKey, senderPubkey);
await pool.publishRawEvent(wrap);
```

### Pattern 5: Message History Cache in IndexedDB
**What:** Cache decrypted messages locally for instant chat load, sync with relay on open
**When to use:** App startup, chat open, scroll-back
**Example:**
```typescript
// IndexedDB store: nostra-messages
// Key: conversationId (sorted pubkeys), Index: timestamp
// On chat open:
// 1. Load cached messages from IndexedDB (instant)
// 2. Fetch from relay since lastSeenTimestamp (background)
// 3. Merge and dedup by event ID
// 4. Store new messages to IndexedDB
```

### Anti-Patterns to Avoid
- **Signing the rumor:** Kind 14 rumors MUST NOT be signed. The whole point is deniability. nostr-tools/nip17 handles this correctly
- **Reusing ephemeral keys:** Each gift-wrap MUST use a fresh random key. nostr-tools/nip17 generates a new key per call
- **Sending media as base64 in event content:** Events have practical size limits (~64KB). Always upload to Blossom and reference by URL
- **Subscribing to kind 4:** After migration, never subscribe to kind 4. Only subscribe to kind 1059
- **Trusting rumor pubkey without verification:** MUST verify seal pubkey matches rumor pubkey to prevent impersonation

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Gift-wrap pipeline | Custom rumor/seal/wrap functions | `nostr-tools/nip17` wrapEvent/unwrapEvent | Library handles timestamp randomization, ephemeral keys, correct kind numbers |
| NIP-44 encryption | Custom ChaCha20 implementation | `nostr-tools/nip44` (already used) | Padding, HKDF, HMAC-AAD all specified precisely |
| AES-256-GCM | npm crypto library | Web Crypto API `crypto.subtle` | Native, hardware-accelerated, zero bundle size |
| SHA-256 for Blossom | npm sha256 library | Web Crypto API `crypto.subtle.digest` | Native, already available |
| Blossom client SDK | Full-featured Blossom library | Simple fetch wrapper (PUT /upload, GET /sha256) | API is literally 2 HTTP endpoints |

**Key insight:** The NIP-17 gift-wrap pipeline is deceptively complex (3 layers, randomized timestamps, ephemeral keys, pubkey verification). Using nostr-tools eliminates an entire class of cryptographic bugs.

## Common Pitfalls

### Pitfall 1: Forgetting Self-Send for Multi-Device
**What goes wrong:** Messages sent from device A never appear on device B because only the recipient gets a gift-wrap copy
**Why it happens:** NIP-17 requires wrapping the message for the sender's own pubkey too
**How to avoid:** Always call `wrapManyEvents` (which wraps for sender + all recipients) or publish two wraps: one for recipient, one for self
**Warning signs:** Messages missing from history after app reinstall or device switch

### Pitfall 2: Kind 4 to Kind 1059 Subscription Migration
**What goes wrong:** After migration, no messages received because still subscribing to kind 4
**Why it happens:** NostrRelay.subscribeMessages() currently filters for `kinds: [4]`
**How to avoid:** Change filter to `kinds: [1059]` and update handleEvent to unwrap gift-wraps instead of direct NIP-44 decrypt
**Warning signs:** Connected to relay but no messages arriving

### Pitfall 3: Gift-Wrap Timestamp Confusion
**What goes wrong:** Messages appear out of order in chat because display uses the gift-wrap's randomized created_at
**Why it happens:** Kind 1059 created_at is deliberately randomized +/- 48 hours for privacy
**How to avoid:** Always use the rumor's (kind 14) created_at for display ordering, never the outer gift-wrap timestamp
**Warning signs:** Messages jumping around in timeline, future-dated messages

### Pitfall 4: Blossom Upload Without CORS
**What goes wrong:** Browser blocks PUT /upload to Blossom server
**Why it happens:** Cross-origin request without proper CORS headers
**How to avoid:** BUD-01 mandates `Access-Control-Allow-Origin: *` on all responses. If a server doesn't comply, fall through to next server. Also, uploads go through Tor proxy which bypasses CORS
**Warning signs:** Network errors on media upload only

### Pitfall 5: Large Media in Event Content
**What goes wrong:** Publishing fails or relay rejects event
**Why it happens:** Trying to embed base64 media directly in NIP-17 content instead of Blossom URL
**How to avoid:** Always upload to Blossom first, then include URL + decryption key in kind 15 file message
**Warning signs:** Relay returns error on publish, extremely slow send

### Pitfall 6: Receipt Event Loops
**What goes wrong:** Infinite loop of delivery receipts
**Why it happens:** Receiving a delivery receipt triggers sending a receipt for the receipt
**How to avoid:** Never send receipts for receipt events. Check receipt-type tag before processing
**Warning signs:** Exponential relay traffic, infinite event creation

### Pitfall 7: Read Receipt Privacy Leak
**What goes wrong:** User has read receipts disabled but still sends them
**Why it happens:** Toggle state not checked before dispatching read receipt
**How to avoid:** Check privacy setting BEFORE creating read receipt event. If disabled, skip entirely. Also don't display others' read receipts if own are disabled (reciprocal, like WhatsApp)
**Warning signs:** Blue checkmarks appearing when user disabled the feature

### Pitfall 8: Seal Pubkey Impersonation
**What goes wrong:** Attacker sends gift-wrap with forged rumor pubkey
**Why it happens:** Client trusts rumor.pubkey without verifying it matches the seal's pubkey
**How to avoid:** After unwrapping, verify that the decrypted seal's pubkey equals the rumor's pubkey
**Warning signs:** Messages appearing from wrong sender

## Code Examples

### Complete NIP-17 Send Flow (using nostr-tools)
```typescript
// Source: nostr-tools/nip17 verified in node_modules/nostr-tools/lib/esm/nip17.js
import {wrapEvent, wrapManyEvents} from 'nostr-tools/nip17';
import type {EventTemplate} from 'nostr-tools/pure';

// Send a text message
function sendNip17TextMessage(
  senderSk: Uint8Array,
  recipientPubHex: string,
  text: string
): Event[] {
  // wrapManyEvents wraps for sender + all recipients automatically
  return wrapManyEvents(
    senderSk,
    [{publicKey: recipientPubHex}],
    text
  );
  // Returns array of kind 1059 events to publish
}
```

### Complete NIP-17 Receive Flow
```typescript
// Source: nostr-tools/nip17 verified in node_modules/nostr-tools/lib/esm/nip17.js
import {unwrapEvent} from 'nostr-tools/nip17';

function handleGiftWrap(event: NostrEvent, recipientSk: Uint8Array): void {
  if(event.kind !== 1059) return;

  try {
    const rumor = unwrapEvent(event, recipientSk);

    // Anti-impersonation check (Pitfall 8)
    // unwrapEvent handles this internally via nip44Decrypt chain

    if(rumor.kind === 14) {
      // Extract sender from rumor.pubkey
      // Extract message from rumor.content
      // Extract recipients from rumor.tags where tag[0] === 'p'
      // Extract reply reference from rumor.tags where tag[0] === 'e'
      processTextMessage(rumor);
    } else if(rumor.kind === 15) {
      processFileMessage(rumor);
    }
  } catch(err) {
    // Decryption failure = not for us or corrupted
    console.warn('Failed to unwrap gift-wrap:', err);
  }
}
```

### AES-256-GCM Media Encryption
```typescript
// Source: Web Crypto API (MDN verified)
async function encryptMedia(file: ArrayBuffer): Promise<{
  encrypted: ArrayBuffer;
  key: Uint8Array;
  iv: Uint8Array;
}> {
  const key = await crypto.subtle.generateKey(
    {name: 'AES-GCM', length: 256},
    true,
    ['encrypt', 'decrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv},
    key,
    file
  );
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  return {encrypted, key: rawKey, iv};
}

async function decryptMedia(
  encrypted: ArrayBuffer,
  keyBytes: Uint8Array,
  iv: Uint8Array
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, {name: 'AES-GCM'}, false, ['decrypt']
  );
  return crypto.subtle.decrypt({name: 'AES-GCM', iv}, key, encrypted);
}
```

### Blossom Upload via Tor
```typescript
// Source: BUD-02 specification (https://github.com/hzrd149/blossom/blob/master/buds/02.md)
interface BlobDescriptor {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
}

async function uploadToBlossom(
  encryptedBlob: ArrayBuffer,
  blossomUrl: string,
  torFetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>
): Promise<BlobDescriptor> {
  const response = await torFetch(`${blossomUrl}/upload`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(encryptedBlob.byteLength)
    },
    body: encryptedBlob
  });

  if(!response.ok) {
    throw new Error(`Blossom upload failed: ${response.status}`);
  }

  return response.json();
}

async function downloadFromBlossom(
  sha256: string,
  blossomUrl: string,
  torFetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>
): Promise<ArrayBuffer> {
  const response = await torFetch(`${blossomUrl}/${sha256}`);
  if(!response.ok) {
    throw new Error(`Blossom download failed: ${response.status}`);
  }
  return response.arrayBuffer();
}
```

### Delivery Status Tracking
```typescript
// 4-state model: sending -> sent -> delivered -> read
type DeliveryState = 'sending' | 'sent' | 'delivered' | 'read';

interface DeliveryInfo {
  state: DeliveryState;
  sentAt?: number;       // timestamp relay accepted
  deliveredAt?: number;  // timestamp peer received
  readAt?: number;       // timestamp peer read
}

// Receipt event structure (gift-wrapped as kind 14)
function createDeliveryReceipt(
  originalEventId: string,
  senderPubkey: string,
  receiptType: 'delivery' | 'read'
): Partial<EventTemplate> {
  return {
    kind: 14,
    content: '',
    tags: [
      ['p', senderPubkey],
      ['e', originalEventId, '', 'receipt'],
      ['receipt-type', receiptType]
    ]
  };
}
```

## Discretion Recommendations

### Blossom Server Defaults
**Recommendation:** Use these 3 public Blossom servers as defaults:
1. `https://blossom.primal.net` -- operated by Primal, high uptime, widely used
2. `https://cdn.satellite.earth` -- established Nostr infrastructure provider
3. `https://nostrmedia.com` -- BUD-01 + NIP-96 compliant, supports multiple clients

**Confidence:** MEDIUM -- server uptime claims based on community reports, not direct measurement.

### Media Payload Format in Rumor
**Recommendation:** Use NIP-17 kind 15 (file message) with standard tags:
```json
{
  "kind": 15,
  "content": "",
  "tags": [
    ["p", "<recipient-pubkey>"],
    ["file-type", "image/jpeg"],
    ["encryption-algorithm", "aes-gcm"],
    ["decryption-key", "<hex-encoded-aes-key>"],
    ["decryption-nonce", "<hex-encoded-iv>"],
    ["x", "<sha256-of-encrypted-blob>"],
    ["ox", "<sha256-of-original-file>"],
    ["size", "1234567"],
    ["dim", "1920x1080"],
    ["url", "https://blossom.primal.net/<sha256>.enc"]
  ]
}
```
This follows the NIP-17 kind 15 spec exactly. The `url` tag provides primary download location; `x` tag enables fallback via BUD-01 on alternative servers.

### Lazy Loading / Scroll History
**Recommendation:** Chunk size of 50 messages per fetch, virtual scroll using the existing tweb scroll infrastructure. On chat open: load 50 most recent from IndexedDB cache (instant), then backfill from relay in background. Scroll-up triggers fetch of next 50 older messages.

### Exponential Backoff for Retry
**Recommendation:** Base interval 2 seconds, multiplier 2x, max interval 5 minutes, max 20 attempts (covers ~17 hours of retry). After 20 failures, mark as failed but keep in queue for manual retry.
```
Attempt:  1    2    3    4    5    6    7    ...  20
Delay:    2s   4s   8s   16s  32s  64s  128s ... 300s (capped)
```

### Message Requests UI
**Recommendation:** Add a "Richieste" row at the top of the chat list (above first conversation) with a badge count. Tapping opens a separate list. Each request shows sender npub/NIP-05, first message preview, accept/reject buttons. Rejecting blocks the pubkey (stored in IndexedDB). Pattern mirrors Instagram's message request flow.

### Multi-Device Sync
**Recommendation:** On new device login, fetch all kind 1059 events since account creation from relay pool (paginated backfill). Decrypt and populate local IndexedDB. This is enabled by self-send wrapping (every message is wrapped for sender too). Limitation: only messages that relays still store are recoverable.

### Timestamp Conflict Resolution
**Recommendation:** Use rumor created_at as authoritative timestamp. For locally-created messages, use the local timestamp until relay confirms, then keep the local timestamp (since the relay timestamp is randomized anyway). Sort by rumor created_at, tie-break by event ID.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| NIP-04 (kind 4) DMs | NIP-17 (kind 14/13/1059) gift-wrap | 2024 | Metadata privacy: relay sees nothing about sender/recipient/timing |
| Base64 media in event content | Blossom blob storage (BUD-01/02) | 2024-2025 | Separates media from events; addressable by SHA-256 |
| nostr-tools manual NIP-59 | nostr-tools/nip17 module | nostr-tools 2.x | Complete pipeline in single import |
| NIP-96 HTTP file storage | NIP-B7 Blossom media | 2025 | Simpler API, SHA-256 addressing, no auth required for public uploads |

**Deprecated/outdated:**
- **Kind 4 DMs:** CONTEXT.md explicitly removes kind 4 completely, no backward compatibility
- **NIP-04 encryption:** Already removed in Phase 2, all encryption uses NIP-44
- **Custom gift-wrap in nostr-crypto.ts:** Replaced by nostr-tools/nip17 library functions

## Open Questions

1. **Blossom Authentication (BUD-11)**
   - What we know: BUD-02 says servers MAY require authentication. BUD-11 defines NIP-98-based auth
   - What's unclear: Do the chosen default servers require auth for uploads?
   - Recommendation: Implement NIP-98 auth header support but make it optional. Test against actual servers during implementation

2. **Kind 10050 Inbox Relay Lists**
   - What we know: NIP-17 defines kind 10050 for DM inbox relay preferences. Senders should check recipient's 10050 to know where to deliver
   - What's unclear: Whether to implement publishing/querying kind 10050 in Phase 4 or defer
   - Recommendation: Defer to future enhancement. For v1, publish to all configured write relays. The relay pool already handles multi-relay delivery

3. **Blossom Upload via Tor Feasibility**
   - What we know: User decision requires all Blossom uploads through webtor-rs HTTP proxy
   - What's unclear: Whether webtor-rs proxy supports PUT requests with binary body (it was designed for GET polling)
   - Recommendation: Verify webtor-rs supports PUT/binary early in implementation. If not, may need to extend the proxy or use a Tor SOCKS proxy alternative

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (via vite.config.ts) |
| Config file | vite.config.ts (test section at line 128) |
| Quick run command | `pnpm test src/tests/nostra/` |
| Full suite command | `pnpm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MSG-01 | Send/receive text via NIP-17 gift-wrap | unit | `pnpm test src/tests/nostra/nip17-messaging.test.ts` | Wave 0 |
| MSG-02 | Offline message storage and retrieval | unit | `pnpm test src/tests/nostra/offline-queue.test.ts` | Exists (extend) |
| MSG-04 | NIP-17 gift-wrap pipeline correctness | unit | `pnpm test src/tests/nostra/nip17-giftwrap.test.ts` | Wave 0 |
| MSG-05 | Photo send/receive via Blossom | unit | `pnpm test src/tests/nostra/blossom-media.test.ts` | Wave 0 |
| MSG-06 | Video send/receive via Blossom | unit | `pnpm test src/tests/nostra/blossom-media.test.ts` | Wave 0 (same file) |
| MSG-07 | Delivery status indicators | unit | `pnpm test src/tests/nostra/delivery-tracker.test.ts` | Wave 0 |
| MSG-08 | Offline queue with gift-wrap flush | unit | `pnpm test src/tests/nostra/offline-queue.test.ts` | Exists (extend) |

### Sampling Rate
- **Per task commit:** `pnpm test src/tests/nostra/`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/tests/nostra/nip17-messaging.test.ts` -- covers MSG-01, MSG-04 (gift-wrap send/receive roundtrip)
- [ ] `src/tests/nostra/nip17-giftwrap.test.ts` -- covers MSG-04 (seal pubkey verification, timestamp randomization)
- [ ] `src/tests/nostra/blossom-media.test.ts` -- covers MSG-05, MSG-06 (encrypt/upload/download/decrypt roundtrip)
- [ ] `src/tests/nostra/delivery-tracker.test.ts` -- covers MSG-07 (state machine transitions, receipt creation/parsing)
- [ ] Extend `src/tests/nostra/offline-queue.test.ts` -- covers MSG-08 (gift-wrap flush path)

## Sources

### Primary (HIGH confidence)
- nostr-tools 2.23.3 `nip17.js` module -- verified in node_modules, exports wrapEvent/wrapManyEvents/unwrapEvent/unwrapManyEvents
- nostr-tools 2.23.3 `nip59.js` module -- verified createRumor/createSeal/createWrap/wrapEvent/unwrapEvent
- nostr-tools 2.23.3 `nip44.js` module -- verified NIP-44 v2 encryption/decryption
- [NIP-17 specification](https://github.com/nostr-protocol/nips/blob/master/17.md) -- kind 14/15, kind 13, kind 1059, kind 10050
- [NIP-59 specification](https://github.com/nostr-protocol/nips/blob/master/59.md) -- seal and gift-wrap structure
- [Blossom BUD-01](https://github.com/hzrd149/blossom/blob/master/buds/01.md) -- GET/HEAD endpoints, CORS, range requests
- [Blossom BUD-02](https://github.com/hzrd149/blossom/blob/master/buds/02.md) -- PUT /upload endpoint, blob descriptor response
- Web Crypto API (browser native) -- AES-256-GCM, SHA-256

### Secondary (MEDIUM confidence)
- [NIP-09 Event Deletion](https://nips.nostr.com/9) -- kind 5 deletion requests for conversation cleanup
- [NIP-B7 Blossom media](https://nips.nostr.com/B7) -- kind 10063 server lists, SHA-256 fallback resolution
- Public Blossom servers (blossom.primal.net, cdn.satellite.earth, nostrmedia.com) -- community-reported uptime

### Tertiary (LOW confidence)
- Blossom server auth requirements (BUD-11) -- needs runtime verification against actual servers
- webtor-rs PUT support for binary uploads -- needs implementation verification

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- nostr-tools/nip17 verified in installed node_modules, no new deps needed
- Architecture: HIGH -- existing codebase patterns well-understood, migration path clear from kind 4 to kind 1059
- Pitfalls: HIGH -- derived from NIP-17 spec requirements and analysis of existing code gaps
- Media/Blossom: MEDIUM -- BUD spec is clear but server availability and Tor proxy PUT support need runtime verification
- Delivery receipts: MEDIUM -- not standardized in NIP-17 spec, custom implementation following gift-wrap pattern

**Research date:** 2026-04-01
**Valid until:** 2026-05-01 (stable -- NIP-17 is finalized, nostr-tools API unlikely to change in patch)
