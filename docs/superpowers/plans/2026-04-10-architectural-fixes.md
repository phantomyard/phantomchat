# Architectural Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate 5 workarounds from the v2 bug-fix session by fixing root causes.

**Architecture:** Each fix is independent (except Fix 5 which depends on Fix 1). We add `getByEventId()` to message-store, an `isOwnEcho` branch in ChatAPI, `invalidateHistoryCache()` on appMessagesManager, a kind-0 fetch in the contact-add flow, and remove all `notDirect` flags from the context menu. Then clean up the workarounds.

**Tech Stack:** TypeScript, IndexedDB (message-store), Solid.js stores, Playwright E2E

---

### Task 1: Add `getByEventId()` to MessageStore

**Files:**
- Modify: `src/lib/nostra/message-store.ts`
- Test: `src/tests/nostra/message-store.test.ts` (if exists, else inline verification)

- [ ] **Step 1: Write the method**

In `src/lib/nostra/message-store.ts`, add after the `deleteByMid` method (around line 275):

```typescript
  /**
   * Look up a single message by its eventId.
   * Returns the stored message or null if not found.
   */
  async getByEventId(eventId: string): Promise<StoredMessage | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('eventId');
      const request = index.get(eventId);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? null);
    });
  }
```

- [ ] **Step 2: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit 2>&1 | grep "error TS" | wc -l`
Expected: 0 errors for both

- [ ] **Step 3: Commit**

```bash
git add src/lib/nostra/message-store.ts
git commit -m "feat(message-store): add getByEventId() for echo dedup lookup"
```

---

### Task 2: Self-echo dedup branch in ChatAPI

**Files:**
- Modify: `src/lib/nostra/chat-api.ts`

- [ ] **Step 1: Add the isOwnEcho branch**

In `src/lib/nostra/chat-api.ts`, inside `handleRelayMessage()`, add AFTER the group routing block (after the `catch` at line ~808 that says "Routing check failed") and BEFORE the auto-add unknown senders block (line ~811):

```typescript
      // ── Self-echo handling (multi-device ready) ──────────────────────
      // When our own message comes back from the relay, check whether this
      // device already has it (same-device echo → skip) or another device
      // sent it (cross-device sync → save as outgoing + render).
      if(msg.from === this.ownId) {
        try {
          // Parse content to get the app messageId (chat-XXX-N)
          let echoId = msg.id; // fallback to rumor ID
          try {
            const parsed = JSON.parse(msg.content);
            if(parsed.id) echoId = parsed.id;
          } catch{ /* not JSON, use msg.id */ }

          const store = getMessageStore();
          const existing = await store.getByEventId(echoId);
          if(existing) {
            this.log('[ChatAPI] own echo already in store, skipping:', echoId.slice(0, 12));
            return;
          }

          // Cross-device: message not in our store — save as outgoing
          // Determine the peer from the message's "to" field or tags
          const peerPubkey = msg.to || '';
          if(!peerPubkey) {
            this.log('[ChatAPI] own echo with no recipient, skipping');
            return;
          }

          const conversationId = store.getConversationId(this.ownId, peerPubkey);
          const parsed = (() => { try { return JSON.parse(msg.content); } catch{ return {content: msg.content}; } })();

          await store.saveMessage({
            eventId: echoId,
            conversationId,
            senderPubkey: this.ownId,
            content: parsed.content || msg.content,
            type: 'text',
            timestamp: msg.timestamp,
            deliveryState: 'sent',
            isOutgoing: true
          });

          // Fire callback so the bubble renders as is-out on this device
          if(this.onMessage) {
            this.onMessage({
              id: echoId,
              from: this.ownId,
              to: peerPubkey,
              type: 'text',
              content: parsed.content || msg.content,
              timestamp: msg.timestamp,
              status: 'sent',
              relayEventId: msg.id,
              isOutgoing: true
            } as any);
          }

          this.log('[ChatAPI] cross-device echo saved as outgoing:', echoId.slice(0, 12));
        } catch(err) {
          this.log.warn('[ChatAPI] self-echo handling failed:', err);
        }
        return;
      }
```

- [ ] **Step 2: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit 2>&1 | grep "error TS" | wc -l`
Expected: 0 errors

- [ ] **Step 3: Run unit tests**

Run: `npx vitest run src/tests/nostra/`
Expected: All pass (779+)

- [ ] **Step 4: Run E2E back-and-forth (dedup check)**

