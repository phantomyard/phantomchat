/**
 * Regression coverage for the group chat-list injection at creation time.
 *
 * Before this fix, `GroupAPI.createGroup` and `handleGroupCreate` only
 * wrote the service row + broadcast control wraps. They never populated
 * `apiManagerProxy.mirrors.chats[chatId]` / `mirrors.peers[groupPeerId]`
 * nor dispatched `dialogs_multiupdate`. Result: the group was invisible in
 * the chat list until the first message send/receive hit
 * `handleGroupOutgoing`/`handleGroupIncoming`, which was also the symptom
 * reported ("i gruppi non compaiono nella lista delle chat").
 *
 * Uses the `beforeAll + resetModules + doMock` pattern (matches
 * `group-chat-api.test.ts`) to guarantee a fresh module graph under
 * `isolate: false` — other test files mock the same modules with
 * incompatible factories and the cache must be cleared before the
 * dynamic imports run.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeAll, afterAll, beforeEach, vi} from 'vitest';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

const GROUP_PEER_ID = -2000000000000001;

// Hoisted shared state so the mock factories defined below can close over it
// without the "cannot access before initialization" hazard of vi.mock hoisting.
const proxy = vi.hoisted(() => ({
  mirrors: {peers: {} as Record<number, any>, chats: {} as Record<number, any>, messages: {} as Record<string, any>}
}));
const dispatchEvent = vi.hoisted(() => vi.fn());
const reconcilePeer = vi.hoisted(() => vi.fn());

// File-scoped mocks — hoisted by vitest so the factories run before any
// top-level import. The body below will re-register identical factories
// via doMock after `resetModules` to defeat cross-file cache pollution.
vi.mock('@config/debug', async() => {
  const actual = await vi.importActual<typeof import('@config/debug')>('@config/debug');
  return {...actual, MOUNT_CLASS_TO: {apiManagerProxy: proxy}};
});
vi.mock('@lib/nostra/group-store', () => ({
  GroupStore: class {},
  getGroupStore: () => ({
    get: vi.fn().mockResolvedValue({
      groupId: 'stub',
      name: 'Stub Group',
      adminPubkey: 'a'.repeat(64),
      members: ['a'.repeat(64), 'b'.repeat(64)],
      peerId: GROUP_PEER_ID,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }),
    getByPeerId: vi.fn().mockResolvedValue(null),
    getAll: vi.fn().mockResolvedValue([])
  })
}));
vi.mock('@lib/nostra/group-types', async() => {
  const actual = await vi.importActual<typeof import('@lib/nostra/group-types')>('@lib/nostra/group-types');
  return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(GROUP_PEER_ID)};
});
vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent,
    dispatchEventSingle: vi.fn(),
    addEventListener: vi.fn(),
    managers: {
      appChatsManager: {saveApiChat: vi.fn().mockResolvedValue(undefined)},
      appMessagesManager: {
        setMessageToStorage: vi.fn().mockResolvedValue(undefined),
        invalidateHistoryCache: vi.fn().mockResolvedValue(undefined)
      }
    }
  }
}));
vi.mock('@stores/peers', () => ({reconcilePeer}));

let injectGroupCreateDialog: typeof import('@lib/nostra/nostra-groups-sync')['injectGroupCreateDialog'];

beforeAll(async() => {
  vi.resetModules();

  vi.doMock('@config/debug', async() => {
    const actual = await vi.importActual<typeof import('@config/debug')>('@config/debug');
    return {...actual, MOUNT_CLASS_TO: {apiManagerProxy: proxy}};
  });
  vi.doMock('@lib/nostra/group-store', () => ({
    GroupStore: class {},
    getGroupStore: () => ({
      get: vi.fn().mockResolvedValue({
        groupId: 'stub',
        name: 'Stub Group',
        adminPubkey: 'a'.repeat(64),
        members: ['a'.repeat(64), 'b'.repeat(64)],
        peerId: GROUP_PEER_ID,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }),
      getByPeerId: vi.fn().mockResolvedValue(null),
      getAll: vi.fn().mockResolvedValue([])
    })
  }));
  vi.doMock('@lib/nostra/group-types', async() => {
    const actual = await vi.importActual<typeof import('@lib/nostra/group-types')>('@lib/nostra/group-types');
    return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(GROUP_PEER_ID)};
  });
  vi.doMock('@lib/rootScope', () => ({
    default: {
      dispatchEvent,
      dispatchEventSingle: vi.fn(),
      addEventListener: vi.fn(),
      managers: {
        appChatsManager: {saveApiChat: vi.fn().mockResolvedValue(undefined)},
        appMessagesManager: {
          setMessageToStorage: vi.fn().mockResolvedValue(undefined),
          invalidateHistoryCache: vi.fn().mockResolvedValue(undefined)
        }
      }
    }
  }));
  vi.doMock('@stores/peers', () => ({reconcilePeer}));

  const mod = await import('@lib/nostra/nostra-groups-sync');
  injectGroupCreateDialog = mod.injectGroupCreateDialog;
});

afterAll(() => {
  // Release our file-scoped mocks so subsequent test files (group-cleanup-
  // mirror.test.ts in particular) can re-import `nostra-groups-sync`
  // against THEIR own proxy. Without this, `isolate: false` leaks our
  // `MOUNT_CLASS_TO.apiManagerProxy` binding into their module cache.
  vi.doUnmock('@config/debug');
  vi.doUnmock('@lib/nostra/group-store');
  vi.doUnmock('@lib/nostra/group-types');
  vi.doUnmock('@lib/rootScope');
  vi.doUnmock('@stores/peers');
  vi.resetModules();
});

describe('injectGroupCreateDialog', () => {
  beforeEach(() => {
    proxy.mirrors.peers = {};
    proxy.mirrors.chats = {};
    proxy.mirrors.messages = {};
    dispatchEvent.mockClear();
    reconcilePeer.mockClear();
  });

  it('populates mirrors.chats and dispatches dialogs_multiupdate', async() => {
    const groupId = 'deadbeef'.repeat(8);
    await injectGroupCreateDialog(groupId, 123456789, 1700000000);

    const dialogCalls = dispatchEvent.mock.calls.filter((c) => c[0] === 'dialogs_multiupdate');
    expect(dialogCalls.length).toBeGreaterThanOrEqual(1);

    const chatId = Math.abs(GROUP_PEER_ID);
    expect(proxy.mirrors.chats[chatId]).toBeDefined();
    expect(proxy.mirrors.chats[chatId].id).toBe(chatId);

    expect(reconcilePeer).toHaveBeenCalled();
  });

  it('is idempotent — safe to call twice for the same group', async() => {
    const groupId = 'aaaabbbb'.repeat(8);
    await expect(injectGroupCreateDialog(groupId, 42, 1700000000)).resolves.not.toThrow();
    await expect(injectGroupCreateDialog(groupId, 42, 1700000000)).resolves.not.toThrow();
  });
});
