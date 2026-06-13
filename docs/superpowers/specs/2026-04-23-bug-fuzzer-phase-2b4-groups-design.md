# Bug Fuzzer Phase 2b.4 — Groups Coverage

**Date**: 2026-04-23
**Status**: Active
**Predecessor**: Phase 2b.3 — reactions eventId mismatch closed, baseline v2b2 unblocked.
**Branch**: `feat/fuzz-phase-2b4-groups` in worktree.

## 1. Goal

Close the **groups coverage gap** in the fuzz suite. Group messaging has shipped (NIP-17 multi-wrap via `GroupAPI` + `group-store` + `group-control-messages` + `group-delivery-tracker` + UI tab `nostraNewGroup`) but has **zero fuzz coverage**. Any regression in the group pipeline ships undetected.

Phase 2b.4 delivers:

1. Design spec (this document).
2. New fuzz actions covering create / send / addMember / removeMember / leave.
3. New invariants covering group identity, membership coherence, bilateral delivery, peer-id stability.
4. New postconditions for the immediate effects of each action.
5. Unit tests for each new invariant.
6. A fuzz-discovered bug batch with fixes and permanent E2E regressions.
7. Emit baseline **v2b4** at seed=42 (unblocks the `--replay-baseline` path).
8. Carry-forward list for Phase 2b.5 (anything not reachable with 2 users).

## 2. Scope decisions

### 2.1 Harness topology — 2 users, synthetic third pubkey

The `FuzzContext.users` type is currently `{userA, userB}` — hard-coded in ~138 sites across the fuzz tree. Introducing a real `userC` would require touching every invariant, every postcondition, every action loop. That's a 2b.5-sized change, not 2b.4.

**Phase 2b.4 stays 2-user.** For `addMember` and the "third participant" shape of groups, we synthesise a **disposable pubkey** (generate via `crypto.getRandomValues` in the browser) that is NOT connected to any live session. This means:

- `createGroup` builds groups of size 2 (A + B) or size 3 (A + B + syntheticPk).
- `addMember` adds a fresh synthetic pubkey to an existing group.
- `removeMember` removes either B or a synthetic pubkey.
- `leaveGroup` is the only way B leaves an A-admin group.

The synthetic pubkey tests **control-message fan-out, store persistence, and delivery-tracker state** without requiring a third browser context. Real 3-party message delivery is explicitly **out of scope** and moves to Phase 2b.5.

### 2.2 No windowing of `__nostraGroupAPI`

`GroupAPI` is not exposed on `window` today (unlike `__nostraChatAPI`). We do **not** add that exposure — it would be a production surface purely for tests.

Instead, every fuzz action calls it via dynamic import inside `page.evaluate`:

```ts
const {getGroupAPI} = await import('/src/lib/nostra/group-api.ts');
const api = getGroupAPI();
```

This mirrors the existing `linkContacts` pattern (`add-p2p-contact.ts` is imported the same way).

### 2.3 IDB cleanup

Each fuzz iteration boots a fresh `browser.newContext()` → fresh IndexedDB. `nostra-groups` is implicitly clean per-iteration. No teardown change needed.

### 2.4 Warmup

Groups piggyback on the existing 1059 gift-wrap subscription, which is warmed already by `warmupHandshake`. But control messages use the same kind with a **different rumor shape**, so we add one more warmup step:

```
A.createGroup(name, [B])
  → await B.groupStore.get(groupId) non-null within 10s
A.sendInGroup(groupId, "__warmup__")
  → await B bubble with text on group peer within 10s
A.leaveGroup(groupId)   // clean slate before fuzz actions
```

Failures in warmup are non-fatal — we log and continue, consistent with the existing `warmupHandshake` policy.

## 3. Action registry

| Name                      | Weight | Args                                                                 | Drive summary                                                                                                |
|---------------------------|--------|----------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| `createGroup`             | 4      | `{from: 'userA'\|'userB', name, withSynthetic: bool}`                | Call `getGroupAPI().createGroup(name, [otherPubkey, (syntheticPk?)])`. Store `groupId` in `action.meta`.     |
| `sendInGroup`             | 8      | `{from: 'userA'\|'userB', text}`                                     | Pick a random group from `from`'s `groupStore.getAll()`, call `getGroupAPI().sendMessage(groupId, text)`.    |
| `addMemberToGroup`        | 2      | `{admin: 'userA'\|'userB', target: 'peer'\|'synthetic'}`             | Admin adds either the other user (no-op if already present) or a fresh synthetic pubkey.                     |
| `removeMemberFromGroup`   | 2      | `{admin: 'userA'\|'userB', target: 'peer'\|'synthetic'}`             | Admin removes B or a random synthetic from a random group.                                                   |
| `leaveGroup`              | 1      | `{leaver: 'userA'\|'userB'}`                                         | Call `getGroupAPI().leaveGroup(groupId)` on a random group `leaver` is a member of.                          |

All actions follow the existing `messaging.ts` pattern: mark `action.skipped = true` when prerequisites aren't met (e.g. no groups exist yet), never throw. `action.meta` stores post-action observables for postconditions (groupId, messageId, target pubkey, …).

## 4. Invariants

