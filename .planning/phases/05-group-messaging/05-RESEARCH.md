# Phase 5: Group Messaging - Research

**Researched:** 2026-04-03
**Domain:** NIP-17 multi-recipient gift-wrap group messaging, Solid.js UI, IndexedDB storage
**Confidence:** HIGH

## Summary

Phase 5 extends the existing NIP-17 1:1 messaging infrastructure to support private groups of up to 12 members. The core protocol mechanism is well-defined: NIP-17 already supports multiple `["p", "<pubkey>"]` tags in kind 14 rumors, and `nostr-tools@2.23.3` (already installed) provides `wrapManyEvents` which creates N+1 gift-wraps (one per recipient + self-send). However, the project currently uses its own manual wrapping pipeline in `nostr-crypto.ts` due to incorrect `#p` tag issues with `wrapManyEvents` -- the same manual approach should be extended for groups by looping over members.

The main engineering challenges are: (1) group metadata storage and syncing via NIP-17 control messages, (2) integrating group dialogs into tweb's rendering pipeline using `peerChat` type (negative peer IDs) instead of `peerUser`, (3) sender name/color attribution in group message bubbles, and (4) per-member delivery status aggregation. All UI components (contact selector, sidebar info, service messages) have existing tweb counterparts that can be reused or extended.

**Primary recommendation:** Extend the existing manual NIP-17 wrapping pipeline to loop over group members (N gift-wraps + 1 self-send per message). Store group metadata in a new IndexedDB store. Use `peerChat` with negative peer IDs for group dialogs. Reuse tweb's existing service message renderer for group events.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- D-01: Groups use a shared random hex ID (not a dedicated keypair). Generated at creation time, shared via NIP-17 control messages signed by creator.
- D-02: Group metadata (name, avatar, member list) stored in IndexedDB locally. Claude's Discretion on relay hint for multi-device recovery.
- D-03: Only admin/creator can change group name and avatar. Transfer of admin role via NIP-17 control message.
- D-04: 1 gift-wrap per member (NIP-17 puro). N+1 gift-wrap events per message (one per member + self-send). Max 13 events per message.
- D-05: WhatsApp-style group delivery indicators: double check = delivered to all, blue check = read by all. Tap shows per-member detail. Read receipt privacy from Phase 4 applies.
- D-06: Telegram-style group creation: "New Group" button -> select contacts -> name + optional avatar -> create.
- D-07: Auto-join invites with service message notification. Privacy setting "Who can add me to groups" (Everyone / Contacts only / Nobody -> invite goes to Requests).
- D-08: Telegram-style removal: admin opens group info -> member list -> tap -> "Remove".
- D-09: Leave removes chat from list. Rejoin requires new invite.
- D-10: Telegram-style chat list: group avatar, bold name, preview "MemberName: message", unread badges.
- D-11: Telegram-style group info sidebar: avatar, name, description, member list with roles, shared media, mute, leave.
- D-12: Telegram-style service messages: centered gray bubbles for "X added Y", "X left the group". Reuse tweb service message renderer.

### Claude's Discretion
- Recovery multi-device dei metadata gruppo (local only vs relay hint)
- Format of NIP-17 control message payloads (group_create, group_add_member, group_remove_member, group_leave, group_info_update)
- Implementation of "Who can add me to groups" privacy setting (UI and storage)
- Avatar generation with initials for groups without avatar
- Delivery status aggregation logic for "delivered/read by all" display
- 12-member limit enforcement UX and messaging

