// @vitest-environment jsdom
import {describe, it, expect, beforeEach, vi} from 'vitest';

const OWN = 'a'.repeat(64);
const PEER = 'b'.repeat(64);

function makeEvent(over: Partial<any> = {}): any {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    kind: 30001,
    pubkey: PEER,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', OWN]],
    content: '',
    sig: 'sig',
    ...over
  };
}

describe('phantomchatTypingReceive', () => {
  let typing: any;
  let dispatched: number[];

  beforeEach(async() => {
    vi.resetModules();
    const mod = await import('@lib/phantomchat/phantomchat-typing-receive');
    typing = mod.phantomchatTypingReceive;
    dispatched = [];
    typing.setOwnPubkey(OWN);
    typing.setSignatureVerifier(() => true);
    typing.setPeerResolver(async() => 4242);
    typing.setTypingDispatcher((peerId: number) => dispatched.push(peerId));
  });

  it('dispatches a typing update for a valid event, keyed by mapped peerId', async() => {
    await typing.onTyping(makeEvent());
    expect(dispatched).toEqual([4242]);
  });

  it('ignores our own typing events', async() => {
    await typing.onTyping(makeEvent({pubkey: OWN}));
    expect(dispatched).toEqual([]);
  });

  it('ignores events not p-tagged to us', async() => {
    await typing.onTyping(makeEvent({tags: [['p', 'c'.repeat(64)]]}));
    expect(dispatched).toEqual([]);
  });

  it('ignores non-typing kinds', async() => {
    await typing.onTyping(makeEvent({kind: 7}));
    expect(dispatched).toEqual([]);
  });

  it('accepts legacy kind-20001 for backward compatibility', async() => {
    await typing.onTyping(makeEvent({kind: 20001}));
    expect(dispatched).toEqual([4242]);
  });

  it('drops stale redeliveries (created_at well in the past)', async() => {
    await typing.onTyping(makeEvent({created_at: Math.floor(Date.now() / 1000) - 120}));
    expect(dispatched).toEqual([]);
  });

  it('drops events that fail signature verification', async() => {
    typing.setSignatureVerifier(() => false);
    await typing.onTyping(makeEvent());
    expect(dispatched).toEqual([]);
  });

  it('dispatches a gift-unwrapped tick (no sig) WITHOUT running the raw verifier', async() => {
    // Regression for the gift-wrap receive seam: kind-1059 typing wraps are
    // unwrapped by the relay layer into a synthetic kind-20001 event that has
    // NO `sig` (the sender was authenticated by the NIP-59 seal during unwrap).
    // verifyEvent() on that synthetic event always fails for lack of a sig, so
    // before the `giftUnwrapped` bypass EVERY gift-wrapped tick was dropped here
    // and no indicator ever rendered. Lock in that the flagged path skips the
    // raw re-check and still dispatches.
    let verifierCalled = false;
    typing.setSignatureVerifier(() => { verifierCalled = true; return false; });
    await typing.onTyping(makeEvent({kind: 20001, sig: undefined, giftUnwrapped: true}));
    expect(dispatched).toEqual([4242]);
    expect(verifierCalled).toBe(false);
  });

  it('still verifies legacy bare kind-20001 ticks (no giftUnwrapped flag)', async() => {
    // The bypass must NOT weaken the legacy path: a bare kind-20001 from a
    // not-yet-updated sender carries a real sig and must still be verified.
    typing.setSignatureVerifier(() => false);
    await typing.onTyping(makeEvent({kind: 20001}));
    expect(dispatched).toEqual([]);
  });

  it('does not throw if the peer resolver rejects', async() => {
    typing.setPeerResolver(async() => { throw new Error('bad pubkey'); });
    await expect(typing.onTyping(makeEvent())).resolves.toBeUndefined();
    expect(dispatched).toEqual([]);
  });

  it('dispatches a CANCEL (not a start) for a stop-marked DM event', async() => {
    const calls: Array<{peerId: number, isStop?: boolean}> = [];
    typing.setTypingDispatcher((peerId: number, isStop?: boolean) => calls.push({peerId, isStop}));
    await typing.onTyping(makeEvent({content: 'stop'}));
    expect(calls).toEqual([{peerId: 4242, isStop: true}]);
  });

  it('flags a recording-marked DM event so the record-audio action renders', async() => {
    const calls: Array<{peerId: number, isStop?: boolean, isRecording?: boolean}> = [];
    typing.setTypingDispatcher((peerId: number, isStop?: boolean, isRecording?: boolean) =>
      calls.push({peerId, isStop, isRecording}));
    await typing.onTyping(makeEvent({content: 'recording'}));
    expect(calls).toEqual([{peerId: 4242, isStop: false, isRecording: true}]);
  });

  it('ensures the sender User is injected BEFORE dispatching a 1:1 typing tick', async() => {
    // Regression guard: the inherited tweb onUpdateUserTyping only fires
    // peer_typings (which renders the dots) when the peer's User is loaded.
    // For a 1:1 tick there is no group-branch fallback to load+re-dispatch, so
    // if we dispatch without ensuring the User, a cold peer silently shows no
    // indicator. This locks in that ensureUser runs, with the right args, and
    // strictly before the dispatch.
    const order: string[] = [];
    let ensuredWith: {pubkey: string, peerId: number} | null = null;
    typing.setUserEnsurer(async(pubkey: string, peerId: number) => {
      ensuredWith = {pubkey, peerId};
      order.push('ensure');
    });
    typing.setTypingDispatcher((peerId: number) => {
      order.push('dispatch');
      dispatched.push(peerId);
    });

    await typing.onTyping(makeEvent());

    expect(ensuredWith).toEqual({pubkey: PEER, peerId: 4242});
    expect(order).toEqual(['ensure', 'dispatch']);
    expect(dispatched).toEqual([4242]);
  });

  it('still dispatches the 1:1 tick even if ensureUser rejects (non-critical)', async() => {
    typing.setUserEnsurer(async() => { throw new Error('inject failed'); });
    await expect(typing.onTyping(makeEvent())).resolves.toBeUndefined();
    expect(dispatched).toEqual([4242]);
  });

  it('skips user-ensure on a 1:1 stop tick (nothing to label when clearing)', async() => {
    let ensured = false;
    const calls: Array<{peerId: number, isStop?: boolean}> = [];
    typing.setUserEnsurer(async() => { ensured = true; });
    typing.setTypingDispatcher((peerId: number, isStop?: boolean) => calls.push({peerId, isStop}));
    await typing.onTyping(makeEvent({content: 'stop'}));
    expect(ensured).toBe(false);
    expect(calls).toEqual([{peerId: 4242, isStop: true}]);
  });

  it('routes a group-tagged event to the GROUP dispatcher with chat id + sender', async() => {
    const groupCalls: Array<{chatId: number, from: number, isStop?: boolean}> = [];
    let ensured = false;
    typing.setGroupResolver(async() => -1500); // negative group peerId
    typing.setUserEnsurer(async() => { ensured = true; });
    typing.setGroupTypingDispatcher((chatId: number, from: number, isStop?: boolean) =>
      groupCalls.push({chatId, from, isStop}));

    await typing.onTyping(makeEvent({tags: [['group', 'hq-id'], ['p', OWN]]}));

    // chat id is the positive form of the negative group peerId; sender = 4242.
    expect(groupCalls).toEqual([{chatId: 1500, from: 4242, isStop: false}]);
    // The 1:1 dispatcher must NOT fire for a group tick.
    expect(dispatched).toEqual([]);
    // The typing member's User was ensured so the name renders.
    expect(ensured).toBe(true);
  });

  it('suppresses incoming typing when read receipts are OFF (WhatsApp reciprocity)', async() => {
    localStorage.setItem('phantomchat:read-receipts-enabled', 'false');
    try {
      await typing.onTyping(makeEvent());
      expect(dispatched).toEqual([]);
    } finally {
      localStorage.removeItem('phantomchat:read-receipts-enabled');
    }
  });

  it('still shows incoming typing when read receipts are ON', async() => {
    localStorage.setItem('phantomchat:read-receipts-enabled', 'true');
    try {
      await typing.onTyping(makeEvent());
      expect(dispatched).toEqual([4242]);
    } finally {
      localStorage.removeItem('phantomchat:read-receipts-enabled');
    }
  });

  it('group stop dispatches a group CANCEL and skips user-ensure', async() => {
    const groupCalls: Array<{chatId: number, from: number, isStop?: boolean}> = [];
    let ensured = false;
    typing.setGroupResolver(async() => -1500);
    typing.setUserEnsurer(async() => { ensured = true; });
    typing.setGroupTypingDispatcher((chatId: number, from: number, isStop?: boolean) =>
      groupCalls.push({chatId, from, isStop}));

    await typing.onTyping(makeEvent({content: 'stop', tags: [['group', 'hq-id'], ['p', OWN]]}));

    expect(groupCalls).toEqual([{chatId: 1500, from: 4242, isStop: true}]);
    expect(ensured).toBe(false);
  });
});
