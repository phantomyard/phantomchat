import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach, afterAll, vi} from 'vitest';
import {isEditMessage, isReplyMessage, handleRelayMessage, ReceiveContext, IncomingEdit} from '@lib/nostra/chat-api-receive';
import {getMessageStore} from '@lib/nostra/message-store';
import type {DecryptedMessage} from '@lib/nostra/nostr-relay';

vi.mock('@lib/nostra/message-requests', () => ({
  getMessageRequestStore: () => ({
    isBlocked: async() => false,
    isKnownContact: async() => true,
    addRequest: async() => {}
  })
}));

vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn()
  }
}));

afterAll(() => {
  vi.unmock('@lib/rootScope');
  vi.unmock('@lib/nostra/message-requests');
  vi.restoreAllMocks();
});

const SENDER_PUB = 'a'.repeat(64);
const OWN_PUB = 'b'.repeat(64);

function makeCtx(overrides: Partial<ReceiveContext> = {}): ReceiveContext {
  const log = Object.assign(((..._args: any[]) => {}) as any, {
    warn: (..._args: any[]) => {},
    error: (..._args: any[]) => {}
  });
  return {
    ownId: OWN_PUB,
    history: [],
    activePeer: SENDER_PUB,
    deliveryTracker: null,
    offlineQueue: null,
    onMessage: null,
    onEdit: null,
    log,
    ...overrides
  };
}

async function seedOriginal(appId: string, content: string) {
  const store = getMessageStore();
  const conversationId = store.getConversationId(OWN_PUB, SENDER_PUB);
  await store.saveMessage({
    eventId: 'rumor-hex-of-original',
    appMessageId: appId,
    conversationId,
    senderPubkey: SENDER_PUB,
    content,
    type: 'text',
    timestamp: 1700000000,
    deliveryState: 'delivered',
    mid: 12345
  });
}

function editRumor(appId: string, newContent: string, fromOverride?: string): DecryptedMessage {
  return {
    id: 'rumor-hex-of-edit',
    from: fromOverride ?? SENDER_PUB,
    content: JSON.stringify({id: 'chat-new-1', from: SENDER_PUB, to: OWN_PUB, type: 'text', content: newContent, timestamp: Date.now()}),
    timestamp: 1700000100,
    rumorKind: 14,
    tags: [
      ['p', OWN_PUB],
      ['nostra-edit', appId]
    ]
  };
}

describe('isEditMessage', () => {
  it('returns null for undefined tags', () => {
    expect(isEditMessage(undefined)).toBeNull();
  });

  it('returns null for empty tags', () => {
    expect(isEditMessage([])).toBeNull();
  });

  it('returns null when no nostra-edit tag present', () => {
    expect(isEditMessage([
      ['p', 'abcd1234'],
      ['e', 'somehex', '', 'reply']
    ])).toBeNull();
  });

  it('detects a valid nostra-edit tag', () => {
    const result = isEditMessage([
      ['p', 'abcd1234'],
      ['nostra-edit', 'chat-1712345678901-1']
    ]);
    expect(result).toEqual({originalAppMessageId: 'chat-1712345678901-1'});
  });

  it('rejects a nostra-edit tag with non-app-id format', () => {
    expect(isEditMessage([
      ['nostra-edit', 'not-an-app-id']
    ])).toBeNull();
    expect(isEditMessage([
      ['nostra-edit', 'abc123']
    ])).toBeNull();
  });

  it('rejects a nostra-edit tag with missing value', () => {
    expect(isEditMessage([
      ['nostra-edit']
    ])).toBeNull();
  });
});

