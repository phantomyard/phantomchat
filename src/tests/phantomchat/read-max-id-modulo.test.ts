/**
 * #347 — `getReadMaxIdIfUnread` must not gate the read cursor on the DERIVED
 * wire id.
 *
 * PhantomChat mids are `timestamp * 1e6 + slot` (~1.7e15), so they are far
 * above `MESSAGE_ID_OFFSET` (0x100000000) and `getServerMessageId(mid)` is
 * `mid % 2^32`. A mid that is an exact multiple of 2^32 therefore maps to `0`,
 * which is falsy — the old guard `... && getServerMessageId(readMaxId)` read a
 * REAL cursor as "nothing to read" and the chat reopened fully unread.
 *
 * The guard's actual job is to reject the zero/absent sentinel, so it has to
 * test the stored mid, not the truncated wire id.
 */
import '../setup';
import 'fake-indexeddb/auto';
import {describe, it, expect} from 'vitest';
import {AppMessagesManager} from '@lib/appManagers/appMessagesManager';

const MESSAGE_ID_OFFSET = 0x100000000;
const P2P_PEER = 1000000000000001 as any;

function managerFor(readMaxId: number | undefined, maxId: number, topMessage?: any) {
  return {
    getHistoryStorage: () => ({readMaxId, maxId}),
    getMessageByPeer: () => topMessage,
    appChatsManager: {isForum: () => false}
  } as any;
}

function call(manager: any) {
  return AppMessagesManager.prototype.getReadMaxIdIfUnread.call(manager, P2P_PEER);
}

describe('getReadMaxIdIfUnread — wire-id modulo (#347)', () => {
  it('keeps a cursor that is an exact multiple of 2^32', () => {
    const readMaxId = MESSAGE_ID_OFFSET * 2; // 8589934592 -> wire id 0
    expect(call(managerFor(readMaxId, readMaxId + 5))).toBe(readMaxId);
  });

  it('keeps a 4th-generation multiple too, not just the first', () => {
    const readMaxId = MESSAGE_ID_OFFSET * 4;
    expect(call(managerFor(readMaxId, readMaxId + 1))).toBe(readMaxId);
  });

  it('still treats a zero cursor as nothing read', () => {
    expect(call(managerFor(0, 100))).toBe(0);
  });

  it('still treats an absent cursor as nothing read', () => {
    expect(call(managerFor(undefined, 100))).toBe(0);
  });

  it('returns an ordinary cursor unchanged', () => {
    expect(call(managerFor(100, 200))).toBe(100);
  });

  it('reports nothing unread when the cursor is at the top', () => {
    expect(call(managerFor(200, 200))).toBe(0);
  });

  it('ignores an outgoing top message', () => {
    expect(call(managerFor(100, 200, {pFlags: {out: true}}))).toBe(0);
  });
});
