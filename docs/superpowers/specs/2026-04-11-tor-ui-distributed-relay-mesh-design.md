# Tor UI + Distributed Relay + P2P Mesh — Design Spec

**Date:** 2026-04-11
**Status:** Draft
**Scope:** Three interconnected features — improved Tor UI, in-browser mini-relay, P2P mesh between contacts

## 1. Overview

Nostra.chat already has a working Tor WASM integration (webtor-rs v0.5.7) and relay pool infrastructure. This spec adds three layers:

1. **Tor UI** — user-facing controls for Tor (toggle, circuit dashboard, latency indicators)
2. **Mini-Relay** — in-browser NIP-01 relay with IndexedDB storage, evolving from `message-store.ts`
3. **P2P Mesh** — WebRTC DataChannel connections between contacts, tunneled through Tor, with store-and-forward capability

All network traffic is routed through Tor. No IP is ever exposed.

## 2. Architecture

```
Browser (PWA)
┌──────────────────────────────────────────────────┐
│  UI (Solid.js)           Mini-Relay (Web Worker) │
│  ┌──────────────────┐    ┌─────────────────────┐ │
│  │ Tor Toggle       │    │ NIP-01 Handler      │ │
│  │ Circuit Dashboard│    │ IndexedDB Storage   │ │
│  │ Latency Meter    │    │ Store-Forward Queue │ │
│  └────────┬─────────┘    └──────┬──────────────┘ │
│           │                     │                 │
│  ┌────────┴─────────────────────┴──────────────┐ │
│  │           Tor WASM (webtor-rs)               │ │
│  └──────────┬───────────────────┬──────────────┘ │
└─────────────┼───────────────────┼────────────────┘
              │                   │
     WebRTC DataChannel     Relay Nostr Esterno
     (mesh contatti)        (signaling + fallback)
              │                   │
         ─── Tor Network (3 hop) ───
```

### Message delivery pipeline (3 levels)

```
Alice sends to Bob
    │
    ▼
1. P2P DIRECT — Bob online in mesh?
   YES → WebRTC via Tor → delivered (~1-2s)
    │ NO
    ▼
2. STORE-FORWARD — mutual contact (Carlo) online?
   YES → Carlo holds msg → delivers when Bob reconnects
    │ NO
    ▼
3. RELAY FALLBACK — external Nostr relay (via Tor)
   Always available → Bob fetches on next connect
```

## 3. Area 1: Tor UI

### 3.1 Current state

Existing components:
- `torShield.tsx` — color-coded shield icon (bootstrapping/active/direct/failed)
- `torBanner.tsx` — full-width status banner
- `torStatus.tsx` — popup with Tor + relay states
- `torFallbackConfirm.tsx` — fallback confirmation modal
- `SearchBarStatusIcons.tsx` — inline indicators in search bar
- `nostraRelaySettings.ts` — relay CRUD, status dots, latency
- `privacyAndSecurity.ts` — read receipts toggle, key protection

Event: `nostra_tor_state` dispatched by `privacy-transport.ts`, listened by all Tor UI components.

### 3.2 New: Tor toggle in settings

**Location:** `privacyAndSecurity.ts`, new section at the top.

**Behavior:**
- Toggle switch: "Route traffic through Tor"
- Default: ON
- Turning OFF triggers `torFallbackConfirm.tsx` confirmation (reuse existing component)
- State persisted in localStorage (`nostra-tor-enabled`)
- Calls `privacyTransport.setTorEnabled(bool)` which starts bootstrap or switches to direct mode

**States:**
- ON + bootstrapping → toggle ON, spinner, "Connecting to Tor..."
- ON + active → toggle ON, green, "Connected via Tor"
- ON + failed → toggle ON, red, "Tor connection failed" + retry button
- OFF → toggle OFF, orange warning, "Direct connection — your IP is visible to relays"

### 3.3 New: Circuit dashboard

**Location:** New tab `AppNostraTorDashboardTab` in sidebar left, accessible from `torStatus.tsx` popup ("View details" link).

