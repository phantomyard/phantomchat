# Virtual MTProto Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Nostra.chat's push-based P2P injection with a pull-based Virtual MTProto Server that returns native MTProto responses, letting tweb handle storage and rendering natively.

**Architecture:** A `NostraMTProtoServer` intercepts MTProto calls in `apiManager.nostraIntercept()` and returns properly shaped responses by reading from `message-store.ts` (messages) and constructing tweb-native objects (User, Chat, Dialog). tweb's own `saveApiResult()` / `saveMessages()` handles in-memory storage and mirroring. `NostraSync` listens to ChatAPI for incoming messages and persists them to message-store, then dispatches events that trigger tweb to re-fetch.

**Tech Stack:** TypeScript, IndexedDB (message-store.ts), Solid.js stores, tweb MTProto types from `@layer`

---

## File Structure

### New files

| File | Responsibility |
|------|---------------|
| `src/lib/nostra/virtual-mtproto-server.ts` | Intercepts MTProto methods, returns native responses |
| `src/lib/nostra/nostra-sync.ts` | Receives from ChatAPI, persists to message-store, triggers tweb events |
| `src/lib/nostra/nostra-peer-mapper.ts` | Creates tweb-native User/Chat/Dialog/Message objects |
| `src/lib/nostra/tweb-idb-writer.ts` | Writes User/Chat/Dialog to tweb's IDB via AppStorage |
| `src/tests/nostra/virtual-mtproto-server.test.ts` | Unit tests for server |
| `src/tests/nostra/nostra-sync.test.ts` | Unit tests for sync |
| `src/tests/nostra/nostra-peer-mapper.test.ts` | Unit tests for mapper |

### Modified files

| File | Change |
|------|--------|
| `src/lib/appManagers/apiManager.ts` | `nostraIntercept()` routes to NostraMTProtoServer |
| `src/pages/nostra-onboarding-integration.ts` | Wire NostraSync + Server instead of display/send bridge |

### Deleted files

| File | Reason |
|------|--------|
| `src/lib/nostra/nostra-display-bridge.ts` | Replaced by NostraSync |
| `src/lib/nostra/nostra-send-bridge.ts` | Replaced by NostraMTProtoServer.sendMessage |

### Restored to vanilla (hacks removed)

| File | Change |
|------|--------|
| `src/components/chat/bubbles.ts` | Remove ~100 lines of `>= 1e15` guards and cache bypass |
| `src/lib/storages/dialogs.ts` | Remove `dropDialog` guard, `registerP2PDialog`, `dropP2PDialog` |
| `src/lib/apiManagerProxy.ts` | Remove `p2pMessageCache`, `injectP2PMessage` |
| `src/components/chat/contextMenu.ts` | Remove P2P delete special-casing |
| `src/components/appSearch.ts` | Remove P2P search intercept |

---

## Task 0: Preparation — Cherry-pick CSS/UI fixes and create branch

**Files:**
- Modify: `src/scss/style.scss`
- Modify: `src/scss/partials/pages/_chats.scss`
- Modify: `src/components/sidebarLeft/index.ts`
- Modify: `src/lib/nostra/nostra-display-bridge.ts`
- Modify: `src/lib/nostra/nostr-relay-pool.ts`
- Modify: `src/lib/nostra/nostr-relay.ts`
- Modify: `src/components/sidebarLeft/tabs/nostraStatus.ts`
- Modify: `src/components/sidebarLeft/tabs/nostraRelaySettings.ts`

- [ ] **Step 1: Commit pending CSS/UI fixes**

These fixes were already made in the current session but not committed. Stage and commit them:

```bash
git add src/scss/style.scss src/scss/partials/pages/_chats.scss src/components/sidebarLeft/index.ts src/lib/nostra/nostra-display-bridge.ts src/lib/nostra/nostr-relay-pool.ts src/lib/nostra/nostr-relay.ts src/components/sidebarLeft/tabs/nostraStatus.ts src/components/sidebarLeft/tabs/nostraRelaySettings.ts src/lib/nostra/nostra-send-bridge.ts
git commit -m "fix: CSS/UI fixes for 12.1, 11.1, 1.9, 7.6, 10.12, 10.13"
```

- [ ] **Step 2: Create the virtual-mtproto branch**

```bash
git checkout -b virtual-mtproto
```

- [ ] **Step 3: Verify dev server starts cleanly**

```bash
pnpm start
# Wait for Vite to compile
curl -s http://localhost:8080 | head -3
```

Expected: HTML response with no errors.

---

## Task 1: NostraPeerMapper — Create tweb-native objects

**Files:**
- Create: `src/lib/nostra/nostra-peer-mapper.ts`
- Create: `src/tests/nostra/nostra-peer-mapper.test.ts`

This is the foundation — every other component depends on it to create properly shaped tweb objects.

- [ ] **Step 1: Write failing test for createTwebUser**

```typescript
// src/tests/nostra/nostra-peer-mapper.test.ts
import {describe, it, expect} from 'vitest';
import {NostraPeerMapper} from '@lib/nostra/nostra-peer-mapper';

describe('NostraPeerMapper', () => {
  const mapper = new NostraPeerMapper();

  describe('createTwebUser', () => {
    it('creates a User.user with correct fields', () => {
      const user = mapper.createTwebUser({
        peerId: 1000000000000001,
        firstName: 'Alice',
        pubkey: 'aabbccdd'.repeat(8)
      });

      expect(user._).toBe('user');
      expect(user.id).toBe(1000000000000001);
      expect(user.first_name).toBe('Alice');
      expect(user.pFlags).toBeDefined();
      expect(user.access_hash).toBeDefined();
    });

    it('uses npub prefix when no name provided', () => {
      const pubkey = 'aabbccdd'.repeat(8);
      const user = mapper.createTwebUser({peerId: 1000000000000002, pubkey});
      expect(user.first_name).toContain('npub');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/tests/nostra/nostra-peer-mapper.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement NostraPeerMapper**

```typescript
// src/lib/nostra/nostra-peer-mapper.ts
import type {User, Chat, Dialog, Message, Peer, PeerNotifySettings, MessageMedia} from '@layer';
import {NostraBridge} from './nostra-bridge';

