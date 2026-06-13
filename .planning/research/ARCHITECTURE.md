# Architecture Research

**Domain:** Decentralized P2P Messaging (Nostra.chat production evolution)
**Researched:** 2026-03-31
**Confidence:** HIGH (NIP specs verified via official docs; WebRTC tradeoffs from multiple sources; IPFS patterns from official IPFS blog and Fleek)

---

## System Overview

The target production architecture adds four capabilities on top of the existing M001-M005 foundation: group messaging, broadcast channels, multi-relay failover, and distributed PWA hosting. Each builds on what exists without replacing it.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         UI Layer (Solid.js / tweb)                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │
│  │  1:1 DM  │  │  Group   │  │ Channel  │  │  Onboarding /    │    │
│  │  Chat    │  │  Chat    │  │  View    │  │  Identity        │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘   │
├───────┴─────────────┴─────────────┴──────────────────┴─────────────┤
│                     Nostra.chat Integration Layer                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │
│  │ ChatAPI  │  │ GroupAPI │  │ ChanAPI  │  │ Identity/        │    │
│  │ (1:1 DM) │  │ (groups) │  │(channels)│  │ VirtualPeers     │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘   │
├───────┴─────────────┴─────────────┴──────────────────┴─────────────┤
│                     Transport Abstraction Layer                     │
│  ┌──────────────────────┐  ┌────────────────────────────────────┐   │
│  │   NostrRelayPool     │  │         PeerTransport              │   │
│  │  (multi-relay)       │  │   (WebRTC DataChannel + TURN)      │   │
│  └──────────┬───────────┘  └───────────────┬────────────────────┘  │
├─────────────┴─────────────────────────────┴─────────────────────── ┤
│                      Privacy Transport Layer                        │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │          PrivacyTransport (webtor-rs → direct WS)        │       │
│  └──────────────────────────────────────────────────────────┘       │
├──────────────────────────────────────────────────────────────────── ┤
│                      Network / Infra Layer                          │
│  ┌──────────┐  ┌────────────────────┐  ┌──────────────────────┐    │
│  │ STUN/TURN│  │  Nostr Relays      │  │  PWA Hosting         │    │
│  │  coturn  │  │  (pool of N relays)│  │  (IPFS + mirrors)    │    │
│  └──────────┘  └────────────────────┘  └──────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Component Boundaries

| Component | Responsibility | Communicates With |
|-----------|----------------|-------------------|
| `ChatAPI` (existing) | 1:1 DM send/receive via NIP-17 gift-wrap + WebRTC | NostrRelayPool, PeerTransport, OfflineQueue |
| `GroupAPI` (new) | Group chat membership, NIP-17 multi-recipient send, NIP-29 relay-group routing | NostrRelayPool, Identity |
| `ChannelAPI` (new) | One-to-many broadcast channel publish/subscribe via NIP-28 | NostrRelayPool |
| `NostrRelayPool` (upgrade) | Multi-relay connect, publish to all, subscribe with failover, NIP-65 relay list | PrivacyTransport (for HTTP path), direct WebSocket |
| `PeerTransport` (existing + upgrade) | WebRTC DataChannel lifecycle, ICE with TURN | STUN/TURN servers |
| `PrivacyTransport` (existing) | webtor-rs → direct WebSocket fallback chain | External Tor network, Nostr relay WS |
| `Identity` (upgrade) | npub/nsec secp256k1 keypair, NIP-05 alias, NIP-65 relay list publishing | NostrRelayPool, IndexedDB |
| `VirtualPeersDB` (existing + upgrade) | Map npub ↔ tweb peerId for users, groups, channels | AppChatsManager, AppUsersManager |
| `OfflineQueue` (existing) | IndexedDB-persisted retry queue for undelivered messages | PeerTransport, NostrRelayPool |

---

## How Group Messaging Should Work

### Approach: NIP-17 Private Groups (small) + NIP-29 Relay Groups (large)