| ID                                | Tier       | Check                                                                                                                              |
|-----------------------------------|------------|------------------------------------------------------------------------------------------------------------------------------------|
| `INV-group-peer-id-deterministic` | regression | For every group in either user's store: `groupIdToPeerId(groupId) === record.peerId`.                                              |
| `INV-group-admin-is-member`       | cheap      | For every group in every user's store: `record.members.includes(record.adminPubkey)`.                                              |
| `INV-group-store-has-unique-ids`  | medium     | `getAll()` returns groups with unique `groupId`s and unique `peerId`s (the secondary index enforces the latter, we assert the former). |
| `INV-group-bilateral-membership`  | medium     | If A has a group with B in members, B also has that group (by groupId) in its store and considers A a member.                      |
| `INV-group-no-orphan-peerid`      | regression | For every peer in `apiManagerProxy.mirrors.peers` whose id falls in the group-peer range, `groupStore.get(groupId)` returns non-null. |

Cheap tier runs every action. Medium runs every 10 actions (the existing `MEDIUM_EVERY`). Regression runs end-of-sequence and end-of-run.

## 5. Postconditions

| ID                                       | Trigger                    | Check                                                                                                                      |
|------------------------------------------|----------------------------|----------------------------------------------------------------------------------------------------------------------------|
| `POST-createGroup-record-exists`         | `createGroup`              | On sender: `groupStore.get(groupId)` non-null within 500ms. On peer member (B): non-null within 3s.                        |
| `POST-sendInGroup-bubble-on-sender`      | `sendInGroup`              | Sender sees a bubble with `text` in the group chat within 2.5s.                                                            |
| `POST-sendInGroup-bubble-on-peer`        | `sendInGroup`              | If the peer is a member of the group, peer sees the bubble within 3s.                                                      |
| `POST-addMember-member-in-store`         | `addMemberToGroup`         | The newly added member pubkey is in `groupStore.get(groupId).members` on the admin side immediately.                       |
| `POST-removeMember-member-gone-admin`    | `removeMemberFromGroup`    | Removed pubkey is NOT in `groupStore.get(groupId).members` on the admin side.                                              |
| `POST-removeMember-target-loses-group`   | `removeMemberFromGroup`    | When the target is a real user (B), B's `groupStore.get(groupId)` returns null within 3s.                                  |
| `POST-leaveGroup-record-gone-leaver`     | `leaveGroup`               | Leaver's `groupStore.get(groupId)` is null within 500ms.                                                                   |

All postconditions no-op on `action.skipped`. Timeouts match the existing patience budget (~3s for relay round-trips, 500ms for local store ops).

## 6. Harness changes

- `harness.ts`:
  - After `warmupHandshake`, call a new `warmupGroupsHandshake(userA, userB)` that performs the 3-step flow (createGroup → sendInGroup → leaveGroup) and awaits each ack.
  - Non-fatal on failure, per existing policy.
- No `ctx.users` type change.
- No teardown change.

## 7. Unit tests

One Vitest file per new invariant module, plus one per new action module:

- `src/tests/fuzz/invariants/groups.test.ts` — 5 invariants × 1 positive smoke + 1 negative each.
- `src/tests/fuzz/actions/groups.test.ts` — `generateArgs()` smoke; drive() is integration, not unit-tested.
- `src/tests/fuzz/postconditions/groups.test.ts` — 7 postconditions × 1 positive smoke each.

Added to the `pnpm test:nostra:quick` allowlist in `package.json`.

## 8. Fuzz loop & success gate

1. **Iter 1** — `pnpm fuzz --duration=30m` on the current implementation. Capture FINDs.
2. For each unique FIND (dedup signature): systematic debug → fix → commit.
3. **Iter 2** — `pnpm fuzz --duration=30m`. If still dirty, repeat up to 3 wave cap.
4. After 3 waves, if findings persist: document as carry-forward to 2b.5, ship the phase anyway (see memory: "Ship fuzz phase with carry-forward").
5. Clean pass (`findings === 0` at end-of-sequence and end-of-run for 30m at seed=42) → emit **baseline v2b4** to `src/tests/fuzz/baselines/v2b4.json` + commit.

## 9. Permanent regression tests

For every FIND fixed in Phase 2b.4, add a targeted tsx script in `src/tests/e2e/` following the `e2e-reactions-bilateral.ts` pattern — deterministic action flow + console-log dump + single-pass pass/fail. Rotation with `pnpm test:nostra:quick` is explicit-list only (see CLAUDE.md); update `package.json` `test:nostra:quick` to include new files.

## 10. Out of scope (Phase 2b.5 carry)

- Real 3rd browser context (`userC`) for true multi-party delivery.
- Group edit metadata (`group_info_update`) fuzz coverage.
- Admin transfer (`group_admin_transfer`) fuzz coverage.
- Group reactions (kind 7 targeting a group message).
- Group-message edits and deletions (kinds 5 + edit-rumor protocol inside groups).
- Group delivery-tracker per-member state invariant.
- Cross-reload group state rehydration (`INV-history-rehydrates-identical` over groups).

## 11. Success criteria

- All new invariants / postconditions unit-tested and green under `pnpm test:nostra:quick`.
- 30-minute clean fuzz pass at seed=42 (findings=0).
- Baseline v2b4 committed.
- All fuzz-discovered bugs have permanent E2E regression tests.
- Memory + CLAUDE.md updated to reflect Phase 2b.4 closure.
- Branch ready for PR but not pushed (user approval required on return).