Run: `npx tsx src/tests/e2e/e2e-back-and-forth.ts 2>&1 | tail -3`
Expected: `8 passed, 0 failed out of 8`

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/chat-api.ts
git commit -m "fix(chat-api): self-echo dedup with multi-device outgoing sync"
```

---

### Task 3: Kind 0 fetch-on-contact-add

**Files:**
- Modify: `src/components/sidebarLeft/tabs/contacts.ts`

- [ ] **Step 1: Add fire-and-forget kind 0 fetch**

In `src/components/sidebarLeft/tabs/contacts.ts`, inside `handleNpubInput()`, add AFTER the `chatAPI.connect(hexPubkey)` block (after line ~252) and BEFORE the message-store init-message block (line ~254):

```typescript
      // Fire-and-forget kind 0 profile fetch — if the relay has a profile
      // for this pubkey, update the display name in the background.
      // The user-supplied nickname always takes priority (checked in updateMappingProfile).
      import('@lib/nostra/nostr-profile').then(async({fetchNostrProfile, profileToDisplayName}) => {
        const profile = await fetchNostrProfile(hexPubkey);
        if(!profile) return;
        const k0Name = profileToDisplayName(profile);
        if(!k0Name) return;

        // Persist in virtual-peers-db (respects existing nickname)
        const {updateMappingProfile} = await import('@lib/nostra/virtual-peers-db');
        await updateMappingProfile(hexPubkey, k0Name, profile);

        // Update Worker-side user object
        try {
          await rootScope.managers.appUsersManager.updateP2PUserName(peerId, k0Name);
        } catch{ /* non-critical */ }

        // Refresh main-thread peer mirror + Solid store
        if(proxyRef?.mirrors?.peers?.[peerId.toPeerId(false)]) {
          proxyRef.mirrors.peers[peerId.toPeerId(false)].first_name = k0Name;
          reconcilePeer(peerId.toPeerId(false), proxyRef.mirrors.peers[peerId.toPeerId(false)]);
        }

        // Refresh dialog so chat list subtitle updates
        rootScope.dispatchEvent('dialogs_multiupdate' as any, new Map([[peerId, {dialog}]]));
        console.log('[Nostra.chat] kind 0 profile applied:', k0Name, 'for', hexPubkey.slice(0, 8));
      }).catch(() => { /* non-critical: relay may be offline */ });
```

- [ ] **Step 2: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit 2>&1 | grep "error TS" | wc -l`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebarLeft/tabs/contacts.ts
git commit -m "feat(contacts): fire-and-forget kind 0 profile fetch on contact add"
```

---

### Task 4: Remove all `notDirect` from context menu

**Files:**
- Modify: `src/components/chat/contextMenu.ts`

- [ ] **Step 1: Remove the type field**

In `src/components/chat/contextMenu.ts`, at line 97, remove `notDirect?: () => boolean,` from the `ChatContextMenuButton` type:

Change:
```typescript
type ChatContextMenuButton = ButtonMenuItemOptions & {
  verify: () => boolean | Promise<boolean>,
  notDirect?: () => boolean,
  withSelection?: true,
  isSponsored?: true,
  localName?: 'views' | 'emojis' | 'sponsorInfo' | 'sponsorAdditionalInfo'
};
```

To:
```typescript
type ChatContextMenuButton = ButtonMenuItemOptions & {
  verify: () => boolean | Promise<boolean>,
  withSelection?: true,
  isSponsored?: true,
  localName?: 'views' | 'emojis' | 'sponsorInfo' | 'sponsorAdditionalInfo'
};
```

- [ ] **Step 2: Remove the invocation logic**

At line 525-527, change:

```typescript
        good = this.isOverBubble || IS_TOUCH_SUPPORTED || true ?
          await button.verify() :
          button.notDirect && await button.verify() && button.notDirect();
```

To:

```typescript
        good = await button.verify();
```

- [ ] **Step 3: Remove all 10 `notDirect: () => true` properties**

Delete the `notDirect: () => true,` line from each of these locations (use `replace_all` or manual edit). The property appears at lines 688, 713, 863, 981, 999, 1006, 1013, 1029, 1058, 1081.

Search and remove all occurrences of:
```
      notDirect: () => true,
```

(10 occurrences total)

- [ ] **Step 4: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit 2>&1 | grep "error TS" | wc -l`
Expected: 0 errors