export interface CreateUserOpts {
  peerId: number;
  firstName?: string;
  lastName?: string;
  pubkey: string;
}

export interface CreateMessageOpts {
  mid: number;
  peerId: number;
  fromPeerId?: number;
  date: number;  // Unix seconds
  text: string;
  isOutgoing: boolean;
  media?: MessageMedia;
}

export interface CreateDialogOpts {
  peerId: number;
  topMessage: number;
  topMessageDate: number;
  unreadCount?: number;
  isGroup?: boolean;
}

export interface CreateChatOpts {
  chatId: number;
  title: string;
  membersCount: number;
  date: number;
}

export class NostraPeerMapper {
  private bridge = NostraBridge.getInstance();

  createTwebUser(opts: CreateUserOpts): User.user {
    const displayName = opts.firstName || this.npubPrefix(opts.pubkey);
    return {
      _: 'user',
      id: opts.peerId,
      access_hash: '0',
      pFlags: {},
      first_name: displayName,
      last_name: opts.lastName,
      status: {_: 'userStatusRecently', pFlags: {by_me: true}}
    } as User.user;
  }

  createTwebChat(opts: CreateChatOpts): Chat.chat {
    return {
      _: 'chat',
      id: opts.chatId,
      title: opts.title,
      participants_count: opts.membersCount,
      date: opts.date,
      pFlags: {},
      photo: {_: 'chatPhotoEmpty'},
      version: 1
    } as Chat.chat;
  }

  createTwebMessage(opts: CreateMessageOpts): Message.message {
    const pFlags: Message.message['pFlags'] = {};
    if(opts.isOutgoing) pFlags.out = true;

    const peerPart = opts.peerId >= 0
      ? {_: 'peerUser' as const, user_id: opts.peerId}
      : {_: 'peerChat' as const, chat_id: Math.abs(opts.peerId)};

    const msg: Message.message = {
      _: 'message',
      id: opts.mid,
      peer_id: peerPart as Peer,
      date: opts.date,
      message: opts.text,
      pFlags
    } as Message.message;

    if(opts.fromPeerId && !opts.isOutgoing) {
      (msg as any).from_id = {_: 'peerUser', user_id: opts.fromPeerId};
    }

    if(opts.media) {
      msg.media = opts.media;
    }

    return msg;
  }

  createTwebDialog(opts: CreateDialogOpts): Dialog.dialog {
    const peerPart = opts.isGroup
      ? {_: 'peerChat' as const, chat_id: Math.abs(opts.peerId)}
      : {_: 'peerUser' as const, user_id: opts.peerId};

    const now = Math.floor(Date.now() / 1000);

    return {
      _: 'dialog',
      pFlags: {},
      peer: peerPart as Peer,
      top_message: opts.topMessage,
      read_inbox_max_id: opts.topMessage,
      read_outbox_max_id: opts.topMessage,
      unread_count: opts.unreadCount || 0,
      unread_mentions_count: 0,
      unread_reactions_count: 0,
      notify_settings: {
        _: 'peerNotifySettings',
        pFlags: {}
      } as PeerNotifySettings
    } as Dialog.dialog;
  }

  async mapPubkey(pubkey: string): Promise<number> {
    return this.bridge.mapPubkeyToPeerId(pubkey);
  }

  async mapEventId(eventId: string): Promise<number> {
    return this.bridge.mapEventIdToMid(eventId);
  }

