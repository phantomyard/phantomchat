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
});
