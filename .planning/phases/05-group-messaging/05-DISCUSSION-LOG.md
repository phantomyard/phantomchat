# Phase 5: Group Messaging - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-03
**Phase:** 05-group-messaging
**Areas discussed:** Group identity & metadata, Message wrapping strategy, Group management UX, Group chat list display

---

## Group identity & metadata

| Option | Description | Selected |
|--------|-------------|----------|
| Random group keypair | Dedicated secp256k1 keypair per group, pubkey as group ID, creator holds secret key | |
| Shared random ID + creator-signed metadata | Random hex ID, metadata via NIP-17 control messages signed by creator | ✓ |
| You decide | Claude picks based on NIP-17 compatibility | |

**User's choice:** Shared random ID — after asking for pros/cons comparison and considering admin transfer scenarios
**Notes:** User asked about ownership transfer. Shared random ID is cleaner for admin changes (control message vs secret key transfer). User wants to replicate all Telegram group functionality using the same UI.

| Option | Description | Selected |
|--------|-------------|----------|
| Solo locale (IndexedDB) | Metadata in IndexedDB, synced via NIP-17 control messages | |
| Locale + relay hint | IndexedDB + NIP-17 'group_info' on relay for multi-device recovery | |
| You decide | Claude picks best for recovery and UX | ✓ |

**User's choice:** Claude's discretion on metadata storage approach

| Option | Description | Selected |
|--------|-------------|----------|
| Solo admin/creatore | Only creator/admin can change name and avatar (Telegram default) | ✓ |
| Qualsiasi membro | Any member can change group name and avatar | |
| You decide | Claude replicates Telegram model | |

**User's choice:** Solo admin/creatore

---

## Message wrapping strategy

| Option | Description | Selected |
|--------|-------------|----------|
| 1 gift-wrap per membro (N eventi) | N+1 gift-wraps per message (one per member + self-send), max 13 events, NIP-17 pure | ✓ |
| Fan-out con shared secret | Single event encrypted with shared group secret, all members decrypt with same key | |
| You decide | Claude picks based on NIP-17 spec and privacy requirements | |

**User's choice:** Initially selected shared secret, then after clarification about GRP-02 requirements and group size (max 12 = 13 events max), switched to 1 gift-wrap per membro. Also proposed hybrid: gift-wrap for private groups, shared secret for public groups → noted as deferred idea for v2.
**Notes:** User proposed "gift-wrap per gruppi piccoli e shared secret per gruppi pubblici" — noted as deferred idea since Phase 5 only covers private groups ≤12 members.

| Option | Description | Selected |
|--------|-------------|----------|
| Stile WhatsApp gruppi | Double check = delivered to all, blue check = read by all, tap for per-member detail | ✓ |
| Semplificato | Only sent/delivered, no read receipts in groups | |
| You decide | Claude picks based on delivery tracker implementation | |

**User's choice:** Stile WhatsApp gruppi

---

## Group management UX

| Option | Description | Selected |
|--------|-------------|----------|
| Stile Telegram | 'Nuovo gruppo' button in chat list → select contacts → name + avatar → create | ✓ |
| Flow minimale | From existing 1:1 chat: 'Add to group' → select contacts → name → create | |
| You decide | Claude replicates Telegram flow | |

**User's choice:** Stile Telegram

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-join con notifica | Member added automatically with service message notification (like Telegram) | ✓ (default) |
| Invito con accettazione | Member receives invite in Requests section, must accept before seeing messages | ✓ (privacy setting) |

**User's choice:** Both — default auto-join, but privacy setting "Chi può aggiungermi ai gruppi" allows requiring invitation acceptance
**Notes:** User specified this depends on privacy settings. Default is auto-join, but user can restrict who can add them to groups.

| Option | Description | Selected |
|--------|-------------|----------|
| Stile Telegram | Admin opens group info → member list → tap → 'Remove'. Removed member sees service message | ✓ |
| Rimozione silenziosa | Admin removes without notification, member stops receiving messages silently | |
| You decide | Claude replicates Telegram behavior | |

**User's choice:** Stile Telegram

| Option | Description | Selected |
|--------|-------------|----------|
| Chat resta visibile (read-only) | Like Telegram: member still sees message history but can't send | |
| Chat rimossa automaticamente | Chat removed from list when leaving. Re-entry requires new invite | ✓ |

**User's choice:** Chat rimossa automaticamente — diverges from Telegram default (which keeps chat visible as read-only)

---

## Group chat list display

| Option | Description | Selected |
|--------|-------------|----------|
| Stile Telegram | Group avatar (or generated initials), bold name, "MemberName: message" preview, unread badges | ✓ |
| Avatar collage | Composite avatar from first 4 member avatars (2x2 grid, Google Chat style) | |
| You decide | Claude picks most compatible with tweb UI | |

**User's choice:** Stile Telegram

| Option | Description | Selected |
|--------|-------------|----------|
| Sidebar Telegram completa | Side panel: avatar, name, description, member list with roles, shared media, mute, leave | ✓ |
| Dialog minimale | Simple popup with name, avatar, member list, action buttons | |
| You decide | Claude picks based on tweb sidebar components | |

**User's choice:** Sidebar Telegram completa

| Option | Description | Selected |
|--------|-------------|----------|
| Stile Telegram | Centered gray bubbles with text ("X added Y", "X left the group") | ✓ |
| Inline nel flusso | Small gray centered text without bubble | |
| You decide | Claude uses existing tweb service message system | |

**User's choice:** Stile Telegram

## Claude's Discretion

- Multi-device metadata recovery approach (local only vs relay hint)
- NIP-17 control message payload format
- Privacy setting implementation ("Chi può aggiungermi ai gruppi")
- Generated avatar for groups without custom avatar
- Delivery status aggregation logic for "delivered/read by all"
- 12-member limit enforcement UX

## Deferred Ideas

- **Shared secret encryption for large groups** — Alternative to gift-wrap fan-out for groups >12 members. More efficient (1 event per message) but less privacy. Evaluate for v2/NIP-29
- **Avatar collage** — Composite avatar from first 4 member avatars (2x2 grid). Alternative to initial-based group avatar. Could be added as future enhancement