Two group modes cover Nostra.chat's full range:

**Small groups (2–12 members): NIP-17 multi-recipient gift-wrap**
- Uses the same gift-wrap mechanism as 1:1 DMs (kind 14 + kind 1059)
- Each message is individually wrapped for every group member
- Group identity = the sorted set of participant npubs (no persistent group ID needed)
- Adding/removing a member creates a new "room" — message history is scoped per membership set
- Privacy: no metadata leak, participant list hidden from relays
- No relay-side enforcement required — works on any Nostr relay
- Practical limit: ~12 members before per-member wrap overhead becomes noticeable (MEDIUM confidence — derived from gift-wrap cost × members)

**Large groups (12+ members): NIP-29 relay-based groups**
- Groups hosted at a specific relay (`relay-host'group-id` format)
- Relay enforces membership via kind 9000 (add user) / kind 9001 (remove user) moderation events
- Chat messages use kind 9 with `h` tag for group ID
- Group metadata (name, picture, settings) stored as kind 39000 (relay-signed)
- Censorship tradeoff: group is tied to the hosting relay — if relay disappears, group is inaccessible
- Mitigation: replicate group relay list in user's NIP-65 kind 10002; support relay migration
- Implementations in production: Flotilla, Chachi (as of early 2026)

**Build order implication:** NIP-17 groups come first (reuses 1:1 infrastructure, no new relay behavior needed). NIP-29 comes later as a separate phase — requires relay selection UX and group discovery.

### Group Data Flow

```
User sends group message
    ↓
GroupAPI.sendGroupMessage(groupId, text)
    ↓
[Small group] Wrap for each member individually (NIP-17 kind 14 → kind 13 → kind 1059 per recipient)
    OR
[Large group] Publish kind 9 with h-tag to NIP-29 relay
    ↓
NostrRelayPool.publish(event) → broadcast to 2-4 write relays
    ↓
Recipients subscribe on their kind 10050 preferred relay list (NIP-17)
    OR
Recipients subscribe to NIP-29 relay with REQ {kinds:[9], "#h":[groupId]}
    ↓
GroupAPI.onGroupMessage callback → rootScope.dispatchEvent('group_message', {...})
    ↓
UI re-renders via Solid.js reactive store
```

---

## How Channel Broadcasting Should Work

### Approach: NIP-28 Public Chat (kind 40-44) with publisher keypair

Telegram-style channels are one-to-many: a publisher posts, subscribers receive read-only. NIP-28 public chat maps directly to this model.

**Channel lifecycle:**
1. Channel creator publishes kind 40 (channel create) with name, description, picture
2. Channel metadata updates use kind 41 (channel metadata) referencing the kind 40 event ID
3. Broadcast messages use kind 42 (channel message) with `e` tag pointing to channel root
4. Subscribers query: `{"kinds":[42], "#e":["<channel-root-id>"]}`
5. No encryption — channels are public by design (Telegram-style "channels", not "groups")

**Access control:**
- Publisher's keypair signs all kind 42 messages — subscribers verify signature
- Followers cannot post; kind 42 from non-publisher pubkey is ignored by clients
- Moderation: kind 43 (hide message) and kind 44 (mute user) are client-side only

**Build order implication:** Channels are simpler than groups because there's no membership management. Can be built in parallel with group work, or as a follow-on phase.

### Channel Data Flow

```
Publisher creates channel
    ↓
ChannelAPI.createChannel({name, description, picture})
    → Publishes kind 40 to NostrRelayPool
    → Stores channel root event ID in VirtualPeersDB as a "channel peer"
    ↓
Publisher posts broadcast
    ↓
ChannelAPI.publishBroadcast(channelId, text)
    → Publishes kind 42 with e-tag to all write relays
    ↓
Subscriber receives broadcast
    ↓
NostrRelayPool subscription filter: {kinds:[42], "#e":[channelId]}
    → ChannelAPI.onBroadcast callback
    → rootScope.dispatchEvent('channel_message', {...})
    → UI displays in read-only channel view
```

