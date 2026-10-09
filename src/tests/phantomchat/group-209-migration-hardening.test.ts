/**
 * Regression coverage for phantomchat#209 — hardening follow-ups to the #207
 * group-unread fix (PR #208):
 *
 *  1. Retry window can force-read a newly created group. The one-shot
 *     `GROUP_KEY_MIGRATION` marker was written only after the WHOLE sweep
 *     succeeded, so any per-group failure reran every group on the next boot —
 *     and, because the cursor seed is unconditional, force-read any group that
 *     appeared (or received messages) inside that window. Fixed with a frozen
 *     cohort + a per-group done set.
 *  2. v5 → v6 upgrade blocked by a second open connection. `openDB` had no
 *     `onblocked`/`onversionchange` handling, so a stale second connection
 *     blocked the upgrade and `getDB()` never settled.
 */
import '../setup';
import 'fake-indexeddb/auto';
import {IDBFactory} from 'fake-indexeddb';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {
  MessageStore,
  GROUP_KEY_MIGRATION,
  GROUP_KEY_MIGRATION_COHORT,
  GROUP_KEY_MIGRATION_DONE,
  GROUP_KEY_MIGRATION_CEILING,
  StoredMessage
} from '@lib/phantomchat/message-store';

const G_A = 'a1'.repeat(32);
const G_B = 'b2'.repeat(32);
const G_C = 'c3'.repeat(32);
const conv = (groupId: string) => `group:${groupId}`;

let mid = 1;
function makeMsg(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    eventId: 'evt-' + Math.random().toString(36).slice(2, 10),
    conversationId: conv(G_A),
    senderPubkey: '22'.repeat(32),
    content: 'Hello',
    type: 'text',
    timestamp: Math.floor(Date.now() / 1000),
    deliveryState: 'delivered',
    mid: mid++,
    twebPeerId: 1_000_000_000_000_001,
    ...overrides
  };
}

function freshStore(): MessageStore {
  return new MessageStore();
}