describe('isReplyMessage', () => {
  const HEX64 = 'a'.repeat(64);

  it('returns null for undefined or empty tags', () => {
    expect(isReplyMessage(undefined)).toBeNull();
    expect(isReplyMessage([])).toBeNull();
  });

  it('returns null when no e-tag has the reply marker', () => {
    expect(isReplyMessage([
      ['p', 'pubkey-x'],
      ['e', HEX64, '', 'mention']
    ])).toBeNull();
  });

  it('detects a NIP-10 reply marker and returns the eventId', () => {
    expect(isReplyMessage([
      ['p', 'pubkey-x'],
      ['e', HEX64, '', 'reply']
    ])).toEqual({replyToEventId: HEX64});
  });

  it('rejects an e-tag with non-64-hex eventId', () => {
    expect(isReplyMessage([
      ['e', 'short', '', 'reply']
    ])).toBeNull();
  });

  it('rejects an e-tag without the reply marker (root, missing)', () => {
    expect(isReplyMessage([
      ['e', HEX64, '', 'root']
    ])).toBeNull();
    expect(isReplyMessage([
      ['e', HEX64]
    ])).toBeNull();
  });

  it('returns null when first non-matching e-tag precedes a valid reply tag (no, picks first reply)', () => {
    // The function scans linearly; the first 'reply'-marked e-tag wins.
    expect(isReplyMessage([
      ['e', HEX64, '', 'mention'],
      ['e', 'b'.repeat(64), '', 'reply']
    ])).toEqual({replyToEventId: 'b'.repeat(64)});
  });

  it('rejects a nostra-edit tag with non-string value', () => {
    expect(isEditMessage([
      ['nostra-edit', null as any]
    ])).toBeNull();
  });

  it('finds the marker even when other tags surround it', () => {
    const result = isEditMessage([
      ['p', 'recipient'],
      ['e', 'a'.repeat(64), '', 'root'],
      ['nostra-edit', 'chat-99-7'],
      ['t', 'topic']
    ]);
    expect(result).toEqual({originalAppMessageId: 'chat-99-7'});
  });

  it('returns the first matching marker if duplicates appear', () => {
    const result = isEditMessage([
      ['nostra-edit', 'chat-1-1'],
      ['nostra-edit', 'chat-2-2']
    ]);
    expect(result).toEqual({originalAppMessageId: 'chat-1-1'});
  });
});

describe('handleRelayMessage — edit handling', () => {
  beforeEach(async() => {
    const store = getMessageStore();
    const convId = store.getConversationId(OWN_PUB, SENDER_PUB);
    await store.deleteMessages(convId);
  });

  it('updates the original message in store and fires onEdit', async() => {
    const appId = `chat-${Date.now()}-1`;
    await seedOriginal(appId, 'hello');

    const edits: IncomingEdit[] = [];
    const ctx = makeCtx({onEdit: (e) => edits.push(e)});

    const result = await handleRelayMessage(editRumor(appId, 'hello edited'), ctx);

    expect(result.action).toBe('edited');
    expect(edits).toHaveLength(1);
    expect(edits[0].newContent).toBe('hello edited');
    expect(edits[0].originalAppMessageId).toBe(appId);

    const stored = await getMessageStore().getByAppMessageId(appId);
    expect(stored?.content).toBe('hello edited');
    expect(stored?.editedAt).toBe(1700000100);
    expect(stored?.mid).toBe(12345);
  });

  it('drops edit when original is not in store', async() => {
    const ctx = makeCtx();
    const result = await handleRelayMessage(editRumor('chat-9999-9', 'whatever'), ctx);
    expect(result.action).toBe('skipped');
    expect((result as any).reason).toBe('edit_original_missing');
  });

  it('drops edit when sender pubkey does not match original author', async() => {
    const appId = `chat-${Date.now()}-2`;
    await seedOriginal(appId, 'hello');

    const ctx = makeCtx();
    const impostor = 'c'.repeat(64);
    const result = await handleRelayMessage(editRumor(appId, 'tampered', impostor), ctx);

    expect(result.action).toBe('skipped');
    expect((result as any).reason).toBe('edit_author_mismatch');

    const stored = await getMessageStore().getByAppMessageId(appId);
    expect(stored?.content).toBe('hello');
  });

  it('is idempotent for repeated identical edits', async() => {
    const appId = `chat-${Date.now()}-3`;
    await seedOriginal(appId, 'hello');

    const ctx = makeCtx();
    const rumor = editRumor(appId, 'hello edited');

    const first = await handleRelayMessage(rumor, ctx);
    const second = await handleRelayMessage(rumor, ctx);

    expect(first.action).toBe('edited');
    expect(second.action).toBe('skipped');
    expect((second as any).reason).toBe('edit_already_applied');
  });
});
