/**
 * Regression test: self-echo of a media message must reconstruct fileMetadata.
 *
 * When you send a voice note, your own gift-wrap is re-delivered to your other
 * devices (NIP-17 multi-device self-echo). That path goes through
 * `handleSelfEcho`, a SEPARATE write path from the normal incoming receive. It
 * used to hardcode `type:'text'` and store the raw metadata JSON as the bubble
 * text — so your own voice note rendered as "Unknown file" + a wall of JSON
 * instead of a playable voice bubble. PR #7 only fixed the
 * incoming-from-others and reload classifiers; the self-echo path never built a
 * fileMetadata object for those classifiers to act on.
 *
 * Fix: handleSelfEcho now runs the same extractFileMetadata reconstruction as
 * the normal receive path — type flips to 'file', the bubble text becomes the
 * caption (not the JSON), and the full fileMetadata (incl. the authoritative
 * mediaType:'voice') is persisted and dispatched.
 */

import '../setup';
import {describe, it, expect, vi, beforeAll, afterAll} from 'vitest';

const OWN_PUBKEY = '1122334455667788112233445566778811223344556677881122334455667788';
const PEER_PUBKEY = 'aabbcc0011223344aabbcc0011223344aabbcc0011223344aabbcc0011223344';
const PEER_ID = 1234567890123456;
const MID = 999000000042;

// Minimal in-memory store capturing the persisted self-echo row.
class InMemoryStore {
  rows = new Map<string, any>();
  saveMessage = vi.fn(async(msg: any) => { this.rows.set(msg.eventId, {...msg}); });
  getConversationId = (a: string, b: string) => [a, b].sort().join(':');
  getByEventId = vi.fn(async(id: string) => this.rows.get(id) || null);
  getByAppMessageId = vi.fn().mockResolvedValue(null);
  deleteMessages = vi.fn().mockResolvedValue(undefined);
  getTombstone = vi.fn().mockResolvedValue(0);
}

const store = new InMemoryStore();
let handleRelayMessage: any;

// The voice-note wire payload exactly as the send path emits it (key/iv, not
// keyHex/ivHex; explicit mediaType:'voice'; audio/ogg mime).
const VOICE_WIRE = JSON.stringify({
  url: 'https://blossom.example/abc',
  sha256: '32c1419e261e115249e46cd36856b6cbbde4be1f349ed0b2191d2bed2d4b5e6d',
  mimeType: 'audio/ogg',
  size: 24165,
  key: '43d8bfa33606606383ef629683bd57c090b8952758ddc2fe2fc8f5a25d9bb788',
  iv: '1b437d2e5cb5d95e961d6fb8',
  mediaType: 'voice',
  duration: 3
});

beforeAll(async() => {
  vi.resetModules();
  vi.doMock('@lib/phantomchat/message-store', () => ({getMessageStore: () => store}));
  vi.doMock('@lib/phantomchat/phantomchat-bridge', () => ({
    PhantomChatBridge: {
      getInstance: () => ({
        mapPubkeyToPeerId: vi.fn().mockResolvedValue(PEER_ID),
        mapEventIdToMid: vi.fn().mockResolvedValue(MID)
      })
    }
  }));
  const recvMod = await import('@lib/phantomchat/chat-api-receive');
  handleRelayMessage = recvMod.handleRelayMessage;
});

afterAll(() => {
  vi.unmock('@lib/phantomchat/message-store');
  vi.unmock('@lib/phantomchat/phantomchat-bridge');
  vi.restoreAllMocks();
});

describe('self-echo media reconstruction', () => {
  it('renders an echoed voice note as a file bubble with fileMetadata, not raw JSON', async() => {
    const onMessage = vi.fn();
    const msg = {
      id: 'e'.repeat(64),
      from: OWN_PUBKEY,        // self-echo: from === ownId
      content: VOICE_WIRE,
      timestamp: Math.floor(Date.now() / 1000),
      rumorKind: 14,
      tags: [['p', PEER_PUBKEY]]
    };
    const ctx = {
      ownId: OWN_PUBKEY,
      history: [] as any[],
      activePeer: null as string | null,
      deliveryTracker: null as any,
      offlineQueue: null as any,
      onMessage,
      onEdit: null as any,
      log: Object.assign(vi.fn(), {warn: vi.fn(), error: vi.fn()}) as any
    };

    const result = await handleRelayMessage(msg as any, ctx as any);
    expect(result.action).toBe('echo_saved');

    // Dispatched bubble: file type + voice metadata, NOT raw JSON text.
    expect(onMessage).toHaveBeenCalledTimes(1);
    const dispatched = onMessage.mock.calls[0][0];
    expect(dispatched.type).toBe('file');
    expect(dispatched.fileMetadata).toBeTruthy();
    expect(dispatched.fileMetadata.mediaType).toBe('voice');
    expect(dispatched.fileMetadata.mimeType).toBe('audio/ogg');
    expect(dispatched.content).not.toContain('blossom'); // never the JSON

    // Persisted row mirrors it.
    const saved = store.rows.get(msg.id);
    expect(saved).toBeTruthy();
    expect(saved.type).toBe('file');
    expect(saved.fileMetadata?.mediaType).toBe('voice');
    expect(saved.content).toBe(''); // caption-less → empty, not JSON
  });
});
