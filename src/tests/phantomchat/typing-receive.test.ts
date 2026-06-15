// @vitest-environment jsdom
import {describe, it, expect, beforeEach, vi} from 'vitest';

const OWN = 'a'.repeat(64);
const PEER = 'b'.repeat(64);

function makeEvent(over: Partial<any> = {}): any {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    kind: 20001,
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

  it('drops stale redeliveries (created_at well in the past)', async() => {
    await typing.onTyping(makeEvent({created_at: Math.floor(Date.now() / 1000) - 120}));
    expect(dispatched).toEqual([]);
  });

  it('drops events that fail signature verification', async() => {
    typing.setSignatureVerifier(() => false);
    await typing.onTyping(makeEvent());
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
