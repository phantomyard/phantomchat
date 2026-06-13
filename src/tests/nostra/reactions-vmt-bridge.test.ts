// @vitest-environment jsdom
/**
 * Tests the VMT `messages.sendReaction` handler.
 *
 * The handler resolves a target message (via the injected
 * `getMessageByPeerMid`) and routes the emoji to
 * `nostraReactionsPublish.publish()`, which in turn publishes a kind-7
 * reaction via ChatAPI. The VMT response is an empty tweb `updates`
 * envelope — the UI reads the reactions store, not the MTProto result.
 */
import {describe, it, expect, beforeEach, vi} from 'vitest';
import 'fake-indexeddb/auto';

describe('VMT messages.sendReaction handler', () => {
  let vmtMod: any;
  let publishSpy: any;

  beforeEach(async() => {
    vi.resetModules();
    await new Promise<void>((resolve) => {
      const req = (globalThis as any).indexedDB.deleteDatabase('nostra-reactions');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    publishSpy = vi.fn(async() => 'fakeReactionId');
    vi.doMock('@lib/nostra/nostra-reactions-publish', () => ({
      nostraReactionsPublish: {publish: publishSpy, unpublish: vi.fn()},
      setChatAPI: vi.fn()
    }));
    vmtMod = await import('@lib/nostra/virtual-mtproto-server');
  });

  it('handles messages.sendReaction -> calls nostraReactionsPublish.publish', async() => {
    // 64-hex stub — the handler now guards against legacy `chat-XXX-N` ids
    // before invoking publish (see "skips publish when relayEventId is not
    // 64-hex" below), so test fixtures must look like real rumor ids.
    const targetEventId = 'b'.repeat(64);
    const server = new vmtMod.NostraMTProtoServer({
      getMessageByPeerMid: () => ({relayEventId: targetEventId, senderPubkey: 'peerpk'})
    });
    const result = await server.handleMethod('messages.sendReaction', {
      message: {peerId: 1e16, mid: 42},
      reaction: {_: 'reactionEmoji', emoticon: '👍'}
    });
    expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
      targetEventId,
      targetMid: 42,
      targetPeerId: 1e16,
      targetAuthor: 'peerpk',
      emoji: '👍'
    }));
    // Tweb expects an 'updates' shape in return.
    expect(result).toEqual(expect.objectContaining({_: 'updates'}));
    expect(result.updates).toEqual([]);
    expect(result.users).toEqual([]);
    expect(result.chats).toEqual([]);
  });

  it('returns empty updates without publishing when target message is not found', async() => {
    const server = new vmtMod.NostraMTProtoServer({
      getMessageByPeerMid: (): null => null
    });
    const result = await server.handleMethod('messages.sendReaction', {
      message: {peerId: 1e16, mid: 99},
      reaction: {_: 'reactionEmoji', emoticon: '👍'}
    });
    expect(publishSpy).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({_: 'updates'}));
  });

  it('returns empty updates without publishing on missing/non-finite peerId or mid', async() => {
    const server = new vmtMod.NostraMTProtoServer({
      getMessageByPeerMid: () => ({relayEventId: 'evtTarget', senderPubkey: 'peerpk'})
    });
    const result = await server.handleMethod('messages.sendReaction', {
      message: {},
      reaction: {_: 'reactionEmoji', emoticon: '👍'}
    });
    expect(publishSpy).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({_: 'updates'}));
  });

  // Regression: legacy IDB rows / bridge-skipped writes can return a
  // `chat-XXX-N` app id as relayEventId. NIP-01 fixed-size `e` tags need
  // 64-hex; strfry rejects ("unexpected size for fixed-size tag: e") and
  // the user sees nothing. The handler must drop these BEFORE invoking
  // publish so the bug surfaces only as a console.warn, not a relay error.
  it('skips publish when relayEventId is not 64-hex (legacy chat-XXX-N row)', async() => {
    const server = new vmtMod.NostraMTProtoServer({
      getMessageByPeerMid: () => ({relayEventId: 'chat-1ab2c3d4-7', senderPubkey: 'peerpk'})
    });
    const result = await server.handleMethod('messages.sendReaction', {
      message: {peerId: 1e16, mid: 42},
      reaction: {_: 'reactionEmoji', emoticon: '👍'}
    });
    expect(publishSpy).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({_: 'updates'}));
  });

  it('publishes when relayEventId is 64-hex', async() => {
    const hex64 = 'a'.repeat(64);
    const server = new vmtMod.NostraMTProtoServer({
      getMessageByPeerMid: () => ({relayEventId: hex64, senderPubkey: 'peerpk'})
    });
    await server.handleMethod('messages.sendReaction', {
      message: {peerId: 1e16, mid: 42},
      reaction: {_: 'reactionEmoji', emoticon: '👍'}
    });
    expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({targetEventId: hex64}));
  });
});
