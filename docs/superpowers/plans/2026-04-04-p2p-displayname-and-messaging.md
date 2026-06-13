# P2P Display Names & Message Delivery Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two P2P bugs: (1) contacts show as "P2P XXXXXX" instead of their Nostr profile name/nickname, and (2) sent messages never reach the counterpart because the send bridge is never invoked.

**Architecture:** For display names, we fetch kind 0 metadata from relays and allow user-supplied nicknames, with npub truncation as fallback. For messaging, we intercept P2P sends on the main thread (in `input.ts`) and route through `sendTextViaChatAPI()` — the Worker stub continues to handle the local message creation while the main thread handles actual relay delivery.

**Tech Stack:** TypeScript, Solid.js, Nostr NIP-17 (gift-wrap), IndexedDB, WebSocket (relay protocol)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/nostra/nostr-profile.ts` | **Create** | Fetch kind 0 metadata from relays for a given pubkey |
| `src/lib/nostra/nostra-display-bridge.ts` | **Modify** | Use fetched profile + nickname for display name instead of hardcoded "P2P" prefix |
| `src/lib/nostra/virtual-peers-db.ts` | **Modify** | Add `nostrProfile` field to VirtualPeerMapping schema (DB v2 migration) |
| `src/components/nostra/AddContact.tsx` | **Modify** | Add optional nickname input field; pass nickname to storePeerMapping |
| `src/lib/appManagers/appUsersManager.ts` | **Modify** | Add `updateP2PUserName()` method to update display name after kind 0 fetch |
| `src/components/chat/input.ts` | **Modify** | After sendText call, detect P2P peer and route through send bridge |
| `src/lib/nostra/nostra-send-bridge.ts` | **Modify** | Export `isVirtualPeerSync` with VIRTUAL_PEER_BASE range check (no async needed) |

---

### Task 1: Create `nostr-profile.ts` — Fetch Kind 0 Metadata

**Files:**
- Create: `src/lib/nostra/nostr-profile.ts`

This module queries a Nostr relay for a pubkey's kind 0 profile (display_name, name, nip05, picture).

- [ ] **Step 1: Create the profile fetcher module**

```typescript
/**
 * Nostr Profile Fetcher
 *
 * Queries relays for kind 0 metadata events to resolve a pubkey's
 * display name, NIP-05, and avatar. Used when adding P2P contacts
 * to show meaningful names instead of truncated pubkeys.
 */

import {DEFAULT_RELAYS} from './nostr-relay-pool';

const LOG_PREFIX = '[NostrProfile]';

export interface NostrProfile {
  name?: string;
  display_name?: string;
  nip05?: string;
  picture?: string;
  about?: string;
}

/**
 * Fetch kind 0 profile metadata for a pubkey from relays.
 * Tries each relay in order, returns the first valid result.
 * Times out after 5 seconds per relay.
 *
 * @param pubkey - Hex pubkey to look up
 * @param relayUrls - Relay URLs to query (defaults to DEFAULT_RELAYS)
 * @returns Parsed profile or null if not found
 */
export async function fetchNostrProfile(
  pubkey: string,
  relayUrls?: string[]
): Promise<NostrProfile | null> {
  const relays = relayUrls ?? DEFAULT_RELAYS;

  for(const relayUrl of relays) {
    try {
      const profile = await queryRelayForProfile(relayUrl, pubkey);
      if(profile) {
        console.log(`${LOG_PREFIX} found profile for ${pubkey.slice(0, 8)}... on ${relayUrl}`);
        return profile;
      }
    } catch(err) {
      console.debug(`${LOG_PREFIX} relay ${relayUrl} failed:`, err);
    }
  }

  console.debug(`${LOG_PREFIX} no profile found for ${pubkey.slice(0, 8)}...`);
  return null;
}

/**
 * Derive the best display name from a Nostr profile.
 * Priority: display_name > name > nip05 > null
 */
export function profileToDisplayName(profile: NostrProfile | null): string | null {
  if(!profile) return null;
  if(profile.display_name?.trim()) return profile.display_name.trim();
  if(profile.name?.trim()) return profile.name.trim();
  if(profile.nip05?.trim()) return profile.nip05.trim();
  return null;
}

const QUERY_TIMEOUT_MS = 5000;