---

## Multi-Relay Architecture for Signaling Failover

### Current Problem
`NostrSignaler` hardcodes `wss://relay.damus.io` — single point of failure. If the relay is down, no WebRTC signaling is possible and no offline messages are delivered.

### Recommended Architecture: Relay Pool with Outbox Model

Use the **NIP-65 outbox model** (kind 10002 relay list) as the authoritative source of relay preferences:

**Relay pool behavior:**
- Connect to 2-4 write relays simultaneously on startup
- Publish to all connected write relays (redundancy — any relay stores the event)
- Subscribe on all connected read relays (any relay can deliver first)
- On relay disconnect: reconnect with exponential backoff; continue using remaining connected relays
- Relay health tracked: latency, last successful event, consecutive failures

**Relay selection defaults (hardcoded fallback):**
```
wss://relay.damus.io      (high uptime, widely indexed)
wss://relay.nostr.band    (good indexing, fast)
wss://nos.lol             (reliable, privacy-friendly)
wss://relay.snort.social  (good availability)
```
User's kind 10002 relay list overrides these defaults when present.

**Signal path with failover:**
```
NostrSignaler.publish(offerEvent)
    ↓
NostrRelayPool.publish(event)
    → relay-1.publish() → success
    → relay-2.publish() → success (redundant)
    → relay-3.publish() → timeout → mark degraded, retry after 30s
```

**Subscription with failover:**
```
NostrRelayPool.subscribe(filter, callback)
    → relay-1.subscribe() → connected, listening
    → relay-2.subscribe() → connected, listening (dedup on eventId)
    → relay-3.subscribe() → failed → reconnect in background
```

**Build order implication:** Multi-relay pool is a prerequisite for both group messaging (NIP-29 requires specific relay) and channels (want broad distribution). Build relay pool before group/channel work.

### Existing `nostr-relay-pool.ts`
The codebase already has `nostr-relay-pool.ts`. The upgrade path is to extend it to manage a configurable set of relay URLs, track health, and implement publish-to-all + subscribe-from-all semantics. Do not replace — extend.

---

## Distributed PWA Hosting Strategy

### Goal
The app must remain accessible even if any single domain or CDN is blocked. The app is a pure client-side SPA (Vite build → static files) — ideal for content-addressed and mirrored distribution.

### Layered Hosting Strategy

**Layer 1: Traditional mirrors (primary)**
- Deploy identical builds to 3-5 domains across different registrars and CDN providers
- Examples: Cloudflare Pages, Netlify, Vercel, GitHub Pages, Fly.io static
- Single Vite build artifact deployed to all mirrors simultaneously via CI/CD
- Mirror list embedded in the app itself so the service worker can redirect users to a working mirror

**Layer 2: IPFS pinning (secondary)**
- After each release, pin the `dist/` directory to IPFS via Pinata or Fleek
- CID (content hash) published alongside each release tag in git
- Users can access via any public IPFS gateway or locally via IPFS Desktop
- Progressive Web Apps work on IPFS — Vite SPA with hash-based routing is fully compatible
- ENS name (e.g., `nostra.eth`) or IPNS key can point to current CID for human-readable access

**Layer 3: Service Worker offline cache (tertiary)**
- Service worker caches the full app shell on first load
- Users who have visited once can use the app offline or when all mirrors are blocked
- Critical for users in high-censorship environments

**CI/CD pipeline:**
```
git push → GitHub Actions
    → pnpm build (single build)
    → Deploy to: CF Pages + Netlify + GitHub Pages (parallel)
    → IPFS pin via Pinata API → emit CID
    → Update release notes with CID + mirror URLs
```