**Displays:**
- **Circuit status:** active/building/failed
- **Hop visualization:** 3 nodes representing the circuit path
  - Guard node → Middle node → Exit node
  - Each shows: node fingerprint (truncated), latency contribution
  - Country flags shown only if webtor-rs exposes GeoIP data (otherwise omit — don't add a GeoIP dependency)
- **Exit IP:** the IP that relays see (fetched via Tor `fetch('https://api.ipify.org')` once on circuit ready)
- **Circuit age:** time since circuit was built
- **Rebuild button:** force new circuit (`torClient.newCircuit()`)

**Data source:** `WebtorClient` exposes circuit status via `TorClient.getCircuitStatus()` from webtor-rs. Extend `webtor-fallback.ts` to poll and cache circuit details.

**New event:** `nostra_tor_circuit_update` with `{guard, middle, exit, latency, exitIp}` — dispatched by `webtor-fallback.ts` on circuit change.

### 3.4 New: Latency indicators

**Location:** Integrated into existing `nostraRelaySettings.ts` relay list.

**Per-relay display:**
- Current latency (already exists as colored dot)
- **New:** Tor overhead indicator — shows `directLatency` vs `torLatency` delta
  - Format: "145ms (Tor +120ms)" in the relay row
  - Color: green if overhead <200ms, yellow if <500ms, red if >500ms
- **New:** Aggregate bar at top of relay settings
  - "Average Tor overhead: +135ms across 4 relays"

**Measurement:** Extend `NostrRelay.measureLatency()` to track both direct and Tor ping times. Store in relay state.

## 4. Area 2: Mini-Relay (TypeScript)

### 4.1 Purpose

An in-browser Nostr relay running in a Web Worker. Handles NIP-01 protocol over WebRTC DataChannel connections from contacts. Uses IndexedDB for storage (evolving `message-store.ts`). Supports store-and-forward for offline contacts.

### 4.2 Scope — NIPs implemented

| NIP | Purpose | Priority |
|-----|---------|----------|
| NIP-01 | Basic protocol (REQ, EVENT, OK, CLOSE, EOSE) | Required |
| NIP-17 | Gift-wrapped DMs (kind 1059) | Required |
| NIP-09 | Event deletion | Nice-to-have |

No other NIPs. The relay is purpose-built for encrypted DMs between contacts.

### 4.3 Storage layer

Evolve `message-store.ts` into `relay-store.ts`:

**Current `message-store.ts` schema:**
- DB: `nostra-messages` v1
- Store: `messages` (auto-increment)
- Indexes: `conversationId`, `timestamp`, `eventId` (unique)

**New `relay-store.ts` schema:**
- DB: `nostra-relay` v1
- Store: `events` (keyPath: `id`)
  - `id` (string) — Nostr event ID (sha256)
  - `pubkey` (string) — author pubkey
  - `kind` (number) — event kind (1059 for gift-wrap)
  - `created_at` (number) — unix timestamp
  - `content` (string) — encrypted content
  - `tags` (array) — Nostr tags
  - `sig` (string) — signature
- Indexes:
  - `kind` — filter by event kind
  - `pubkey` — filter by author
  - `created_at` — time-range queries
  - `kind_created_at` (compound) — efficient NIP-01 filter queries
- Store: `forward_queue` (auto-increment)
  - `targetPubkey` (string) — intended recipient
  - `eventId` (string) — reference to event in `events` store
  - `storedAt` (number) — when we received it for forwarding
  - `attempts` (number) — delivery attempts
  - `lastAttempt` (number) — last attempt timestamp
- Index: `targetPubkey` — lookup pending deliveries per contact

**Retention policy:**
- Own messages: kept indefinitely (user's data)
- Forwarded messages: 72 hours max, then pruned
- Garbage collection runs every hour via `setInterval` in the Worker

**Relationship to `message-store.ts`:**
- `message-store.ts` continues to exist for the app's internal message storage (tweb format)
- `relay-store.ts` is a separate DB storing raw Nostr events in standard format
- The mini-relay writes to `relay-store.ts`; `NostraSync` reads from `message-store.ts`
- When a message arrives via the mini-relay, it flows: `relay-store` → NIP-17 decrypt → `message-store` → tweb pipeline

### 4.4 NIP-01 protocol handler

**File:** `src/lib/nostra/mini-relay.ts`

```typescript
interface MiniRelay {
  // Handle incoming NIP-01 messages from a WebRTC peer
  handleMessage(peerId: string, msg: string): void;

  // Send response to a specific peer
  onSend: (peerId: string, msg: string) => void;

  // Lifecycle
  start(): Promise<void>;
  stop(): void;
}
```

**Protocol handling:**

- `["REQ", subId, ...filters]` → query `relay-store.ts` with filters → send matching `EVENT`s → send `EOSE`
- `["EVENT", event]` → validate signature → save to `relay-store.ts` → send `OK` → check `forward_queue` matches → trigger delivery pipeline
- `["CLOSE", subId]` → remove subscription

**Subscription management:**
- Track active subscriptions per peer: `Map<peerId, Map<subId, Filter[]>>`
- On new event saved, check all active subscriptions and push matching events
- Max 20 subscriptions per peer, max 100 total

**Validation:**
- Verify event signature (secp256k1)
- Check event kind is allowed (1059 only for now)
- Reject events older than 72 hours
- Reject events larger than 64KB
- Rate limit: max 10 events/second per peer

### 4.5 Store-and-forward

When Alice sends a gift-wrap event for Bob, and Bob is offline:

1. Alice's mini-relay sends the event to Carlo (mutual contact, online)
2. Carlo's mini-relay saves it to `relay-store.ts` + adds entry to `forward_queue` with `targetPubkey = Bob`
3. When Bob connects to Carlo's mesh node, Carlo's relay checks `forward_queue` for Bob
4. Carlo sends all queued events to Bob's relay
5. On successful delivery (OK response), Carlo removes from `forward_queue`

**How Carlo knows it's for Bob:**
- Gift-wrap events (kind 1059) have a `p` tag with the recipient pubkey
- Carlo's relay checks: is this `p` tag in my contact list? If yes, queue for forwarding
- Carlo cannot read the content (gift-wrap encrypted) but knows the recipient from the `p` tag

**Forward decision logic:**
```
Event received with p-tag = recipientPubkey
  → Is recipientPubkey in my contacts? NO → ignore (don't forward for strangers)
  → Is recipientPubkey connected to me right now? YES → forward immediately
  → NO → save to forward_queue, deliver when they connect
```

### 4.6 Web Worker integration

The mini-relay runs in a dedicated Web Worker (`mini-relay.worker.ts`):

- Owns the `relay-store.ts` IndexedDB connection
- Receives WebRTC messages via `MessagePort` from main thread
- Communicates with main thread via structured clone messages
- No DOM access needed

**Messages (main ↔ worker):**
- `{type: 'peer-message', peerId, data}` — incoming NIP-01 message from WebRTC
- `{type: 'peer-connected', peerId}` — new peer connected, check forward_queue
- `{type: 'peer-disconnected', peerId}` — cleanup subscriptions
- `{type: 'send', peerId, data}` — outgoing message to WebRTC peer
- `{type: 'stats'}` / `{type: 'stats-response', ...}` — relay statistics for UI

## 5. Area 3: P2P Mesh

### 5.1 Overview

Contacts form a mesh network using WebRTC DataChannel connections tunneled through Tor. The mesh enables direct messaging and store-and-forward without external relay dependency.

### 5.2 Signaling via Nostr relays

WebRTC requires SDP offer/answer exchange. We use existing Nostr relays (via Tor) as the signaling channel.

**Signaling protocol:**
- Use NIP-17 gift-wrap for signaling messages (reuse existing encryption)
- Custom `kind` inside the gift-wrap rumor for signaling: `kind: 29001` (application-specific)
- Content JSON:
  ```json
  {
    "type": "webrtc-signal",
    "action": "offer" | "answer" | "ice-candidate",
    "sdp": "...",
    "sessionId": "random-uuid"
  }
  ```
- Signaling messages are ephemeral — relay doesn't need to store them long

**Flow:**
1. Alice opens app → subscribes to kind 1059 on Nostr relays (existing behavior)
2. Alice wants to connect to Bob → creates WebRTC offer → wraps in gift-wrap → publishes to relay
3. Bob receives gift-wrap → decrypts → sees `kind: 29001` webrtc-signal → creates answer → publishes
4. ICE candidates exchanged the same way
5. WebRTC DataChannel established (through Tor TURN/STUN equivalent)

### 5.3 WebRTC through Tor

**Challenge:** Standard WebRTC uses STUN/TURN servers which expose IPs.

**Solution:** Route WebRTC through Tor:
- Disable ICE candidate gathering for host/srflx candidates (these leak local/public IP)
- Use only relay candidates via a TURN server with TURNS (TURN over TLS on port 443)
- TURNS uses TCP/TLS which Tor can proxy (unlike plain TURN which uses UDP, incompatible with Tor)
- The TURN server sees the Tor exit IP, not the real IP
- Both peers connect to TURN via Tor → data flows: Alice → Tor → TURNS → Tor → Bob

**TURN server options:**
- Self-hosted coturn with TURNS enabled on 443 (recommended for control)
- Public TURNS servers (less privacy but functional)
- Tor hidden service TURN (.onion) — maximum privacy, deploy later

**Important:** Standard TURN (UDP) does not work through Tor. TURNS (TCP/TLS on 443) is required. The `urls` config must use `turns:` protocol prefix.

**Configuration:** `src/lib/nostra/webrtc-config.ts`
```typescript
const rtcConfig: RTCConfiguration = {
  iceServers: [{
    urls: 'turns:turn.nostra.chat:443',
    username: 'nostra',
    credential: 'anonymous'
  }],
  iceTransportPolicy: 'relay' // ONLY relay candidates, no direct IP leak
};
```

Setting `iceTransportPolicy: 'relay'` ensures WebRTC never exposes the real IP. All traffic goes through the TURN server, which we access via Tor.

### 5.4 Mesh manager

**File:** `src/lib/nostra/mesh-manager.ts`

Manages WebRTC connections to contacts.

```typescript
interface MeshManager {
  // Connect to a contact's mesh node
  connect(pubkey: string): Promise<void>;

  // Disconnect from a contact
  disconnect(pubkey: string): void;

  // Send NIP-01 message to a peer's mini-relay
  send(pubkey: string, message: string): void;

  // Get connection status
  getStatus(pubkey: string): 'connected' | 'connecting' | 'disconnected';

  // Get all connected peers
  getConnectedPeers(): string[];

  // Events
  onPeerConnected: (pubkey: string) => void;
  onPeerDisconnected: (pubkey: string) => void;
  onPeerMessage: (pubkey: string, message: string) => void;
}
```

**Auto-connection behavior:**
- On app start, attempt to connect to all contacts via mesh
- Parallel connection attempts with staggered delays (avoid thundering herd)
- Reconnect on disconnect with backoff (same pattern as `NostrRelay.handleDisconnect()`)
- Max concurrent connections: 50 (practical browser limit for WebRTC)

**Connection lifecycle:**
1. `connect(bobPubkey)` → create RTCPeerConnection with relay-only ICE config
2. Create DataChannel named `nostr-relay`
3. Generate SDP offer → gift-wrap → publish to Nostr relay (via Tor)
4. Wait for answer (subscribe to kind 1059 from Bob)
5. On answer received → set remote description → ICE negotiation
6. DataChannel open → send `peer-connected` to mini-relay worker
7. All NIP-01 messages flow over the DataChannel
8. On disconnect → `peer-disconnected` to worker → reconnect with backoff

### 5.5 Message routing

When sending a message, the routing layer decides which path:

**File:** `src/lib/nostra/message-router.ts`

```typescript
interface MessageRouter {
  // Route a gift-wrap event to the best available path
  route(event: NostrEvent, recipientPubkey: string): Promise<RouteResult>;
}

type RouteResult = {
  path: 'mesh-direct' | 'mesh-forward' | 'relay-external';
  delivered: boolean;
  forwardedVia?: string; // pubkey of forwarding contact
};
```

**Routing logic:**
1. Is recipient connected in mesh? → send via WebRTC DataChannel → done
2. Find mutual contacts connected in mesh → send to them for store-forward
3. No mesh path available → publish to external Nostr relay (via Tor)
4. Always publish to external relay as backup (belt and suspenders)

**Step 4 is important:** even if mesh delivery succeeds, the event also goes to the external relay. This ensures the message is available if the recipient's mesh relay loses it (browser crash, etc.). Deduplication by `eventId` prevents double-delivery.

### 5.6 Presence awareness

To know who's online in the mesh, use lightweight heartbeats:

- Each connected peer sends a `PING` every 30 seconds on the DataChannel
- No response in 90 seconds → consider disconnected → trigger reconnect
- Presence state tracked in `MeshManager.peerStates: Map<pubkey, {lastSeen, latency}>`

No global presence broadcast — only your direct connections know you're online.

### 5.7 UI integration

**Chat list indicators:**
- Green dot: contact online in mesh (WebRTC connected)
- No dot: contact offline
- Existing relay status indicators unchanged

**Message status evolution:**
- ⏳ Sending (local)
- ✓ Sent (reached relay or mesh node)
- ✓✓ Delivered (confirmed on recipient's mini-relay)
- 🔵 Read (existing read receipt system)

**New indicator in chat header:**
- "P2P" badge when chatting with a mesh-connected contact
- Shows latency: "P2P · 1.2s via Tor"

**Settings section:**
- "Mesh Network" section in Privacy & Security
- Toggle: "Enable P2P mesh" (default: ON)
- Stats: "Connected to 5/12 contacts"
- Contact list with connection status per contact

## 6. Security considerations

### 6.1 IP protection
- `iceTransportPolicy: 'relay'` prevents WebRTC IP leak — no host/srflx candidates
- All TURN traffic routed through Tor
- Signaling via gift-wrap on external relays via Tor
- No direct WebSocket connections anywhere

### 6.2 Metadata minimization
- Gift-wrap `p` tag reveals recipient to forwarding nodes (necessary for store-forward)
- Forwarding nodes cannot read message content (NIP-17 encryption)
- Forwarding nodes are trusted contacts — acceptable metadata exposure
- External relays see Tor exit IPs only

### 6.3 Store-forward trust model
- Only forward for contacts (no open relay behavior)
- 72-hour retention limit on forwarded messages
- Forwarded events are standard Nostr events — signature-verified, tamper-proof
- A malicious forwarding node can withhold but not forge or read messages

### 6.4 Resource limits
- Max 50 WebRTC connections
- Max 20 subscriptions per peer on mini-relay
- Max 64KB per event
- 72-hour retention for forwarded events
- Rate limiting: 10 events/second per peer
- GC every hour for expired forward_queue entries

## 7. New files

| File | Purpose |
|------|---------|
| `src/lib/nostra/relay-store.ts` | IndexedDB storage for raw Nostr events + forward queue |
| `src/lib/nostra/mini-relay.ts` | NIP-01 protocol handler |
| `src/lib/nostra/mini-relay.worker.ts` | Web Worker wrapper for mini-relay |
| `src/lib/nostra/mesh-manager.ts` | WebRTC connection manager for contacts |
| `src/lib/nostra/message-router.ts` | 3-level routing (direct → forward → relay) |
| `src/lib/nostra/webrtc-config.ts` | WebRTC/TURN configuration |
| `src/lib/nostra/mesh-signaling.ts` | SDP exchange via Nostr gift-wrap |
| `src/components/sidebarLeft/tabs/nostraTorDashboard.ts` | Circuit dashboard tab |
| `src/components/sidebarLeft/tabs/nostraMeshSettings.ts` | Mesh settings tab |
| `src/scss/nostra/_tor-dashboard.scss` | Dashboard styles |
| `src/scss/nostra/_mesh-indicators.scss` | Mesh UI indicator styles |
| `src/tests/nostra/mini-relay.test.ts` | Mini-relay unit tests |
| `src/tests/nostra/mesh-manager.test.ts` | Mesh manager tests |
| `src/tests/nostra/message-router.test.ts` | Routing logic tests |
| `src/tests/nostra/relay-store.test.ts` | Storage layer tests |

## 8. Modified files

| File | Changes |
|------|---------|
| `src/lib/nostra/webtor-fallback.ts` | Expose circuit details, new `nostra_tor_circuit_update` event |
| `src/lib/nostra/privacy-transport.ts` | `setTorEnabled()` method, toggle support |
| `src/lib/nostra/nostr-relay.ts` | Latency tracking for Tor overhead display |
| `src/lib/nostra/chat-api.ts` | Integrate message-router for send path |
| `src/lib/nostra/nostra-bridge.ts` | Initialize mesh-manager and mini-relay |
| `src/lib/rootScope.ts` | New events: `nostra_tor_circuit_update`, `nostra_mesh_peer_connected/disconnected` |
| `src/components/sidebarLeft/tabs/privacyAndSecurity.ts` | Tor toggle + mesh settings links |
| `src/components/sidebarLeft/tabs/nostraRelaySettings.ts` | Tor latency overhead display |
| `src/components/nostra/torShield.tsx` | Respond to mesh state |
| `src/components/nostra/torBanner.tsx` | Show mesh status |
| `src/components/popups/torStatus.tsx` | Link to circuit dashboard |

## 9. Dependencies

### External
- **TURN server** — needed for WebRTC relay-only mode through Tor. Options: self-hosted coturn, or public TURN. Required before mesh can work.
- No new npm dependencies — WebRTC is native browser API, NIP-01 is simple JSON

### Internal
- Tor WASM (webtor-rs) — already integrated
- `message-store.ts` — continues as-is, `relay-store.ts` is separate
- `NostraSync` — receives events from mini-relay via same pipeline
- Contact list — mesh connects only to known contacts

## 10. Implementation order

1. **Tor UI** (Area 1) — low risk, improves existing components, no new infrastructure
2. **Mini-Relay** (Area 2) — core storage and protocol, testable in isolation
3. **Mesh P2P** (Area 3) — depends on mini-relay, needs TURN server, highest complexity

Each area is independently useful:
- Area 1 alone: better Tor UX
- Area 1+2: offline-capable relay with local storage
- Area 1+2+3: full decentralized mesh