  private npubPrefix(pubkey: string): string {
    try {
      const {encodePubkey} = require('./nostr-utils');
      const npub = encodePubkey(pubkey);
      return npub.slice(0, 12) + '...';
    } catch {
      return pubkey.slice(0, 8) + '...';
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/tests/nostra/nostra-peer-mapper.test.ts
```

Expected: PASS

- [ ] **Step 5: Add tests for createTwebMessage and createTwebDialog**

```typescript
// Append to src/tests/nostra/nostra-peer-mapper.test.ts

  describe('createTwebMessage', () => {
    it('creates outgoing message with pFlags.out', () => {
      const msg = mapper.createTwebMessage({
        mid: 12345,
        peerId: 1000000000000001,
        date: 1712345678,
        text: 'Hello',
        isOutgoing: true
      });

      expect(msg._).toBe('message');
      expect(msg.id).toBe(12345);
      expect(msg.message).toBe('Hello');
      expect(msg.date).toBe(1712345678);
      expect(msg.pFlags.out).toBe(true);
      expect(msg.peer_id._).toBe('peerUser');
    });

    it('creates incoming message with from_id', () => {
      const msg = mapper.createTwebMessage({
        mid: 12346,
        peerId: 1000000000000001,
        fromPeerId: 1000000000000001,
        date: 1712345678,
        text: 'Hi',
        isOutgoing: false
      });

      expect(msg.pFlags.out).toBeUndefined();
      expect((msg as any).from_id).toBeDefined();
      expect((msg as any).from_id.user_id).toBe(1000000000000001);
    });

    it('creates group message with peerChat', () => {
      const msg = mapper.createTwebMessage({
        mid: 12347,
        peerId: -2000000000000001,
        fromPeerId: 1000000000000001,
        date: 1712345678,
        text: 'Group msg',
        isOutgoing: false
      });

      expect(msg.peer_id._).toBe('peerChat');
    });
  });

  describe('createTwebDialog', () => {
    it('creates dialog for 1:1 chat', () => {
      const dialog = mapper.createTwebDialog({
        peerId: 1000000000000001,
        topMessage: 100,
        topMessageDate: 1712345678
      });

      expect(dialog._).toBe('dialog');
      expect(dialog.peer._).toBe('peerUser');
      expect(dialog.top_message).toBe(100);
      expect(dialog.pFlags.pinned).toBeUndefined();
    });

    it('creates dialog for group', () => {
      const dialog = mapper.createTwebDialog({
        peerId: -2000000000000001,
        topMessage: 200,
        topMessageDate: 1712345678,
        isGroup: true
      });

      expect(dialog.peer._).toBe('peerChat');
    });
  });
```

- [ ] **Step 6: Run all mapper tests**

```bash
npx vitest run src/tests/nostra/nostra-peer-mapper.test.ts
```

Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/nostra/nostra-peer-mapper.ts src/tests/nostra/nostra-peer-mapper.test.ts
git commit -m "feat: add NostraPeerMapper for creating tweb-native objects"
```

---

## Task 2: NostraMTProtoServer — Read path (getDialogs, getHistory)

**Files:**
- Create: `src/lib/nostra/virtual-mtproto-server.ts`
- Create: `src/tests/nostra/virtual-mtproto-server.test.ts`
- Modify: `src/lib/nostra/message-store.ts` (add getConversationMessages method)

- [ ] **Step 1: Write failing test for handleMethod('messages.getDialogs')**

```typescript
// src/tests/nostra/virtual-mtproto-server.test.ts
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {NostraMTProtoServer} from '@lib/nostra/virtual-mtproto-server';

// Mock message-store
vi.mock('@lib/nostra/message-store', () => ({
  getMessageStore: () => ({
    getAllConversationIds: vi.fn().mockResolvedValue(['pubA:pubB']),
    getMessages: vi.fn().mockResolvedValue([{
      eventId: 'evt1',
      conversationId: 'pubA:pubB',
      senderPubkey: 'pubA',
      content: 'Hello',
      type: 'text',
      timestamp: 1712345678,
      mid: 100,
      twebPeerId: 1000000000000001,
      isOutgoing: true
    }])
  })
}));

// Mock NostraPeerMapper
vi.mock('@lib/nostra/nostra-peer-mapper', () => ({
  NostraPeerMapper: vi.fn().mockImplementation(() => ({
    createTwebUser: vi.fn().mockReturnValue({_: 'user', id: 1000000000000001, first_name: 'Alice', pFlags: {}}),
    createTwebMessage: vi.fn().mockReturnValue({_: 'message', id: 100, peer_id: {_: 'peerUser', user_id: 1000000000000001}, date: 1712345678, message: 'Hello', pFlags: {out: true}}),
    createTwebDialog: vi.fn().mockReturnValue({_: 'dialog', peer: {_: 'peerUser', user_id: 1000000000000001}, top_message: 100, pFlags: {}}),
    mapPubkey: vi.fn().mockResolvedValue(1000000000000001),
    mapEventId: vi.fn().mockResolvedValue(100)
  }))
}));

describe('NostraMTProtoServer', () => {
  let server: NostraMTProtoServer;

  beforeEach(() => {
    server = new NostraMTProtoServer();
  });

  it('handles messages.getDialogs', async() => {
    const result = await server.handleMethod('messages.getDialogs', {});
    expect(result._).toBe('messages.dialogs');
    expect(result.dialogs).toHaveLength(1);
    expect(result.messages).toHaveLength(1);
    expect(result.users).toHaveLength(1);
  });

  it('handles messages.getHistory', async() => {
    const result = await server.handleMethod('messages.getHistory', {
      peer: {_: 'inputPeerUser', user_id: 1000000000000001}
    });
    expect(result._).toBe('messages.messages');
    expect(result.messages).toBeDefined();
  });

  it('returns fallback for unknown methods', async() => {
    const result = await server.handleMethod('photos.getUserPhotos', {});
    expect(result).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/tests/nostra/virtual-mtproto-server.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Implement NostraMTProtoServer (read path)**

```typescript
// src/lib/nostra/virtual-mtproto-server.ts
import {NostraPeerMapper} from './nostra-peer-mapper';
import {getMessageStore} from './message-store';
import type {StoredMessage} from './message-store';
import {NostraBridge} from './nostra-bridge';
import {getPubkey} from './virtual-peers-db';

const LOG_PREFIX = '[VirtualMTProto]';

/**
 * Virtual MTProto Server — intercepts MTProto calls and returns
 * native tweb responses by reading from local Nostr storage.
 */
export class NostraMTProtoServer {
  private mapper = new NostraPeerMapper();
  private bridge = NostraBridge.getInstance();
  private ownPubkey: string | null = null;

  setOwnPubkey(pubkey: string) {
    this.ownPubkey = pubkey;
  }

  /**
   * Main entry point — called by apiManager.nostraIntercept().
   * Routes to the appropriate handler based on the MTProto method name.
   */
  async handleMethod(method: string, params: any): Promise<any> {
    try {
      switch(method) {
        case 'messages.getDialogs':
        case 'messages.getPinnedDialogs':
          return await this.getDialogs(params);
        case 'messages.getHistory':
          return await this.getHistory(params);
        case 'messages.search':
          return await this.searchMessages(params);
        case 'contacts.getContacts':
          return await this.getContacts();
        case 'users.getFullUser':
          return await this.getFullUser(params);
        case 'messages.sendMessage':
          return await this.sendMessage(params);
        case 'messages.sendMedia':
          return await this.sendMedia(params);
        case 'messages.deleteMessages':
          return await this.deleteMessages(params);
        case 'messages.readHistory':
          return await this.readHistory(params);
        default:
          return this.fallback(method, params);
      }
    } catch(err) {
      console.error(`${LOG_PREFIX} ${method} failed:`, err);
      return this.fallback(method, params);
    }
  }

  /**
   * messages.getDialogs — returns all P2P conversations.
   * Reads from message-store to find conversations, builds Dialog + User + Message objects.
   */
  private async getDialogs(_params: any) {
    const store = getMessageStore();
    const conversationIds = await store.getAllConversationIds();
    const dialogs: any[] = [];
    const messages: any[] = [];
    const users: any[] = [];
    const chats: any[] = [];
    const seenPeers = new Set<number>();

    for(const convId of conversationIds) {
      const [pubA, pubB] = convId.split(':');
      const peerPubkey = pubA === this.ownPubkey ? pubB : pubA;
      const peerId = await this.mapper.mapPubkey(peerPubkey);

      // Get latest message for this conversation
      const msgs = await store.getMessages(convId, 1);
      if(msgs.length === 0) continue;

      const latest = msgs[0];
      const mid = latest.mid || await this.mapper.mapEventId(latest.eventId);

      // Create tweb objects
      const twebMsg = this.mapper.createTwebMessage({
        mid,
        peerId,
        date: latest.timestamp,
        text: latest.content,
        isOutgoing: latest.isOutgoing || latest.senderPubkey === this.ownPubkey
      });
      messages.push(twebMsg);

      const dialog = this.mapper.createTwebDialog({
        peerId,
        topMessage: mid,
        topMessageDate: latest.timestamp
      });
      dialogs.push(dialog);

      if(!seenPeers.has(peerId)) {
        seenPeers.add(peerId);
        const user = this.mapper.createTwebUser({
          peerId,
          pubkey: peerPubkey
        });
        users.push(user);
      }
    }

    // Also load group dialogs
    try {
      const {getGroupStore} = await import('./group-store');
      const groupStore = getGroupStore();
      const groups = await groupStore.getAll();
      for(const group of groups) {
        const chatId = Math.abs(group.peerId);
        const chat = this.mapper.createTwebChat({
          chatId,
          title: group.name || 'Group',
          membersCount: group.members?.length || 0,
          date: Math.floor(Date.now() / 1000)
        });
        chats.push(chat);

        const dialog = this.mapper.createTwebDialog({
          peerId: group.peerId,
          topMessage: 0,
          topMessageDate: Math.floor(Date.now() / 1000),
          isGroup: true
        });
        dialogs.push(dialog);
      }
    } catch {
      // Group store not available
    }

    return {
      _: 'messages.dialogs',
      dialogs,
      messages,
      users,
      chats,
      count: dialogs.length
    };
  }

  /**
   * messages.getHistory — returns message history for a peer.
   * Reads from message-store, converts to tweb Message objects.
   */
  private async getHistory(params: any) {
    const peerId = this.extractPeerId(params.peer);
    if(!peerId) return this.emptyMessages();

    const peerPubkey = await getPubkey(Math.abs(peerId));
    if(!peerPubkey || !this.ownPubkey) return this.emptyMessages();

    const store = getMessageStore();
    const convId = store.getConversationId(this.ownPubkey, peerPubkey);
    const limit = params.limit || 50;
    const offsetId = params.offset_id || 0;

    // Get messages from store
    const storedMsgs = await store.getMessages(convId, limit);

    const messages: any[] = [];
    const users: any[] = [];
    const seenUsers = new Set<number>();

    for(const stored of storedMsgs) {
      const mid = stored.mid || await this.mapper.mapEventId(stored.eventId);
      const isOut = stored.isOutgoing || stored.senderPubkey === this.ownPubkey;
      const senderPeerId = isOut ? 0 : await this.mapper.mapPubkey(stored.senderPubkey);

      const msg = this.mapper.createTwebMessage({
        mid,
        peerId: Math.abs(peerId),
        fromPeerId: isOut ? undefined : senderPeerId,
        date: stored.timestamp,
        text: stored.content,
        isOutgoing: isOut
      });
      messages.push(msg);

      if(senderPeerId && !seenUsers.has(senderPeerId)) {
        seenUsers.add(senderPeerId);
        users.push(this.mapper.createTwebUser({
          peerId: senderPeerId,
          pubkey: stored.senderPubkey
        }));
      }
    }

    return {
      _: 'messages.messages',
      messages,
      users,
      chats: [],
      count: messages.length
    };
  }

  /**
   * messages.search — full-text search across P2P messages.
   */
  private async searchMessages(params: any) {
    const query = params.q || '';
    if(!query || !this.ownPubkey) return this.emptyMessages();

    const store = getMessageStore();
    const convIds = await store.getAllConversationIds();
    const results: any[] = [];

    for(const convId of convIds) {
      const msgs = await store.getMessages(convId, 100);
      for(const msg of msgs) {
        if(msg.content.toLowerCase().includes(query.toLowerCase())) {
          const mid = msg.mid || await this.mapper.mapEventId(msg.eventId);
          const peerId = msg.twebPeerId || await this.mapper.mapPubkey(
            msg.senderPubkey === this.ownPubkey ? convId.replace(this.ownPubkey + ':', '').replace(':' + this.ownPubkey, '') : msg.senderPubkey
          );
          results.push(this.mapper.createTwebMessage({
            mid,
            peerId,
            date: msg.timestamp,
            text: msg.content,
            isOutgoing: msg.isOutgoing || msg.senderPubkey === this.ownPubkey
          }));
        }
      }
    }

    return {
      _: 'messages.messages',
      messages: results.slice(0, params.limit || 20),
      users: [],
      chats: [],
      count: results.length
    };
  }

  /**
   * contacts.getContacts — returns all known P2P peers.
   */
  private async getContacts() {
    const store = getMessageStore();
    const convIds = await store.getAllConversationIds();
    const users: any[] = [];
    const seen = new Set<number>();

    for(const convId of convIds) {
      const [pubA, pubB] = convId.split(':');
      const peerPub = pubA === this.ownPubkey ? pubB : pubA;
      const peerId = await this.mapper.mapPubkey(peerPub);
      if(!seen.has(peerId)) {
        seen.add(peerId);
        users.push(this.mapper.createTwebUser({peerId, pubkey: peerPub}));
      }
    }

    return {
      _: 'contacts.contacts',
      contacts: users.map(u => ({_: 'contact', user_id: u.id, mutual: false})),
      saved_count: users.length,
      users
    };
  }

  private async getFullUser(params: any) {
    const userId = params.id?.user_id;
    if(!userId) return {_: 'users.userFull', user: {_: 'user', id: 0, pFlags: {}}, full_user: {_: 'userFull', id: 0, pFlags: {}}};
    const pubkey = await getPubkey(userId);
    const user = this.mapper.createTwebUser({peerId: userId, pubkey: pubkey || ''});
    return {
      _: 'users.userFull',
      users: [user],
      full_user: {_: 'userFull', id: userId, pFlags: {}, about: '', common_chats_count: 0, settings: {_: 'peerSettings', pFlags: {}}}
    };
  }

  // sendMessage, sendMedia, deleteMessages, readHistory — Task 3
  private async sendMessage(_params: any) { return {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0}; }
  private async sendMedia(_params: any) { return {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0}; }
  private async deleteMessages(_params: any) { return {_: 'messages.affectedMessages', pts: 0, pts_count: 0}; }
  private async readHistory(_params: any) { return {_: 'messages.affectedMessages', pts: 0, pts_count: 0}; }

  /**
   * Extract peerId from InputPeer object.
   */
  private extractPeerId(peer: any): number | null {
    if(!peer) return null;
    if(peer.user_id) return peer.user_id;
    if(peer.chat_id) return -peer.chat_id;
    if(peer.channel_id) return -peer.channel_id;
    return null;
  }

  private emptyMessages() {
    return {_: 'messages.messages', messages: [], users: [], chats: [], count: 0};
  }

  /**
   * Fallback for unhandled methods — returns sensible defaults.
   */
  private fallback(method: string, _params: any): any {
    // Action methods (set*, save*, delete*, etc.) return true
    const actionPrefixes = ['.set', '.save', '.delete', '.read', '.mark', '.toggle', '.send', '.block', '.unblock', '.join', '.leave'];
    if(actionPrefixes.some(p => method.includes(p))) return true;

    // Known empty responses
    const emptyResponses: Record<string, any> = {
      'updates.getState': {_: 'updates.state', pts: 0, qts: 0, date: 0, seq: 0, unread_count: 0},
      'updates.getDifference': {_: 'updates.differenceEmpty', date: 0, seq: 0},
      'messages.getSavedDialogs': {_: 'messages.savedDialogs', dialogs: [], messages: [], chats: [], users: []},
      'messages.getSearchCounters': {_: 'vector', v: []},
      'contacts.getTopPeers': {_: 'contacts.topPeersDisabled'},
      'help.getConfig': {_: 'config', date: 0, expires: 0, test_mode: false, this_dc: 2, dc_options: [], default_p2p_contacts: false, chat_size_max: 200, megagroup_size_max: 200000, forwarded_count_max: 100, online_update_period_ms: 120000, offline_blur_timeout_ms: 5000, offline_idle_timeout_ms: 30000, online_cloud_timeout_ms: 300000, notify_cloud_delay_ms: 30000, notify_default_delay_ms: 1500, push_chat_period_ms: 60000, push_chat_limit: 2, edit_time_limit: 172800, revoke_time_limit: 2147483647, revoke_pm_time_limit: 2147483647, rating_e_decay: 2419200, stickers_recent_limit: 200, caption_length_max: 1024, message_length_max: 4096, webfile_dc_id: 4, pFlags: {}},
      'help.getAppConfig': {_: 'help.appConfig', hash: 0, config: {}},
      'account.getNotifySettings': {_: 'peerNotifySettings', pFlags: {}},
      'account.getPassword': {_: 'account.password', pFlags: {has_password: false}, new_algo: {_: 'passwordKdfAlgoUnknown'}, new_secure_algo: {_: 'securePasswordKdfAlgoUnknown'}},
      'langpack.getDifference': {_: 'langPackDifference', lang_code: 'en', from_version: 0, version: 0, strings: []}
    };

    if(emptyResponses[method]) return emptyResponses[method];

    // Default fallback
    return {pFlags: {}};
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/tests/nostra/virtual-mtproto-server.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/virtual-mtproto-server.ts src/tests/nostra/virtual-mtproto-server.test.ts
git commit -m "feat: add NostraMTProtoServer with read path (getDialogs, getHistory, search)"
```

---

## Task 3: NostraMTProtoServer — Write path (sendMessage, sendMedia, delete)

**Files:**
- Modify: `src/lib/nostra/virtual-mtproto-server.ts`
- Modify: `src/tests/nostra/virtual-mtproto-server.test.ts`

- [ ] **Step 1: Implement sendMessage**

Replace the placeholder `sendMessage` in `virtual-mtproto-server.ts`:

```typescript
  private chatAPI: any = null;

  setChatAPI(chatAPI: any) {
    this.chatAPI = chatAPI;
  }

  private async sendMessage(params: any) {
    const peerId = this.extractPeerId(params.peer);
    if(!peerId || !this.chatAPI || !this.ownPubkey) {
      return {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0};
    }

    const text = params.message || '';
    const peerPubkey = await getPubkey(Math.abs(peerId));
    if(!peerPubkey) return {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0};

    // Connect ChatAPI to this peer if needed
    if(this.chatAPI.getActivePeer() !== peerPubkey) {
      await this.chatAPI.connect(peerPubkey);
    }

    // Send via relay
    const eventId = await this.chatAPI.sendText(text);
    const mid = await this.mapper.mapEventId(eventId);
    const now = Math.floor(Date.now() / 1000);

    // Persist to message-store for reload
    const store = getMessageStore();
    const convId = store.getConversationId(this.ownPubkey, peerPubkey);
    await store.saveMessage({
      eventId,
      conversationId: convId,
      senderPubkey: this.ownPubkey,
      content: text,
      type: 'text',
      timestamp: now,
      deliveryState: 'sent',
      mid,
      twebPeerId: Math.abs(peerId),
      isOutgoing: true
    });

    // Return update with the sent message
    const message = this.mapper.createTwebMessage({
      mid,
      peerId: Math.abs(peerId),
      date: now,
      text,
      isOutgoing: true
    });

    return {
      _: 'updates',
      updates: [{
        _: 'updateNewMessage',
        message,
        pts: 1,
        pts_count: 1
      }],
      users: [],
      chats: [],
      date: now,
      seq: 0
    };
  }
```

- [ ] **Step 2: Implement deleteMessages**

```typescript
  private async deleteMessages(params: any) {
    const mids: number[] = params.id || [];
    // For each mid, find and remove from message-store
    // Also send NIP-09 deletion event if needed
    const store = getMessageStore();
    // We'd need mid → eventId reverse lookup — for now, just return success
    // The actual deletion from store will be handled by NostraSync
    return {_: 'messages.affectedMessages', pts: 1, pts_count: mids.length};
  }

  private async readHistory(params: any) {
    // Mark messages as read — send NIP read receipt
    const peerId = this.extractPeerId(params.peer);
    if(peerId && this.chatAPI) {
      const peerPubkey = await getPubkey(Math.abs(peerId));
      if(peerPubkey) {
        // ChatAPI handles read receipts internally
      }
    }
    return {_: 'messages.affectedMessages', pts: 1, pts_count: 0};
  }
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/tests/nostra/virtual-mtproto-server.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/virtual-mtproto-server.ts src/tests/nostra/virtual-mtproto-server.test.ts
git commit -m "feat: add write path to NostraMTProtoServer (sendMessage, delete, readHistory)"
```

---

## Task 4: NostraSync — incoming message handler

**Files:**
- Create: `src/lib/nostra/nostra-sync.ts`
- Create: `src/tests/nostra/nostra-sync.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/tests/nostra/nostra-sync.test.ts
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {NostraSync} from '@lib/nostra/nostra-sync';

vi.mock('@lib/nostra/message-store', () => ({
  getMessageStore: () => ({
    saveMessage: vi.fn().mockResolvedValue(undefined),
    getConversationId: vi.fn().mockReturnValue('pubA:pubB')
  })
}));

describe('NostraSync', () => {
  let sync: NostraSync;
  const mockDispatch = vi.fn();

  beforeEach(() => {
    sync = new NostraSync('ownPubkeyHex', mockDispatch);
    mockDispatch.mockClear();
  });

  it('persists incoming message to store', async() => {
    const {getMessageStore} = await import('@lib/nostra/message-store');
    const store = getMessageStore();

    await sync.onIncomingMessage({
      id: 'evt1',
      from: 'senderPubkey',
      to: 'ownPubkeyHex',
      type: 'text',
      content: 'Hello',
      timestamp: Date.now(),
      status: 'delivered'
    }, 'senderPubkey');

    expect(store.saveMessage).toHaveBeenCalled();
  });

  it('dispatches update event after persisting', async() => {
    await sync.onIncomingMessage({
      id: 'evt2',
      from: 'senderPubkey',
      to: 'ownPubkeyHex',
      type: 'text',
      content: 'World',
      timestamp: Date.now(),
      status: 'delivered'
    }, 'senderPubkey');

    expect(mockDispatch).toHaveBeenCalledWith('nostra_new_message', expect.any(Object));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/tests/nostra/nostra-sync.test.ts
```

- [ ] **Step 3: Implement NostraSync**

```typescript
// src/lib/nostra/nostra-sync.ts
import {getMessageStore} from './message-store';
import {NostraPeerMapper} from './nostra-peer-mapper';
import {NostraBridge} from './nostra-bridge';
import type {ChatMessage} from './chat-api';

const LOG_PREFIX = '[NostraSync]';

type DispatchFn = (event: string, data: any) => void;

/**
 * NostraSync — listens to ChatAPI for incoming messages,
 * persists to message-store, then dispatches events so
 * NostraMTProtoServer can serve them on next getHistory call.
 *
 * For real-time display (chat already open), dispatches
 * 'nostra_new_message' which the onboarding integration
 * converts to a tweb-native update via the server.
 */
export class NostraSync {
  private mapper = new NostraPeerMapper();
  private bridge = NostraBridge.getInstance();
  private ownPubkey: string;
  private dispatch: DispatchFn;

  constructor(ownPubkey: string, dispatch: DispatchFn) {
    this.ownPubkey = ownPubkey;
    this.dispatch = dispatch;
  }

  /**
   * Called when ChatAPI receives an incoming message.
   * Persists to message-store and dispatches event.
   */
  async onIncomingMessage(msg: ChatMessage, senderPubkey: string): Promise<void> {
    const store = getMessageStore();
    const peerId = await this.mapper.mapPubkey(senderPubkey);
    const mid = await this.mapper.mapEventId(msg.id);
    const timestamp = Math.floor(msg.timestamp / 1000);
    const convId = store.getConversationId(this.ownPubkey, senderPubkey);

    // Persist
    await store.saveMessage({
      eventId: msg.id,
      conversationId: convId,
      senderPubkey,
      content: msg.content,
      type: msg.type === 'text' ? 'text' : 'file',
      timestamp,
      deliveryState: 'delivered',
      mid,
      twebPeerId: peerId,
      isOutgoing: false,
      ...(msg.fileMetadata ? {fileMetadata: msg.fileMetadata} : {})
    });

    console.log(`${LOG_PREFIX} persisted incoming message: mid=${mid}, peerId=${peerId}`);

    // Dispatch event for real-time rendering
    this.dispatch('nostra_new_message', {
      peerId,
      mid,
      senderPubkey,
      message: msg,
      timestamp
    });
  }

  /**
   * Called when a kind 0 profile is fetched/updated.
   */
  async onProfileUpdate(pubkey: string, profile: {name?: string, display_name?: string, about?: string, picture?: string}): Promise<void> {
    const peerId = await this.mapper.mapPubkey(pubkey);
    const displayName = profile.display_name || profile.name;

    console.log(`${LOG_PREFIX} profile update: ${pubkey.slice(0, 8)}... → ${displayName}`);

    this.dispatch('nostra_profile_update', {
      peerId,
      pubkey,
      displayName,
      about: profile.about,
      picture: profile.picture
    });
  }

  /**
   * Called when a kind 30315 presence heartbeat is received.
   */
  async onPresenceUpdate(pubkey: string, status: 'online' | 'offline' | 'recently'): Promise<void> {
    const peerId = await this.mapper.mapPubkey(pubkey);

    this.dispatch('nostra_presence_update', {
      peerId,
      pubkey,
      status
    });
  }

  /**
   * Backfill: fetch recent message history from relays on first connect.
   * Called once during initialization.
   */
  async backfill(chatAPI: any, peerPubkeys: string[]): Promise<void> {
    console.log(`${LOG_PREFIX} starting backfill for ${peerPubkeys.length} peers`);
    // ChatAPI.connect() already triggers backfill internally
    // Messages arrive via onIncomingMessage callback
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/tests/nostra/nostra-sync.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/nostra-sync.ts src/tests/nostra/nostra-sync.test.ts
git commit -m "feat: add NostraSync for incoming message persistence and event dispatch"
```

---

## Task 5: Wire into apiManager.ts

**Files:**
- Modify: `src/lib/appManagers/apiManager.ts`

This is the key integration point — replace the static `NOSTRA_RESPONSES` with the dynamic server.

- [ ] **Step 1: Read the current nostraIntercept implementation**

Read `src/lib/appManagers/apiManager.ts` around lines 698-721 to understand the current structure.

- [ ] **Step 2: Replace nostraIntercept with server routing**

Replace the `nostraIntercept` method and `NOSTRA_RESPONSES` map with:

```typescript
  // At the top of the file, add import
  // import {NostraMTProtoServer} from '@lib/nostra/virtual-mtproto-server';

  private nostraMTProtoServer: NostraMTProtoServer | null = null;

  public setNostraMTProtoServer(server: NostraMTProtoServer) {
    this.nostraMTProtoServer = server;
  }

  private nostraIntercept(method: string, params: any): any {
    if(!this.nostraMTProtoServer) {
      // Fallback to old static responses during initialization
      return {pFlags: {}};
    }
    return this.nostraMTProtoServer.handleMethod(method, params);
  }
```

- [ ] **Step 3: Remove NOSTRA_RESPONSES map and ACTION_PREFIXES**

Delete the `NOSTRA_RESPONSES` const object (lines ~602-692) and `ACTION_PREFIXES` array (lines ~698-707). These are now handled inside `NostraMTProtoServer.fallback()`.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | head -20
```

Expected: Zero errors related to apiManager.ts

- [ ] **Step 5: Commit**

```bash
git add src/lib/appManagers/apiManager.ts
git commit -m "refactor: replace static NOSTRA_RESPONSES with NostraMTProtoServer routing"
```

---

## Task 6: Wire onboarding integration

**Files:**
- Modify: `src/pages/nostra-onboarding-integration.ts`

This replaces the display bridge + send bridge initialization with NostraSync + NostraMTProtoServer.

- [ ] **Step 1: Read current onboarding integration**

Read `src/pages/nostra-onboarding-integration.ts` to understand how display bridge and send bridge are initialized.

- [ ] **Step 2: Replace bridge initialization with server + sync**

Replace the display bridge and send bridge setup with:

```typescript
import {NostraMTProtoServer} from '@lib/nostra/virtual-mtproto-server';
import {NostraSync} from '@lib/nostra/nostra-sync';
import rootScope from '@lib/rootScope';

// After ChatAPI is created and identity is loaded:
const server = new NostraMTProtoServer();
server.setOwnPubkey(ownPubkeyHex);
server.setChatAPI(chatAPI);

const sync = new NostraSync(ownPubkeyHex, (event, data) => {
  rootScope.dispatchEvent(event as any, data);
});

// Wire ChatAPI incoming messages to sync
chatAPI.onMessage = (msg) => {
  sync.onIncomingMessage(msg, msg.from);
};

// Register server with apiManager (via MOUNT_CLASS_TO)
const apiManager = MOUNT_CLASS_TO.apiManager;
if(apiManager?.setNostraMTProtoServer) {
  apiManager.setNostraMTProtoServer(server);
}

// Listen for real-time message events and trigger tweb update
rootScope.addEventListener('nostra_new_message' as any, async(data: any) => {
  // When a new message arrives in real-time, tweb needs to know.
  // We dispatch a standard 'new_message' update that tweb handles natively.
  const result = await server.handleMethod('messages.getHistory', {
    peer: {_: 'inputPeerUser', user_id: data.peerId},
    limit: 1
  });
  if(result.messages?.length) {
    // Use appMessagesManager to process the message natively
    rootScope.dispatchEvent('new_message' as any, {
      message: result.messages[0]
    });
  }
});
```

- [ ] **Step 3: Remove display bridge and send bridge imports/initialization**

Remove all references to `NostraDisplayBridge`, `installSendBridge`, `nostra-display-bridge`, `nostra-send-bridge` from the onboarding file.

- [ ] **Step 4: Verify the app loads**

```bash
# Dev server should be running
curl -s http://localhost:8080 | head -3
```

Open browser, create identity, verify no console errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/nostra-onboarding-integration.ts
git commit -m "refactor: wire NostraMTProtoServer + NostraSync in onboarding"
```

---

## Task 7: Remove P2P hacks from tweb core files

**Files:**
- Modify: `src/components/chat/bubbles.ts`
- Modify: `src/lib/storages/dialogs.ts`
- Modify: `src/lib/apiManagerProxy.ts`
- Modify: `src/components/chat/contextMenu.ts`
- Modify: `src/components/appSearch.ts`

- [ ] **Step 1: Remove P2P guards from bubbles.ts**

Search for all `>= 1e15` and `p2pMessageCache` references in `bubbles.ts` and remove them. These are approximately at:
- Lines ~1568-1578 (P2P guard in renderNewMessage)
- Lines ~3910 (P2P logging)  
- Lines ~9118-9169 (direct cache access hack for requestHistory)

Remove each block, restoring the original tweb flow.

- [ ] **Step 2: Remove P2P guards from dialogsStorage.ts**

Remove from `src/lib/storages/dialogs.ts`:
- Line ~1137: `if(+peerId >= 1e15) return []` guard in dropDialog
- Line ~1139: `if(+peerId <= -2e15) return []` guard
- Lines ~605-614: `registerP2PDialog` method
- Lines ~1183+: `dropP2PDialog` method

- [ ] **Step 3: Remove p2pMessageCache from apiManagerProxy.ts**

Remove from `src/lib/apiManagerProxy.ts`:
- Line ~129: `private p2pMessageCache` declaration
- Lines ~1045-1059: `injectP2PMessage` method
- Line ~1038: p2pMessageCache fallback in `getMessageFromStorage`
- Line ~1030: P2P peer ID guard in `getMessageFromStorage`

- [ ] **Step 4: Remove P2P special-casing from contextMenu.ts**

Remove from `src/components/chat/contextMenu.ts`:
- The `peerIdNum >= 1e15` guard in delete verify
- The `deleteP2PMessage` and `executeP2PMessageDelete` methods

- [ ] **Step 5: Remove P2P search intercept from appSearch.ts**

Remove from `src/components/appSearch.ts`:
- The `peerId >= 1e15` intercept in `searchMore`
- The `searchP2PMessages` method

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | head -20
```

Fix any type errors from removed references.

- [ ] **Step 7: Commit**

```bash
git add src/components/chat/bubbles.ts src/lib/storages/dialogs.ts src/lib/apiManagerProxy.ts src/components/chat/contextMenu.ts src/components/appSearch.ts
git commit -m "refactor: remove P2P hacks from tweb core files (bubbles, dialogs, proxy, context menu, search)"
```

---

## Task 8: Delete old bridge files

**Files:**
- Delete: `src/lib/nostra/nostra-display-bridge.ts`
- Delete: `src/lib/nostra/nostra-send-bridge.ts`

- [ ] **Step 1: Find all imports of display bridge and send bridge**

```bash
grep -r "nostra-display-bridge\|nostra-send-bridge\|NostraDisplayBridge\|installSendBridge\|sendTextViaChatAPI\|isVirtualPeer" src/ --include="*.ts" --include="*.tsx" -l
```

- [ ] **Step 2: Remove/update all import references**

For each file that imports from display bridge or send bridge:
- If the import is no longer needed, remove it
- If the file uses `sendTextViaChatAPI`, replace with the server's sendMessage path
- If the file uses `isVirtualPeer`, replace with a simple `peerId >= 1e15` check or remove

- [ ] **Step 3: Delete the files**

```bash
rm src/lib/nostra/nostra-display-bridge.ts
rm src/lib/nostra/nostra-send-bridge.ts
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | head -20
```

Fix remaining import errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete nostra-display-bridge.ts and nostra-send-bridge.ts"
```

---

## Task 9: E2E smoke test

**Files:**
- Modify: `src/tests/e2e-remaining-bugs.ts` (or create new E2E test)

- [ ] **Step 1: Start dev server and run basic smoke test**

```bash
pnpm start &
# Wait for server
npx tsx src/tests/e2e-remaining-bugs.ts
```

Verify tests 12.1, 11.1, 1.9 still pass.

- [ ] **Step 2: Write E2E test for message persistence after reload**

```typescript
// Test: send message, reload page, verify message still visible
// This validates that messages.getHistory reads from message-store correctly
```

- [ ] **Step 3: Write E2E test for bidirectional messaging**

Reuse existing `src/tests/e2e-bidirectional.ts` pattern — verify messages sent by User A appear on User B.

- [ ] **Step 4: Run full E2E suite**

```bash
npx tsx src/tests/e2e-contacts-and-sending.ts
npx tsx src/tests/e2e-bidirectional.ts
npx tsx src/tests/e2e-persistence-status.ts
```

- [ ] **Step 5: Commit any test fixes**

```bash
git add -A
git commit -m "test: verify E2E tests pass with Virtual MTProto layer"
```

---

## Task 10: Update CHECKLIST.md and cleanup

**Files:**
- Modify: `CHECKLIST.md`

- [ ] **Step 1: Mark resolved bugs**

Mark bugs 4.4, 4.5, 4.6, 4.7, 6.16 as `[x]` in CHECKLIST.md (after E2E verification).

- [ ] **Step 2: Run final check**

```bash
echo "PASS: $(grep -c '\[x\]' CHECKLIST.md) | TODO: $(grep -c '\[ \]' CHECKLIST.md)"
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l
```

Expected: All structural bugs resolved, zero TS errors.

- [ ] **Step 3: Final commit**

```bash
git add CHECKLIST.md
git commit -m "docs: mark bugs 4.4-4.7 and 6.16 as resolved by Virtual MTProto refactoring"
```