**Build order implication:** Mirror deployment and service worker are independent of P2P features. Can be implemented in parallel. IPFS pinning requires the `copyPublicDir: true` fix (noted in KNOWLEDGE.md under D040).

### Key Constraint: Relative Paths
The app must use relative paths or hash routing (not history API) so it works from any base URL. Vite `base: './'` in `vite.config.ts` is required for IPFS compatibility. This must be verified before IPFS deployment.

---

## Recommended Project Structure (New Files)

```
src/lib/nostra/
├── identity.ts              # (upgrade) Add NIP-05, npub/nsec, NIP-65 publish
├── nostr-relay-pool.ts      # (upgrade) Multi-relay, health tracking, failover
├── group-api.ts             # (new) NIP-17 small groups + NIP-29 large groups
├── channel-api.ts           # (new) NIP-28 broadcast channels
├── relay-health.ts          # (new) Relay health tracker, latency, failure count
├── nip17.ts                 # (new) NIP-17 gift-wrap encode/decode
├── nip44.ts                 # (new) NIP-44 encryption (replace NIP-04)
└── virtual-peers-db.ts      # (upgrade) Add group and channel peer types
```

### Structure Rationale

- **`group-api.ts` separate from `chat-api.ts`:** Group semantics differ enough (membership management, multi-recipient wrap, relay routing) to warrant a distinct module. Shared transport via relay pool.
- **`channel-api.ts` separate from `group-api.ts`:** Channels are public + read-only for subscribers; groups are private + bidirectional. Different subscription filters, different UI affordances.
- **`relay-health.ts` isolated:** Relay health is a cross-cutting concern used by relay pool, signaling, and channel subscription. Keeping it separate avoids bloating relay pool.
- **`nip17.ts` / `nip44.ts` as utilities:** Pure cryptographic/encoding operations, no network I/O. Easily unit-tested, reused by ChatAPI, GroupAPI, and ChannelAPI.

---

## Architectural Patterns

### Pattern 1: NIP-17 Gift-Wrap per Recipient