function queryRelayForProfile(relayUrl: string, pubkey: string): Promise<NostrProfile | null> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    const subId = 'profile-' + Math.random().toString(36).slice(2, 8);
    let resolved = false;

    const timeout = setTimeout(() => {
      if(!resolved) {
        resolved = true;
        try { ws.close(); } catch {}
        resolve(null);
      }
    }, QUERY_TIMEOUT_MS);

    try {
      ws = new WebSocket(relayUrl);
    } catch(err) {
      clearTimeout(timeout);
      reject(err);
      return;
    }

    ws.onopen = () => {
      // Send REQ for kind 0 from this pubkey, limit 1
      const filter = {kinds: [0], authors: [pubkey], limit: 1};
      ws.send(JSON.stringify(['REQ', subId, filter]));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if(msg[0] === 'EVENT' && msg[1] === subId && msg[2]) {
          const nostrEvent = msg[2];
          if(nostrEvent.kind === 0 && nostrEvent.content) {
            const profile = JSON.parse(nostrEvent.content) as NostrProfile;
            if(!resolved) {
              resolved = true;
              clearTimeout(timeout);
              ws.send(JSON.stringify(['CLOSE', subId]));
              ws.close();
              resolve(profile);
            }
          }
        } else if(msg[0] === 'EOSE' && msg[1] === subId) {
          // End of stored events — no profile found on this relay
          if(!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve(null);
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      if(!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`WebSocket error for ${relayUrl}`));
      }
    };

    ws.onclose = () => {
      if(!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
      }
    };
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `rtk npx tsc --noEmit --pretty src/lib/nostra/nostr-profile.ts 2>&1 | head -20`

Note: May show pre-existing errors from unrelated files. Only check for errors in `nostr-profile.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/nostra/nostr-profile.ts
git commit -m "feat: add nostr-profile.ts for fetching kind 0 metadata from relays"
```

---

### Task 2: Update `virtual-peers-db.ts` — Add `nostrProfile` Field

**Files:**
- Modify: `src/lib/nostra/virtual-peers-db.ts:14-23` (interface) and `:63-81` (storeMapping)

Add a `nostrProfile` optional field to persist fetched kind 0 data so we don't re-fetch on every page load.

- [ ] **Step 1: Update VirtualPeerMapping interface**

In `src/lib/nostra/virtual-peers-db.ts`, add the import and update the interface:

```typescript
import type {NostrProfile} from './nostr-profile';
```

Add after line 20 (`displayName?: string;`):

```typescript
  /** Cached Nostr kind 0 profile metadata */
  nostrProfile?: NostrProfile;
```

- [ ] **Step 2: Update `storeMapping` to accept nostrProfile**

Update the `storeMapping` function signature and the put call:

```typescript
export async function storeMapping(
  pubkey: string,
  peerId: number,
  displayName?: string,
  nostrProfile?: NostrProfile
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put({
      pubkey,
      peerId,
      displayName,
      nostrProfile,
      addedAt: Date.now()
    } satisfies VirtualPeerMapping);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}
```

- [ ] **Step 3: Add `updateMappingProfile` helper**

Add after `storeMapping`:

```typescript
/**
 * Update just the nostrProfile and displayName on an existing mapping.
 * Does a get-then-put to preserve other fields.
 */
export async function updateMappingProfile(
  pubkey: string,
  displayName: string,
  nostrProfile: NostrProfile
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(pubkey);
    getReq.onerror = () => reject(getReq.error);
    getReq.onsuccess = () => {
      const existing = getReq.result as VirtualPeerMapping | undefined;
      if(!existing) {
        resolve();
        return;
      }
      // Only update if no user-supplied nickname exists
      if(!existing.displayName) {
        existing.displayName = displayName;
      }
      existing.nostrProfile = nostrProfile;
      const putReq = store.put(existing);
      putReq.onerror = () => reject(putReq.error);
      putReq.onsuccess = () => resolve();
    };
  });
}
```

- [ ] **Step 4: Add `getMapping` helper**

Add after `updateMappingProfile`:

```typescript
/**
 * Get a single mapping by pubkey.
 */
export async function getMapping(pubkey: string): Promise<VirtualPeerMapping | undefined> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(pubkey);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/virtual-peers-db.ts
git commit -m "feat: add nostrProfile field to virtual-peers-db for cached kind 0 data"
```

---

### Task 3: Add `updateP2PUserName()` to `appUsersManager.ts`

**Files:**
- Modify: `src/lib/appManagers/appUsersManager.ts:757-783`

Add a method to update a P2P user's display name and re-mirror to the main thread.

- [ ] **Step 1: Add updateP2PUserName method**

Add after the `injectP2PUser` method (after line 783):