- [ ] **Step 5: Run E2E context menu test**

Run: `npx tsx src/tests/e2e/e2e-context-menu.ts 2>&1 | tail -3`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/chat/contextMenu.ts
git commit -m "refactor(context-menu): remove all notDirect flags — all chats are Nostra"
```

---

### Task 5: Add `invalidateHistoryCache()` to appMessagesManager

**Files:**
- Modify: `src/lib/appManagers/appMessagesManager.ts`

- [ ] **Step 1: Add the public method**

In `src/lib/appManagers/appMessagesManager.ts`, add after `reloadConversation` (around line 4449):

```typescript
  /**
   * [Nostra.chat] Invalidate the Worker-side history cache for a peer.
   * Clears the SlicedArray so the next getHistory() call re-fetches via
   * the bridge instead of returning stale cached data.
   */
  public invalidateHistoryCache(peerId: PeerId) {
    const storage = this.historiesStorage[peerId];
    if(!storage) return;
    storage.history = new SlicedArray();
    storage.count = undefined;
  }
```

- [ ] **Step 2: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit 2>&1 | grep "error TS" | wc -l`
Expected: 0 errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/appManagers/appMessagesManager.ts
git commit -m "feat(messages-manager): add invalidateHistoryCache() for P2P cache reset"
```

---

### Task 6: Wire cache invalidation into P2P message flow

**Files:**
- Modify: `src/pages/nostra-onboarding-integration.ts`

- [ ] **Step 1: Add invalidateHistoryCache call in nostra_new_message handler**

In `src/pages/nostra-onboarding-integration.ts`, inside the `nostra_new_message` listener, add AFTER the mirror injection block (after `proxy.mirrors.messages[storageKey][msg.mid || msg.id] = msg`) and BEFORE the `history_append` dispatch:

```typescript
            // Invalidate the Worker's history cache for this peer so the next
            // getHistory() call re-fetches from the bridge. Without this, the
            // Worker returns stale SliceEnd.Both data after a chat is reopened.
            try {
              await rootScope.managers.appMessagesManager.invalidateHistoryCache(peerId);
            } catch{ /* non-critical: manager may not be ready yet */ }
```

- [ ] **Step 2: Remove `loadPersistedForPeer` and `hydratedPeers`**

In the same file, delete the following code blocks:
- The `hydratedPeers` Set declaration
- The entire `loadPersistedForPeer` async function
- The `setTimeout(() => { loadPersistedForPeer(...) }, 1500)` call inside the `peer_changed` handler

- [ ] **Step 3: Simplify triple dialogs_multiupdate to single dispatch**

In the `nostra_new_message` handler, replace:

```typescript
          const dispatchDialog = () => {
            rootScope.dispatchEvent('dialogs_multiupdate' as any, new Map([[
              peerId.toPeerId ? peerId.toPeerId(false) : peerId,
              {dialog}
            ]]));
          };
          dispatchDialog();
          // Second dispatch after the sortedList has mounted the dialog element
          setTimeout(dispatchDialog, 300);
          setTimeout(dispatchDialog, 1500);
```

With:

```typescript
          const dispatchDialog = () => {
            rootScope.dispatchEvent('dialogs_multiupdate' as any, new Map([[
              peerId.toPeerId ? peerId.toPeerId(false) : peerId,
              {dialog}
            ]]));
          };
          dispatchDialog();
          // Second dispatch after sortedList mounts the dialog element
          // (first dispatch adds it, second triggers setLastMessageN for preview)
          setTimeout(dispatchDialog, 500);
```

- [ ] **Step 4: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit 2>&1 | grep "error TS" | wc -l`
Expected: 0 errors

- [ ] **Step 5: Run core E2E tests**

Run each and verify:
```bash
npx tsx src/tests/e2e/e2e-bidirectional.ts 2>&1 | tail -3
# Expected: 7 passed, 0 failed out of 7

npx tsx src/tests/e2e/e2e-back-and-forth.ts 2>&1 | tail -3
# Expected: 8 passed, 0 failed out of 8

npx tsx src/tests/e2e/e2e-message-requests.ts 2>&1 | tail -3
# Expected: 5 passed, 0 failed out of 5
```

- [ ] **Step 6: Commit**

```bash
git add src/pages/nostra-onboarding-integration.ts
git commit -m "fix(onboarding): wire invalidateHistoryCache + remove loadPersistedForPeer workaround"
```