**What:** For every group message, encrypt and wrap the event individually for each recipient's pubkey, then publish one wrapped event per recipient to their preferred relay (kind 10050).
**When to use:** Any private message: 1:1 DM, small group DM.
**Trade-offs:** Privacy is excellent (relay cannot see who's in a group or when messages arrive). Cost scales linearly with group size — a message to 10 people generates 10 relay publishes. Acceptable up to ~12-15 members.

```typescript
// Conceptual NIP-17 group send
async function sendGroupMessage(members: string[], text: string, senderKey: NostrKey) {
  const rumor = createRumor(text, members); // kind:14, unsigned
  const seal = sealRumor(rumor, senderKey); // kind:13, signed by sender
  for(const member of [...members, senderKey.pubkey]) {
    const wrapped = giftWrap(seal, member); // kind:1059, ephemeral key
    const preferredRelays = await getKind10050Relays(member);
    await relayPool.publish(wrapped, preferredRelays);
  }
}
```

### Pattern 2: Multi-Relay Publish + Deduplicating Subscribe

**What:** Publish events to all write relays in the pool simultaneously. Subscribe on all read relays and deduplicate by event ID client-side.
**When to use:** All Nostr event publishing and subscriptions.
**Trade-offs:** Redundancy means events survive relay downtime. Deduplication overhead is minimal (Set lookup). Slightly higher network traffic (N relay connections vs 1).

```typescript
// Conceptual multi-relay subscribe with dedup
const seen = new Set<string>();
relayPool.subscribe(filter, (event) => {
  if(seen.has(event.id)) return;
  seen.add(event.id);
  handleEvent(event);
});
```

### Pattern 3: VirtualPeerDB Extension for Groups and Channels

**What:** Represent groups and channels as virtual peers in tweb's ID space — same way individual P2P contacts are represented as virtual users with synthetic negative peer IDs.
**When to use:** Whenever a group or channel needs to appear in tweb's chat list.
**Trade-offs:** Keeps tweb's UI layer unchanged (it knows nothing about groups or channels — it just renders chats). Requires careful type discrimination (is this peer a user, group, or channel?) at routing boundaries.

```typescript
// Virtual peer types (extend existing VirtualPeerType)
type VirtualPeerType = 'user' | 'group-nip17' | 'group-nip29' | 'channel-nip28';

interface VirtualPeer {
  peerId: number;        // Synthetic negative ID for tweb
  type: VirtualPeerType;
  nostrId: string;       // npub for user, group-id for group/channel
  relayHint?: string;    // For NIP-29 groups: relay that hosts the group
}
```

### Pattern 4: Graceful WebRTC Degradation to Relay-Only

**What:** For group chats, do not require WebRTC connections between all members. Use Nostr relay as the always-on delivery path; WebRTC is an optimization for low-latency when peers are concurrently online.
**When to use:** Groups larger than 2 (mesh complexity O(n²)), or when NAT traversal fails.
**Trade-offs:** Relay-only is slower (relay round-trip vs direct P2P) but universally reliable. For chat messages (not real-time audio/video), relay latency (100-500ms) is acceptable.

---

## Data Flow

### Group Message Send (NIP-17 small group)

```
User types in group chat
    ↓
GroupAPI.sendGroupMessage(groupId, text)
    ↓
Fetch member list from VirtualPeersDB (groupId → []npub)
    ↓
nip17.giftWrapForMembers(text, members, senderKey)
    → Creates one kind:1059 event per member
    ↓
For each wrapped event:
    relayPool.publish(event, member.preferredRelays)
    ↓
OfflineQueue.enqueue(event) if publish fails
    ↓
rootScope.dispatchEvent('group_message_sent', {groupId, mid})
    ↓
UI shows sent bubble
```

### Incoming Group Message (NIP-17)

```
NostrRelayPool receives kind:1059 event on user's kind:10050 relay
    ↓
nip17.unwrapGiftWrap(event, userKey)
    → Decrypt outer wrap → get kind:13 seal
    → Decrypt seal → get kind:14 rumor
    ↓
GroupAPI.routeIncoming(rumor)
    → Check p-tags → identify group members → look up groupId in VirtualPeersDB
    ↓
rootScope.dispatchEvent('group_message', {groupId, message})
    ↓
AppMessagesManager.addToHistory (via display bridge)
    ↓
UI shows received bubble
```

### Multi-Relay Failover (Signaling)

```
App startup
    ↓
NostrRelayPool.connect([relay1, relay2, relay3, relay4])
    → All connections attempted in parallel
    → Track each relay: state (connected/connecting/failed), latency, lastEvent
    ↓
Any operation (publish/subscribe)
    → Use connected relays only
    → Failed relays: background reconnect with exponential backoff (5s → 30s → 120s)
    ↓
If all relays fail:
    → PrivacyTransport falls back to direct WebSocket
    → UI shows "limited connectivity" warning
```

---

## Scaling Considerations

| Scale | Architecture |
|-------|--------------|
| 0-1k users | Single NIP-17 for all DMs and small groups. NIP-28 channels. 2-3 public Nostr relays in pool. TURN server with low traffic. |
| 1k-10k users | NIP-29 relay groups for large communities. Relay pool expanded to 4-5 relays. TURN server needs dedicated bandwidth (50-100 Mbps). Mirror domains active. |
| 10k+ users | NIP-29 becomes critical path. Consider Nostra.chat-operated relay for NIP-29 groups with guaranteed uptime. IPFS pinning scales naturally. TURN needs horizontal scaling (regional coturn). |

### Scaling Priorities

1. **First bottleneck: TURN server bandwidth.** WebRTC relay traffic through TURN is the only infrastructure cost that scales with users. Monitor TURN bandwidth; scale vertically first, then add regional TURN servers.
2. **Second bottleneck: NIP-17 gift-wrap fan-out for large groups.** At 20+ members per group, each message generates 20+ relay publishes. Implement NIP-29 for large groups before this becomes user-visible.
3. **Third bottleneck: Relay availability.** Public Nostr relays can go down. Having 4 relays in the pool absorbs this. A self-hosted relay becomes worthwhile above 10k users.

---

## Anti-Patterns

### Anti-Pattern 1: Single relay for signaling

**What people do:** Use `wss://relay.damus.io` hardcoded for all signaling.
**Why it's wrong:** Single point of failure. Relay operator sees all peer IPs during WebRTC handshake. Relay operator can selectively block users.
**Do this instead:** Use NostrRelayPool with 3-4 relays. Publish to all, subscribe from all. Dedup client-side.

### Anti-Pattern 2: NIP-04 for all encryption

**What people do:** Continue using NIP-04 (current implementation) for groups and channels.
**Why it's wrong:** NIP-04 is deprecated. It has known metadata leakage (pubkey visible in plaintext tags). For groups, it doesn't hide who's in the group. NIP-44 (audited December 2023 by Cure53) is the current standard.
**Do this instead:** Migrate to NIP-44 + NIP-17 gift-wrap for DMs and group messages. NIP-04 can remain for legacy compatibility during transition.

### Anti-Pattern 3: WebRTC mesh for groups larger than 4

**What people do:** Create full-mesh WebRTC connections between all group members.
**Why it's wrong:** At N members, each peer maintains N-1 connections. Bandwidth explodes: each peer must send the same data stream to N-1 peers simultaneously. Above 4-6 members, this saturates mobile connections and causes quality degradation.
**Do this instead:** Use Nostr relay as the group message delivery path. WebRTC is reserved for 1:1 direct connections where low latency matters. Group messages tolerate 100-500ms relay round-trips.

### Anti-Pattern 4: Absolute base URL in PWA build

**What people do:** Leave Vite's default `base: '/'` for production build.
**Why it's wrong:** App won't work from an IPFS gateway path (`/ipfs/QmXxx/`) or from a non-root domain path. All asset URLs become absolute and 404.
**Do this instead:** Set `base: './'` in `vite.config.ts` and use hash routing (`/#/route`) instead of HTML5 history API. This makes the build portable to any origin.

### Anti-Pattern 5: Replacing tweb Telegram functionality

**What people do:** Modify tweb's core managers or MTProto paths to add P2P behavior.
**Why it's wrong:** Breaks feature flag isolation. Telegram functionality stops working when P2P flag is off. Future tweb upstream merges become difficult.
**Do this instead:** All P2P logic lives in `src/lib/nostra/`. Intercept only at `isVirtualPeer()` check boundaries. `window.__nostraEnabled` remains the kill switch for all P2P paths.

---

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Nostr relays (pool) | WebSocket subscription, NIP-01 protocol | Use 3-4 relays; no auth required for public relays; NIP-42 AUTH for private relays |
| coturn / TURN | ICE credentials in `NostraIceConfig.iceServers` | Use ephemeral HMAC credentials (time-limited); never hardcode static credentials in client |
| IPFS (Pinata/Fleek) | CI/CD pipeline pins `dist/` via HTTP API after each release | Not a runtime dependency — just deployment tooling |
| webtor-rs | WASM module loaded at runtime via import | ~1.2MB gzipped; load after initial render to avoid blocking |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `GroupAPI` ↔ `NostrRelayPool` | Direct method calls (publish, subscribe) | GroupAPI owns subscription lifecycle; pool owns connection lifecycle |
| `GroupAPI` ↔ `VirtualPeersDB` | Direct method calls (lookup, upsert) | VirtualPeersDB must support group peer type before GroupAPI is built |
| `ChannelAPI` ↔ `NostrRelayPool` | Direct method calls | Same relay pool as GroupAPI; filters differ (kind 40-42 vs kind 9 / kind 1059) |
| `Nostra.chat layer` ↔ `tweb AppManagers` | rootScope events only | Never import AppManager directly into nostra/; always dispatch events |
| `identity.ts` ↔ `NostrRelayPool` | Direct call to publish kind 10002 (NIP-65) on identity creation/update | Relay list is part of identity initialization |

---

## Build Order Implications

The following dependency chain determines phase ordering:

```
1. NIP-44 + NIP-17 crypto utilities (nip44.ts, nip17.ts)
   → No dependencies. Can be built and tested in isolation.

2. NostrRelayPool multi-relay upgrade (relay-health.ts + pool upgrade)
   → Depends on: existing nostr-relay-pool.ts
   → Required by: all subsequent features

3. Identity upgrade (npub/nsec + NIP-05 + NIP-65 relay publish)
   → Depends on: NostrRelayPool (to publish kind 10002)
   → Required by: GroupAPI (for member relay lookup)

4. VirtualPeersDB upgrade (group + channel peer types)
   → Depends on: Identity (for npub-based IDs)
   → Required by: GroupAPI, ChannelAPI, display bridge routing

5. GroupAPI — NIP-17 small groups
   → Depends on: NIP-44/NIP-17 utils, NostrRelayPool, VirtualPeersDB
   → Can begin after steps 1-4

6. ChannelAPI — NIP-28 broadcast channels
   → Depends on: NostrRelayPool, VirtualPeersDB
   → Can be built in parallel with GroupAPI (step 5)

7. TURN server deployment
   → Ops dependency. Can be done independently of code. Required before public launch.

8. GroupAPI — NIP-29 large relay groups
   → Depends on: GroupAPI NIP-17 (for UX patterns), multi-relay pool
   → Later phase — higher complexity, needs relay selection UX

9. Distributed PWA hosting
   → Depends on: Vite base path fix, service worker
   → Ops + config work. Independent of P2P features.
   → IPFS requires copyPublicDir fix (see KNOWLEDGE.md D040)
```

**Critical path:** NIP-44 crypto → relay pool → identity → virtual peers → group/channel APIs → TURN → launch.

---

## Sources

- [NIP-17: Private Direct Messages](https://nips.nostr.com/17) — official spec (HIGH confidence)
- [NIP-29: Relay-based Groups](https://github.com/nostr-protocol/nips/blob/master/29.md) — official spec (HIGH confidence)
- [NIP-28: Public Chat](https://nips.nostr.com/28) — official spec (HIGH confidence)
- [NIP-65: Relay List Metadata (Outbox Model)](https://nips.nostr.com/65) — official spec (HIGH confidence)
- [NIP-44: Versioned Encryption](https://nips.nostr.com/44) — official spec, Cure53 audited Dec 2023 (HIGH confidence)
- [NIP-59: Gift Wrap](https://nips.nostr.com/59) — official spec (HIGH confidence)
- [WebRTC P2P mesh scalability limits](https://bloggeek.me/webrtc-p2p-mesh/) — MEDIUM confidence (industry blog, consistent with multiple sources)
- [IPFS PWA hosting patterns](https://blog.ipfs.tech/dapps-ipfs/) — official IPFS blog (HIGH confidence)
- [coturn production deployment guide](https://webrtc.ventures/2025/01/how-to-set-up-self-hosted-stun-turn-servers-for-webrtc-applications/) — MEDIUM confidence (practitioner blog, 2025)
- [Fleek decentralized IPFS gateway](https://resources.fleek.xyz/blog/announcements/fleek-decentralized-ipfs-gateway/) — MEDIUM confidence (vendor blog)
- [The Outbox Model (Nostrify)](https://nostrify.dev/relay/outbox) — MEDIUM confidence (ecosystem documentation)

---

*Architecture research for: Nostra.chat — decentralized P2P messaging (production evolution)*
*Researched: 2026-03-31*