```typescript
  /**
   * Update display name for an existing P2P synthetic user.
   * Re-mirrors the user to main thread so the UI updates reactively.
   */
  public updateP2PUserName(peerId: number, displayName: string): void {
    const user = this.p2pSyntheticUsers.get(peerId);
    if(!user) {
      console.warn('[Nostra.chat] updateP2PUserName: no synthetic user for peerId', peerId);
      return;
    }

    user.first_name = displayName;
    this.users[peerId] = user;

    // Re-mirror to main thread so UI picks up the new name
    this.mirrorUser(user);

    console.log('[Nostra.chat] updateP2PUserName:', {peerId, displayName});
  }
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/appManagers/appUsersManager.ts
git commit -m "feat: add updateP2PUserName to update P2P contact names after profile fetch"
```

---

### Task 4: Update `deriveDisplayName` & Fetch Profile on Contact Add

**Files:**
- Modify: `src/lib/nostra/nostra-display-bridge.ts:421-451` (injectSyntheticPeer) and `:706-710` (deriveDisplayName)

- [ ] **Step 1: Update `deriveDisplayName` to accept optional profile/nickname**

Replace the `deriveDisplayName` method (lines 706-710):

```typescript
  /**
   * Derive display name from available sources.
   * Priority: nickname > profile.display_name > profile.name > nip05 > truncated pubkey
   */
  private deriveDisplayName(pubkey: string, nickname?: string, profile?: NostrProfile | null): string {
    if(nickname?.trim()) return nickname.trim();
    if(profile?.display_name?.trim()) return profile.display_name.trim();
    if(profile?.name?.trim()) return profile.name.trim();
    if(profile?.nip05?.trim()) return profile.nip05.trim();
    // Fallback: show npub-style truncation
    return 'P2P ' + pubkey.slice(0, 8);
  }
```

- [ ] **Step 2: Add import for nostr-profile at top of file**

After the existing imports (around line 22), add:

```typescript
import {fetchNostrProfile, type NostrProfile} from './nostr-profile';
import {getMapping, updateMappingProfile} from './virtual-peers-db';
```

- [ ] **Step 3: Update `injectSyntheticPeer` to use cached profile + async fetch**

Replace the `injectSyntheticPeer` method (lines 421-451):

```typescript
  private async injectSyntheticPeer(pubkey: string, peerId: number): Promise<void> {
    if(this.injectedPeers.has(peerId)) {
      return;
    }

    console.log(`${LOG_PREFIX} injecting synthetic peer:`, {peerId, pubkey: pubkey.slice(0, 8) + '...'});

    // Check IndexedDB for cached profile and nickname
    let nickname: string | undefined;
    let cachedProfile: NostrProfile | null = null;
    try {
      const mapping = await getMapping(pubkey);
      nickname = mapping?.displayName;
      cachedProfile = mapping?.nostrProfile ?? null;
    } catch(err) {
      console.debug(`${LOG_PREFIX} failed to read cached mapping:`, err);
    }

    // Derive display name from available data
    const displayName = this.deriveDisplayName(pubkey, nickname, cachedProfile);

    // Derive avatar gradient
    const avatar = this.bridge!.deriveAvatarFromPubkeySync(pubkey);

    // Create synthetic dialog
    const dialog = this.createSyntheticDialog(peerId);
    this.peerDialogs.set(peerId, dialog);
    this.injectedPeers.add(peerId);

    // Register dialog and user in Worker BEFORE dispatching to UI
    try {
      await (rootScope.managers.appUsersManager as any).injectP2PUser(pubkey, peerId, displayName, avatar);
      await (rootScope.managers as any).dialogsStorage.registerP2PDialog(dialog);
      console.log(`${LOG_PREFIX} P2P peer registered in Worker:`, {peerId, displayName});
    } catch(err) {
      console.warn(`${LOG_PREFIX} Worker registration failed:`, err);
    }

    // Now dispatch to chat list UI
    const peerIdValue: PeerId = peerId.toPeerId(false);
    rootScope.dispatchEvent('dialogs_multiupdate', new Map([[peerIdValue, {dialog}]]));

    // Async: fetch kind 0 profile from relays (don't block injection)
    if(!cachedProfile && !nickname) {
      this.fetchAndUpdateProfile(pubkey, peerId);
    }
  }

  /**
   * Fetch kind 0 profile from relays and update the display name.
   * Runs asynchronously after peer injection — does not block UI.
   */
  private async fetchAndUpdateProfile(pubkey: string, peerId: number): Promise<void> {
    try {
      const profile = await fetchNostrProfile(pubkey);
      if(!profile) return;

      const displayName = this.deriveDisplayName(pubkey, undefined, profile);
      // Skip update if it's still just the fallback
      if(displayName.startsWith('P2P ')) return;

      // Persist to IndexedDB
      await updateMappingProfile(pubkey, displayName, profile);

      // Update Worker-side user and re-mirror to main thread
      await (rootScope.managers.appUsersManager as any).updateP2PUserName(peerId, displayName);

      // Force UI refresh by re-dispatching dialog update
      const dialog = this.peerDialogs.get(peerId);
      if(dialog) {
        const peerIdValue: PeerId = peerId.toPeerId(false);
        rootScope.dispatchEvent('dialogs_multiupdate', new Map([[peerIdValue, {dialog}]]));
      }

      console.log(`${LOG_PREFIX} updated display name from kind 0:`, {peerId, displayName});
    } catch(err) {
      console.debug(`${LOG_PREFIX} fetchAndUpdateProfile failed for ${pubkey.slice(0, 8)}...:`, err);
    }
  }
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/nostra-display-bridge.ts
git commit -m "feat: resolve P2P display names from kind 0 profiles with nickname/npub fallback"
```