---

### Task 7: Clean up E2E test workarounds

**Files:**
- Modify: `src/tests/e2e/e2e-p2p-full.ts`
- Modify: `src/tests/e2e/e2e-reload-test.ts`
- Modify: `src/tests/e2e/e2e-stress-1to1.ts`
- Modify: `src/tests/e2e/e2e-final-batch.ts`
- Modify: `src/tests/e2e/e2e-deletion-and-extras.ts`
- Modify: `src/tests/e2e/e2e-batch2.ts`

- [ ] **Step 1: Remove message-store fallback from e2e-p2p-full.ts**

In the D2 persistence test section, replace the block that checks message-store as fallback:

```typescript
    // Fallback: if bubbles didn't render, check message-store as a persistence fallback
    if(!found) {
      found = await pageA.evaluate(async(marker: string) => {
        ...
      }, testMsg);
    }
```

With just:

```typescript
    // With invalidateHistoryCache, the Worker re-fetches from bridge on
    // chat reopen. Give extra time for the round-trip.
    if(!found) {
      found = await waitForBubble(pageA, testMsg, 15000);
    }
```

- [ ] **Step 2: Remove message-store fallback from e2e-reload-test.ts**

In the "Get bubbles AFTER reload" section, remove the block:

```typescript
  if(afterBubbles.length === 0) {
    const storeMsgs: any[] = await pageA.evaluate(async() => {
      ...
    });
    if(storeMsgs.length) afterBubbles = storeMsgs as any;
  }
```

Replace with extended bubble wait:

```typescript
  // With cache invalidation, bubbles render via normal Worker flow.
  // Give extra time for the bridge round-trip after reload.
  if(afterBubbles.length === 0) {
    await pageA.waitForTimeout(10000);
    afterBubbles = await getBubbles(pageA);
  }
```

- [ ] **Step 3: Same pattern for e2e-stress-1to1.ts and e2e-final-batch.ts**

Apply the same removal: replace message-store evaluate blocks with extended `waitForTimeout` + re-query bubbles from DOM.

- [ ] **Step 4: Update e2e-deletion-and-extras.ts and e2e-batch2.ts**

For deletion tests: now that the context menu shows Delete in 1:1 chats, update the fallback paths to attempt the right-click menu FIRST, falling back to store-level only if the menu doesn't appear (which should no longer happen).

- [ ] **Step 5: Run full E2E suite**

Run each test file and verify all pass:

```bash
for f in e2e-back-and-forth e2e-bidirectional e2e-message-requests e2e-contacts-and-sending e2e-p2p-full e2e-persistence-status e2e-reload-test e2e-relay-publish e2e-stress-1to1 e2e-context-menu e2e-deletion-and-extras e2e-batch2 e2e-batch3 e2e-final-batch e2e-remaining e2e-remaining-bugs; do
  echo "=== $f ==="
  npx tsx "src/tests/e2e/$f.ts" 2>&1 | tail -3
done
```

Expected: All pass (0 failed in each)

- [ ] **Step 6: Commit**

```bash
git add src/tests/e2e/
git commit -m "refactor(e2e): remove message-store fallbacks — Worker cache invalidation handles reload"
```

---

### Task 8: Final verification

- [ ] **Step 1: Lint clean**

Run: `pnpm lint`
Expected: 0 errors

- [ ] **Step 2: TSC clean**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | wc -l`
Expected: 0

- [ ] **Step 3: Unit tests**

Run: `npx vitest run src/tests/nostra/`
Expected: All pass

- [ ] **Step 4: Core E2E**

```bash
npx tsx src/tests/e2e/e2e-back-and-forth.ts 2>&1 | tail -3
npx tsx src/tests/e2e/e2e-bidirectional.ts 2>&1 | tail -3
npx tsx src/tests/e2e/e2e-message-requests.ts 2>&1 | tail -3
```

Expected: 8/8, 7/7, 5/5

- [ ] **Step 5: Verify no self-chat conversations**

Run a quick E2E check that after sending, no Alice:Alice conversation exists:

```bash
npx tsx -e "
import {chromium} from 'playwright';
const b = await chromium.launch({headless: true});
const ctx = await b.newContext();
const p = await ctx.newPage();
// ... create identity, add contact, send message, check store ...
// Verify: no conversation where both sides are ownPubkey
"
```

This can be a manual spot-check rather than a full scripted test.