### Deferred Ideas (OUT OF SCOPE)
- Shared secret encryption for large groups (v2/NIP-29)
- Avatar collage (grid of member avatars)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| GRP-01 | User can create a group with up to 12 members | Group creation flow using NIP-17 control messages, IndexedDB group store, contact selector reuse |
| GRP-02 | Group messages use NIP-17 multi-recipient gift-wrap (privacy preserved) | Manual wrapping loop over N members + self-send, same pipeline as 1:1 but iterated |
| GRP-03 | User can add/remove members from groups they created | NIP-17 control messages for add/remove, admin-only enforcement, service message injection |
| GRP-04 | User can leave a group | NIP-17 leave control message, local cleanup, dialog removal |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| nostr-tools | 2.23.3 | NIP-17/44/59 wrapping, key operations | Already installed, same version as registry |
| Solid.js | vendor fork | UI components for group creation, info, settings | Project standard |
| IndexedDB | native | Group metadata persistence | Established pattern from virtual-peers-db |
| SCSS modules | n/a | Component-scoped styles | Project standard |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| nostr-tools/nip59 | 2.23.3 | Lower-level rumor/seal/wrap for control messages | Control messages with custom tags (like receipt wrapping pattern) |
| crypto.randomUUID() | native | Group ID generation | Group creation |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Manual wrapping loop | nostr-tools wrapManyEvents | wrapManyEvents was rejected in Phase 4 (incorrect #p tags); manual loop gives full control |
| IndexedDB for group metadata | localStorage | IndexedDB supports structured data, pagination, and is consistent with existing stores |
| Random hex group ID | Dedicated Nostr keypair per group | Keypair adds complexity (key management, rotation); hex ID is simpler per D-01 |

**Installation:**
```bash
# No new dependencies needed - all libraries already installed
```

**Version verification:** nostr-tools@2.23.3 is the current registry version (verified).

## Architecture Patterns

### Recommended Project Structure
```
src/lib/nostra/
  group-store.ts           # IndexedDB store for group metadata
  group-api.ts             # Group-level operations (create, send, manage members)
  group-control-messages.ts # NIP-17 control message wrapping/unwrapping
  group-delivery-tracker.ts # Per-member delivery aggregation

src/components/nostra/
  GroupCreation.tsx         # Multi-step group creation flow
  GroupInfo.tsx             # Sidebar info panel
  GroupMemberList.tsx       # Member list with admin actions
  GroupPrivacySetting.tsx   # "Who can add me to groups" toggle
```

### Pattern 1: Group Metadata IndexedDB Store
**What:** Dedicated IndexedDB store for group metadata, following the same pattern as `virtual-peers-db.ts`.
**When to use:** All group metadata CRUD.
**Example:**
```typescript
// Source: virtual-peers-db.ts pattern
const DB_NAME = 'nostra-groups';
const DB_VERSION = 1;
const STORE_NAME = 'groups';

interface GroupRecord {
  groupId: string;           // Random hex ID (D-01)
  name: string;
  avatar?: string;           // Data URL or empty
  adminPubkey: string;       // Creator's pubkey
  members: string[];         // Array of hex pubkeys
  peerId: number;            // Negative virtual peer ID for tweb
  createdAt: number;
  updatedAt: number;
}
```

### Pattern 2: Multi-Recipient Gift-Wrap Loop
**What:** Send same message to all group members by calling the manual wrapping pipeline once per recipient.
**When to use:** Every group message send.
**Example:**
```typescript
// Source: nostr-crypto.ts wrapNip17Message pattern extended
function wrapGroupMessage(
  senderSk: Uint8Array,
  memberPubkeys: string[],
  content: string,
  groupId: string
): NTNostrEvent[] {
  const senderPubHex = getPublicKey(senderSk);
  const allWraps: NTNostrEvent[] = [];

  // Build rumor with all member p-tags + group tag
  const tags: string[][] = memberPubkeys.map(pk => ['p', pk]);
  tags.push(['group', groupId]);

  const rumor = createRumor(content, senderSk, tags);

  // One gift-wrap per member
  for(const memberPk of memberPubkeys) {
    const seal = createSeal(rumor, senderSk, memberPk);
    const wrap = createGiftWrap(seal, memberPk);
    allWraps.push(wrap as unknown as NTNostrEvent);
  }

  // Self-send for multi-device
  const selfSeal = createSeal(rumor, senderSk, senderPubHex);
  const selfWrap = createGiftWrap(selfSeal, senderPubHex);
  allWraps.push(selfWrap as unknown as NTNostrEvent);

  return allWraps; // N+1 events
}
```

### Pattern 3: Group Dialog as peerChat (Negative Peer ID)
**What:** Groups must use `peerChat` type with negative peer IDs to differentiate from 1:1 user chats in tweb's rendering pipeline.
**When to use:** Creating synthetic dialogs for groups.
**Example:**
```typescript
// Source: peerIdPolyfill.ts analysis
// toPeerId(true) negates the ID for chat type
const groupPeerId = groupNumericId.toPeerId(true); // negative number

const dialog = {
  _: 'dialog',
  pFlags: {pinned: true},
  peer: {
    _: 'peerChat',
    chat_id: Math.abs(groupPeerId)
  },
  peerId: groupPeerId,
  // ... rest same as 1:1 synthetic dialog
};
```

### Pattern 4: NIP-17 Control Messages
**What:** Group management operations (create, add/remove member, leave, info update) encoded as NIP-17 kind 14 rumors with custom tags.
**When to use:** All group management actions.
**Example:**
```typescript
// Source: follows wrapNip17Receipt pattern using nip59 lower-level API
// Control message types:
// - group_create: sent to all initial members
// - group_add_member: sent to all current members + new member
// - group_remove_member: sent to all remaining members
// - group_leave: sent to all remaining members
// - group_info_update: sent to all members

interface GroupControlPayload {
  type: 'group_create' | 'group_add_member' | 'group_remove_member'
    | 'group_leave' | 'group_info_update';
  groupId: string;
  groupName?: string;
  groupAvatar?: string;
  memberPubkeys?: string[];
  targetPubkey?: string;  // For add/remove
  adminPubkey?: string;
}
```

### Pattern 5: Sender Attribution in Group Bubbles
**What:** Group messages need visible sender name and color above each message bubble.
**When to use:** Rendering incoming group messages.
**Example:**
```typescript
// In group message synthetic message:
const message = {
  _: 'message',
  id: mid,
  peer_id: {_: 'peerChat', chat_id: groupChatId},
  from_id: {_: 'peerUser', user_id: senderPeerId},
  // from_id is different from peer_id in groups (unlike 1:1)
  // tweb uses from_id to show sender name in group bubbles
};
```

### Anti-Patterns to Avoid
- **Using wrapManyEvents from nostr-tools:** Generates incorrect #p tags (documented in nostr-crypto.ts comment). Use manual wrapping loop instead.
- **Using peerUser for groups:** Groups MUST use peerChat with negative peer IDs. Using peerUser would make tweb treat it as a 1:1 chat and break sender attribution.
- **Storing group secret key:** D-01 explicitly says groups use a shared random hex ID, NOT a keypair. Do not generate or store group secret keys.
- **Broadcasting member list in plaintext:** All group management must go through NIP-17 gift-wrap to maintain privacy guarantees (GRP-02).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| NIP-44 encryption | Custom crypto | nostr-tools/nip44 | Already used, battle-tested |
| Gift-wrap pipeline | New wrapping code | Extend existing createRumor/createSeal/createGiftWrap | Proven in Phase 4, just loop it |
| IndexedDB helpers | New DB abstraction | Follow virtual-peers-db.ts pattern | Consistent project pattern |
| Service message rendering | Custom bubble type | tweb ServiceBubble + wrapMessageActionTextNew | Already exists in components/chat/bubbles/service.tsx |
| Contact picker | Custom member selector | tweb contacts tab components | Already exists in components/sidebarLeft/tabs/contacts.ts |
| Avatar initials generation | Custom canvas drawing | CSS-based initials (colored div with text) | Simpler, no canvas needed for 2-char initials |

**Key insight:** The existing 1:1 messaging infrastructure (nostr-crypto, chat-api, delivery-tracker, display-bridge, send-bridge) provides ~80% of what's needed. Phase 5 is primarily about extending these components with group awareness, not building new ones.

## Common Pitfalls

### Pitfall 1: Gift-Wrap Fan-Out Performance
**What goes wrong:** Sending 13 gift-wraps sequentially (12 members + self) blocks the UI.
**Why it happens:** Each wrap involves NIP-44 encryption + ephemeral key generation.
**How to avoid:** Publish wraps in parallel via `Promise.all()`. The relay pool already handles per-relay publishing; the bottleneck is encryption.
**Warning signs:** Message send takes >2s in a 12-member group.

### Pitfall 2: Group Message Routing After Unwrap
**What goes wrong:** After unwrapping a gift-wrap, the receiver can't determine which group the message belongs to because the outer gift-wrap only has the receiver's `p` tag.
**Why it happens:** NIP-17 gift-wraps hide the rumor's tags from relays.
**How to avoid:** Include a `["group", groupId]` tag in the rumor (kind 14). After unwrapping, check for group tag and route to the correct group chat. Without this tag, messages would appear as 1:1 DMs from the sender.
**Warning signs:** Group messages appearing as individual 1:1 conversations.

### Pitfall 3: Negative Peer ID for Groups
**What goes wrong:** Using positive peer IDs (like 1:1 chats) for groups breaks tweb's isAnyChat/isUser checks, resulting in missing sender names, wrong context menus, and broken navigation.
**Why it happens:** tweb uses sign of peer ID to distinguish users (positive) from chats (negative). `toPeerId(true)` negates the number.
**How to avoid:** Always use `toPeerId(true)` for group peer IDs. Register groups via `appChatsManager` (or equivalent P2P injection) rather than `appUsersManager.injectP2PUser`.
**Warning signs:** Group chat behaves like 1:1 chat (no sender names above bubbles).

### Pitfall 4: Dialog Drop in dialogsStorage
**What goes wrong:** Synthetic group dialogs get silently dropped by `pushDialog` due to `isDialogsLoaded()` or `offsetDate` checks.
**Why it happens:** Same issue as Phase 4 (documented in CLAUDE.md). The `dropDialog` guard for `peerId >= 1e15` only works for positive user peer IDs.
**How to avoid:** Extend the `dropDialog` guard to also skip negative peer IDs in the virtual range (e.g., `peerId <= -1e15`). Continue using `pFlags.pinned = true` to bypass offsetDate checks.
**Warning signs:** Group dialogs disappearing from chat list after certain operations.

### Pitfall 5: Control Message Loop
**What goes wrong:** A "member added" control message from admin triggers the recipient to send a delivery receipt, which triggers another delivery receipt, creating a loop.
**Why it happens:** Control messages use the same NIP-17 pipeline as regular messages.
**How to avoid:** Mark control messages with a `["control", "true"]` tag. Skip delivery receipt sending for events with this tag (same pattern as `isReceiptEvent` in delivery-tracker.ts).
**Warning signs:** Exponential event count after group operations.

### Pitfall 6: Member Removal Race Condition
**What goes wrong:** A removed member sends a message between the removal control message being sent and being received by other members.
**Why it happens:** NIP-17 messages have relay propagation delay.
**How to avoid:** When processing a remove_member control message, discard any messages from the removed member that arrive after the control message's created_at timestamp. Use the rumor's created_at (not the gift-wrap's randomized one).
**Warning signs:** Ghost messages from removed members appearing in group.

### Pitfall 7: Self-Send Message Dedup in Groups
**What goes wrong:** The sender receives their own message back via the self-send gift-wrap and displays it as a duplicate.
**Why it happens:** In 1:1 chat, self-send messages are filtered by matching `from === ownPubkey`. In groups, the same message arrives from self AND is displayed locally.
**How to avoid:** Dedup by message ID (rumor event ID) in group message handler. The locally-sent message should be tracked by its rumor ID and the self-send gift-wrap matched against it.
**Warning signs:** Every sent message appearing twice in group chat.

## Code Examples

### Group Store Schema
```typescript
// Source: follows virtual-peers-db.ts pattern
const DB_NAME = 'nostra-groups';

interface GroupRecord {
  groupId: string;           // Primary key - random hex
  name: string;
  description?: string;
  avatar?: string;
  adminPubkey: string;
  members: string[];         // Hex pubkeys
  peerId: number;            // Deterministic from groupId, negative for peerChat
  createdAt: number;
  updatedAt: number;
}

// IndexedDB indexes:
// - keyPath: 'groupId'
// - index: 'peerId' (unique) for reverse lookup
```

### Control Message Wrapping
```typescript
// Source: follows wrapNip17Receipt pattern from nostr-crypto.ts
function wrapGroupControl(
  senderSk: Uint8Array,
  recipientPubHex: string,
  payload: GroupControlPayload
): NTNostrEvent[] {
  const rumor = createNip59Rumor({
    kind: 14,
    content: JSON.stringify(payload),
    tags: [
      ['p', recipientPubHex],
      ['control', 'true'],
      ['group', payload.groupId]
    ]
  }, senderSk);

  const seal = createNip59Seal(rumor, senderSk, recipientPubHex);
  const wrap = createNip59Wrap(seal, recipientPubHex);
  return [wrap];
}
```

### Group Dialog Registration
```typescript
// Source: nostra-display-bridge.ts createSyntheticDialog adapted for groups
function createGroupDialog(groupPeerId: number): Dialog.dialog {
  const now = Math.floor(Date.now() / 1000);
  return {
    _: 'dialog',
    pFlags: {pinned: true},
    peer: {
      _: 'peerChat',
      chat_id: Math.abs(groupPeerId)  // chat_id is always positive
    } as Peer.peerChat,
    peerId: groupPeerId,  // Negative for chat type
    top_message: 0,
    read_inbox_max_id: 0,
    read_outbox_max_id: 0,
    unread_count: 0,
    unread_mentions_count: 0,
    unread_reactions_count: 0,
    folder_id: 0,
    notify_settings: {
      _: 'peerNotifySettings',
      pFlags: {},
      sound: 1,
      show_previews: true,
      silent: false,
      mute_until: 0
    },
    pts: undefined
  } as Dialog.dialog;
}
```

### Group-Aware Message Routing
```typescript
// Source: chat-api.ts handleRelayMessage pattern
function routeIncomingMessage(rumor: RumorEvent): void {
  // Check for group tag
  const groupTag = rumor.tags?.find(t => t[0] === 'group');
  if(groupTag) {
    const groupId = groupTag[1];
    // Route to group chat handler
    handleGroupMessage(groupId, rumor);
  } else {
    // Route to 1:1 chat handler (existing path)
    handleDirectMessage(rumor);
  }

  // Check for control tag
  const controlTag = rumor.tags?.find(t => t[0] === 'control');
  if(controlTag) {
    handleControlMessage(rumor);
    return; // Don't send delivery receipt for control messages
  }
}
```

### Per-Member Delivery Aggregation
```typescript
// Source: delivery-tracker.ts DeliveryTracker extended for groups
interface GroupDeliveryInfo {
  messageId: string;
  groupId: string;
  memberStates: Map<string, DeliveryState>; // pubkey -> state
  aggregateState: DeliveryState;  // min of all member states
}

function computeAggregateState(
  memberStates: Map<string, DeliveryState>
): DeliveryState {
  const states = Array.from(memberStates.values());
  // All must be 'read' for aggregate 'read'
  if(states.every(s => s === 'read')) return 'read';
  // All must be at least 'delivered' for aggregate 'delivered'
  if(states.every(s => s === 'delivered' || s === 'read')) return 'delivered';
  // At least one sent
  if(states.some(s => s !== 'sending')) return 'sent';
  return 'sending';
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| NIP-04 encryption | NIP-44 (ChaCha20-Poly1305) | 2023 | All encryption uses NIP-44 |
| nostr-tools wrapManyEvents | Manual wrapping loop | Phase 4 | Correct #p tags, full control |
| WebRTC for messaging | Nostr relay only | Architecture decision | Simplifies group messaging (no signaling mesh) |

**Deprecated/outdated:**
- NIP-04: Fully removed from codebase (Phase 2 decision)
- wrapManyEvents: Available but unused due to incorrect #p tag generation

## Open Questions

1. **Multi-device group recovery**
   - What we know: Group metadata is stored locally in IndexedDB per D-02.
   - What's unclear: Whether to also publish a NIP-17 `group_info` event to relay for recovery on new devices. This is Claude's Discretion.
   - Recommendation: Start with local-only. Add relay hint as a future enhancement (publish encrypted group_info to self only on relay).

2. **appChatsManager injection for groups**
   - What we know: 1:1 chats use `appUsersManager.injectP2PUser`. Groups need `peerChat` type which is managed by `appChatsManager`.
   - What's unclear: Whether appChatsManager has similar injection capability or needs one added.
   - Recommendation: Add an `injectP2PGroup` method to appChatsManager following the same pattern as `injectP2PUser` in appUsersManager.

3. **Group ID to peer ID mapping**
   - What we know: 1:1 uses deterministic SHA-256 of pubkey + VIRTUAL_PEER_BASE. Groups need a separate mapping.
   - What's unclear: Whether to use the same VIRTUAL_PEER_BASE range (risking collision) or a separate range.
   - Recommendation: Use a separate GROUP_PEER_BASE (e.g., `BigInt(2 * 10**15)`) and negate for peerChat type. Store mapping in group-store.ts.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (from project config) |
| Config file | vitest.config.ts (or vite.config.ts vitest section) |
| Quick run command | `pnpm test src/tests/nostra/` |
| Full suite command | `pnpm test` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| GRP-01 | Group creation stores metadata and sends control messages | unit | `pnpm test src/tests/nostra/group-store.test.ts -x` | Wave 0 |
| GRP-01 | Group appears in chat list with correct peerChat type | unit | `pnpm test src/tests/nostra/group-display.test.ts -x` | Wave 0 |
| GRP-02 | Group message wraps N+1 gift-wraps with group tag | unit | `pnpm test src/tests/nostra/group-messaging.test.ts -x` | Wave 0 |
| GRP-02 | Incoming group message routed to correct group chat | unit | `pnpm test src/tests/nostra/group-routing.test.ts -x` | Wave 0 |
| GRP-03 | Add member sends control message to all members | unit | `pnpm test src/tests/nostra/group-management.test.ts -x` | Wave 0 |
| GRP-03 | Remove member sends control message; removed member excluded | unit | `pnpm test src/tests/nostra/group-management.test.ts -x` | Wave 0 |
| GRP-04 | Leave sends control message and removes local dialog | unit | `pnpm test src/tests/nostra/group-management.test.ts -x` | Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test src/tests/nostra/`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/tests/nostra/group-store.test.ts` -- covers GRP-01 (IndexedDB CRUD)
- [ ] `src/tests/nostra/group-messaging.test.ts` -- covers GRP-02 (wrapping, routing)
- [ ] `src/tests/nostra/group-management.test.ts` -- covers GRP-03, GRP-04 (add/remove/leave)
- [ ] `src/tests/nostra/group-display.test.ts` -- covers GRP-01 (chat list, dialog)

## Sources

### Primary (HIGH confidence)
- nostr-tools@2.23.3 source code (node_modules) -- verified wrapManyEvents API, createRumor, createSeal, createWrap
- NIP-17 spec (via Context7 /nostr-protocol/nips) -- kind 14/15 multi-recipient tag structure
- Project source: `src/lib/nostra/nostr-crypto.ts` -- manual wrapping pipeline, wrapManyEvents rejection reason
- Project source: `src/lib/nostra/chat-api.ts` -- message lifecycle, store integration
- Project source: `src/lib/nostra/delivery-tracker.ts` -- 4-state machine, receipt handling
- Project source: `src/lib/nostra/nostra-display-bridge.ts` -- synthetic dialog/message injection
- Project source: `src/lib/nostra/virtual-peers-db.ts` -- IndexedDB store pattern
- Project source: `src/helpers/peerIdPolyfill.ts` -- toPeerId(true) negation for chat types

### Secondary (MEDIUM confidence)
- NIP-59 spec (Context7) -- gift-wrap/seal/rumor pipeline for control messages
- tweb `src/components/chat/bubbles/service.tsx` -- service message rendering pattern
- tweb `src/lib/storages/dialogs.ts` -- registerP2PDialog, dropDialog guard for virtual peers

### Tertiary (LOW confidence)
- None -- all findings verified against source code

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies needed, all verified against installed versions
- Architecture: HIGH -- extends existing patterns with well-understood modifications
- Pitfalls: HIGH -- identified from source code analysis and Phase 4 experience (documented in CLAUDE.md)

**Research date:** 2026-04-03
**Valid until:** 2026-05-03 (stable -- NIP-17 spec and nostr-tools version unlikely to change)