---

### Task 5: Add Nickname Field to `AddContact.tsx`

**Files:**
- Modify: `src/components/nostra/AddContact.tsx`

- [ ] **Step 1: Add nickname signal and pass to storePeerMapping**

Update the component to add a nickname input. Replace the full component:

Add a `nickname` signal after line 14 (`const [loading, setLoading] = ...`):

```typescript
  const [nickname, setNickname] = createSignal('');
```

Update the `addContact` function (inside the try block, lines 36-53) to pass the nickname:

```typescript
    try {
      const bridge = NostraBridge.getInstance();

      // Create synthetic user and store mapping
      const peerId = await bridge.mapPubkeyToPeerId(pubkeyHex);
      const userNickname = nickname().trim() || undefined;
      const user = bridge.createSyntheticUser(pubkeyHex, peerId, userNickname);
      await bridge.storePeerMapping(pubkeyHex, peerId, userNickname);

      // Close dialog
      props.onClose();

      // Navigate to chat with this peer
      try {
        const appImManager = (await import('@lib/appImManager')).default;
        appImManager.setPeer({peerId: peerId as any});
      } catch(navErr) {
        console.warn('Navigation to chat failed:', navErr);
      }
    } catch(err) {
      setError('Failed to add contact');
      setLoading(false);
    }
```

- [ ] **Step 2: Add nickname input field to the paste view**

In the paste view JSX (`<Show when={view() === 'paste'}>`), add a nickname input before the npub input (before the existing `<input type="text" ... placeholder="npub1..."`):

```tsx
      <Show when={view() === 'paste'}>
        <div class="nostra-add-contact-paste">
          <input
            type="text"
            class="nostra-add-contact-input"
            placeholder="Nickname (optional)"
            value={nickname()}
            onInput={(e) => {
              setNickname(e.currentTarget.value);
            }}
          />
          <input
            type="text"
            class="nostra-add-contact-input"
            placeholder="npub1... or hex pubkey"
            value={pasteValue()}
            onInput={(e) => {
              setPasteValue(e.currentTarget.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if(e.key === 'Enter') handlePasteSubmit();
            }}
          />
          <button
            class="nostra-add-contact-submit"
            onClick={handlePasteSubmit}
            disabled={loading()}
          >
            {loading() ? 'Adding...' : 'Add'}
          </button>
        </div>
      </Show>
```

- [ ] **Step 3: Commit**

```bash
git add src/components/nostra/AddContact.tsx
git commit -m "feat: add optional nickname field to AddContact dialog"
```

---

### Task 6: Wire P2P Message Sending in `input.ts`

**Files:**
- Modify: `src/components/chat/input.ts:3951-3961`

This is the critical fix: after the UI calls `sendText` (which creates the local message and hits the Worker stub), we also call `sendTextViaChatAPI` on the main thread to actually deliver via Nostr relays.

- [ ] **Step 1: Add import for send bridge at top of input.ts**

Find the imports section and add (near other nostra imports or at end of imports):

```typescript
import {isVirtualPeerSync, sendTextViaChatAPI} from '@lib/nostra/nostra-send-bridge';
```