beforeEach(() => {
  // Each case gets its own IndexedDB so migration markers/cursors can't leak
  // between tests (they share DB_NAME otherwise).
  vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('#209 group-key migration hardening', () => {
  it('freezes the sweep cohort so a group created after the first attempt is never swept', async() => {
    const store = freshStore();
    // A has a canonical row, so a sweep seeds its cursor to the top mid.
    await store.saveMessage(makeMsg({conversationId: conv(G_A), mid: 100, timestamp: 100}));

    // First attempt: B throws, so the global marker is withheld and the sweep
    // will retry on the next boot.
    const spy = vi.spyOn(store as any, 'rekeyConversation').mockImplementation(async(from: unknown) => {
      if(from === G_B) throw new Error('boom');
      return 0;
    });
    await store.migrateLegacyGroupConversationKeys([G_A, G_B]);
    spy.mockRestore();

    expect(await store.getMigration(GROUP_KEY_MIGRATION)).toBe(false);
    expect(await store.getMigrationValue<string[]>(GROUP_KEY_MIGRATION_COHORT)).toEqual([G_A, G_B]);
    // #211: A's ceiling is frozen before its (successful) mutation; B's is
    // captured before its rekey threw, so both are persisted for the retry.
    expect(await store.getMigrationValue<Record<string, number>>(GROUP_KEY_MIGRATION_CEILING)).toEqual({[G_A]: 100, [G_B]: 0});

    // A brand-new group appears AFTER the first attempt. It must not enter the
    // retry sweep, so its cursor stays unseeded and its messages stay unread.
    await store.saveMessage(makeMsg({conversationId: conv(G_C), mid: 900, timestamp: 900}));
    await store.migrateLegacyGroupConversationKeys([G_A, G_B, G_C]);

    expect(await store.getReadCursor(conv(G_C))).toBe(0);
    expect(await store.getMigration(GROUP_KEY_MIGRATION)).toBe(true);
    // B, which failed before, is retried and now completes the cohort.
    expect(await store.getMigrationValue<string[]>(GROUP_KEY_MIGRATION_DONE)).toEqual([G_A, G_B]);
  });

  it('does not re-seed a group that already migrated (new messages stay unread)', async() => {
    const store = freshStore();
    await store.saveMessage(makeMsg({conversationId: conv(G_A), mid: 100, timestamp: 100}));

    const spy = vi.spyOn(store as any, 'rekeyConversation').mockImplementation(async(from: unknown) => {
      if(from === G_B) throw new Error('boom');
      return 0;
    });
    await store.migrateLegacyGroupConversationKeys([G_A, G_B]);
    spy.mockRestore();

    // A finished migrating, so its cursor sits at the top it saw (100).
    expect(await store.getReadCursor(conv(G_A))).toBe(100);

    // A message arrives during the retry window. A retry must NOT touch A, or
    // its unconditional seed would advance the cursor and force-read it.
    await store.saveMessage(makeMsg({conversationId: conv(G_A), mid: 200, timestamp: 200}));
    await store.migrateLegacyGroupConversationKeys([G_A, G_B]);

    expect(await store.getReadCursor(conv(G_A))).toBe(100);
  });

  it('does not advance the seed ceiling when the DONE write is interrupted (review #211)', async() => {
    const store = freshStore();
    await store.saveMessage(makeMsg({conversationId: conv(G_A), mid: 100, timestamp: 100}));

    // First sweep: A seeds to its top (100), then the DONE write rejects — the
    // exact interruption Kai reproduced. The seed has committed but A is not
    // marked done and the global marker is withheld, so the sweep will retry.
    const origSet = store.setMigrationValue.bind(store);
    const spy = vi.spyOn(store as any, 'setMigrationValue').mockImplementation((async(name: string, value: unknown) => {
      if(name === GROUP_KEY_MIGRATION_DONE) throw new Error('interrupted');
      return origSet(name, value);
    }) as any);
    await store.migrateLegacyGroupConversationKeys([G_A]);
    spy.mockRestore();

    expect(await store.getReadCursor(conv(G_A))).toBe(100);
    expect(await store.getMigration(GROUP_KEY_MIGRATION)).toBe(false);
    // The ceiling was frozen BEFORE the group was touched.
    expect(await store.getMigrationValue<Record<string, number>>(GROUP_KEY_MIGRATION_CEILING)).toEqual({[G_A]: 100});

    // A message arrives before the retry. The retry must reseed to the FROZEN
    // ceiling (100), not recompute the then-current top (200), or it would
    // force-read the message that arrived in the interruption window.
    await store.saveMessage(makeMsg({conversationId: conv(G_A), mid: 200, timestamp: 200}));
    await store.migrateLegacyGroupConversationKeys([G_A]);

    expect(await store.getReadCursor(conv(G_A))).toBe(100);
    expect(await store.getMigration(GROUP_KEY_MIGRATION)).toBe(true);
  });
});

describe('#209 IndexedDB open hardening', () => {
  it('closes its connection on versionchange so it never blocks a later upgrade', async() => {
    const isolated = new IDBFactory();
    vi.stubGlobal('indexedDB', isolated);

    const store = freshStore();
    const db = await (store as any).getDB() as IDBDatabase;
    const closeSpy = vi.spyOn(db, 'close');

    expect(typeof db.onversionchange).toBe('function');
    (db.onversionchange as any)();

    expect(closeSpy).toHaveBeenCalled();
    // Cached handle dropped so a later getDB() reopens at the new version.
    expect((store as any).dbPromise).toBeNull();
    db.close();
  });

  it('rejects (rather than hanging forever) when the upgrade is blocked', async() => {
    const req: any = {};
    const fakeIndexedDB = {
      open: () => {
        queueMicrotask(() => req.onblocked?.());
        return req;
      }
    };
    vi.stubGlobal('indexedDB', fakeIndexedDB);

    const store = freshStore();
    await expect((store as any).getDB()).rejects.toThrow(/blocked/);
    // Cached promise cleared so a later call can retry once the blocker closes.
    expect((store as any).dbPromise).toBeNull();
  });
});