Note: The import was previously commented out in `appMessagesManager.ts` because it runs in Worker context. But `input.ts` runs on the main thread where `window` is available, so this import is safe here.

- [ ] **Step 2: Add P2P send call after sendText**

In the `sendMessage` method, find the block (around line 3951-3961):

```typescript
    } else if(trimmedValue || this.suggestedPost?.hasMedia) {
      this.managers.appMessagesManager.sendText({
        ...sendingParams,
        text: value,
        entities,
        noWebPage,
        webPage: this.getWebPagePromise ? undefined : this.willSendWebPage,
        webPageOptions: this.webPageOptions,
        invertMedia: this.willSendWebPage ? this.invertMedia : undefined,
        clearDraft: true
      });
```

Replace with:

```typescript
    } else if(trimmedValue || this.suggestedPost?.hasMedia) {
      this.managers.appMessagesManager.sendText({
        ...sendingParams,
        text: value,
        entities,
        noWebPage,
        webPage: this.getWebPagePromise ? undefined : this.willSendWebPage,
        webPageOptions: this.webPageOptions,
        invertMedia: this.willSendWebPage ? this.invertMedia : undefined,
        clearDraft: true
      });

      // [Nostra.chat] Route P2P messages through ChatAPI on main thread
      // The Worker stub handles local message creation; this sends to Nostr relays
      const rawPeerId = this.chat.peerId.toUserId();
      if(isVirtualPeerSync(rawPeerId)) {
        sendTextViaChatAPI(rawPeerId, value).catch((err: any) => {
          console.error('[Nostra.chat] P2P send failed:', err);
        });
      }
```

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/input.ts
git commit -m "fix: route P2P messages through ChatAPI on main thread for actual delivery"
```

---

### Task 7: Ensure `isVirtualPeerSync` Uses Fast Range Check

**Files:**
- Modify: `src/lib/nostra/nostra-send-bridge.ts:134-141`

The current `isVirtualPeerSync` checks the LRU cache, which may be empty if the peer was added in a previous session. Add a range-based fallback using `VIRTUAL_PEER_BASE`.

- [ ] **Step 1: Add VIRTUAL_PEER_BASE import**

At the top of `nostra-send-bridge.ts`, update the import from nostra-bridge:

```typescript
import {NostraBridge, VIRTUAL_PEER_BASE} from './nostra-bridge';
```

- [ ] **Step 2: Update `isVirtualPeerSync` with range check fallback**

Replace the `isVirtualPeerSync` function (lines 134-141):

```typescript
export function isVirtualPeerSync(peerId: number): boolean {
  // Fast range check: virtual peers are >= VIRTUAL_PEER_BASE
  if(peerId >= Number(VIRTUAL_PEER_BASE)) {
    // Exclude group peers
    if(peerId >= GROUP_PEER_BASE) return false;
    return true;
  }
  return false;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/nostra/nostra-send-bridge.ts
git commit -m "fix: use VIRTUAL_PEER_BASE range check in isVirtualPeerSync for reliability"
```

---

### Task 8: E2E Manual Verification via Browser

**Files:** None (testing only)

- [ ] **Step 1: Start dev server**

Run: `pnpm start`

Open two browser tabs/profiles at `http://localhost:8080`

- [ ] **Step 2: Test contact addition with nickname**

In Tab A:
1. Click "New Private Chat"
2. Enter a nickname (e.g., "Alice")
3. Paste Tab B's npub
4. Click "Add"
5. **Verify:** Contact appears in chat list as "Alice", NOT "P2P XXXXXX"

- [ ] **Step 3: Test contact addition without nickname (kind 0 fallback)**

In Tab B:
1. Click "New Private Chat"
2. Leave nickname empty
3. Paste Tab A's npub
4. Click "Add"
5. **Verify:** Contact initially shows "P2P xxxxxxxx" then updates to the kind 0 display_name (if published) within ~5 seconds

- [ ] **Step 4: Test message delivery**

In Tab A:
1. Open the chat with Tab B's contact
2. Type "Hello from A" and send
3. **Verify in console:** `[NostraSendBridge] sending text to peerId=...` log appears
4. **Verify in Tab B:** Message "Hello from A" appears in the chat

In Tab B:
1. Reply with "Hello from B"
2. **Verify in Tab A:** Message "Hello from B" appears

- [ ] **Step 5: Test message persistence**

1. Refresh both tabs
2. **Verify:** Previous messages still appear in chat history
3. **Verify:** Contact names persist (nickname or kind 0 name, not "P2P XXXXXX")
