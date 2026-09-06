/**
 * Regression coverage for group bubbles rendering the GROUP as their own sender.
 *
 * Symptom reported from the field: in a group chat every incoming bubble shows
 * the real sender's name and avatar while the app is running, but after a
 * reload the name and avatar are replaced by the group's own title/avatar
 * ("Phantomyard"), so the thread loses who actually said what.
 *
 * Chain: message-store's upsert merged with a plain spread, so a partial writer
 * carrying `senderPubkey: undefined` (device-sync rows are wire data — the
 * field is typed required but is absent on legacy rows) blanked the sender of a
 * row that already had one. On the next reload getGroupHistory read that row,
 * found no sender to map, and emitted a message with no `from_id`;
 * appMessagesManager.saveMessages then applies `fromId = peerId` — for a group
 * that is the CHAT — and bubbles.ts derives BOTH the title and the avatar from
 * `message.fromId`, giving the group as the author.
 *
 * The live receive path (handleGroupIncoming) always stamps fromPeerId, which
 * is why the same message renders correctly until it is re-read from the store.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, vi, beforeEach} from 'vitest';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

const GROUP_ID = 'cafebabe'.repeat(8);
const CONV_ID = `group:${GROUP_ID}`;
const GROUP_PEER_ID = -6000000000000001;
const OWN_PUBKEY = '99'.repeat(32);
const SENDER_PUBKEY = 'bb'.repeat(32);

describe('message-store upsert — an omitted field must not erase the existing row', () => {
  let store: any;

  beforeEach(async() => {
    vi.resetModules();
    const mod = await import('@lib/phantomchat/message-store');
    store = (mod as any).getMessageStore();
  });

  async function seed() {
    await store.saveMessage({
      eventId: 'ev-attr-1',
      conversationId: CONV_ID,
      senderPubkey: SENDER_PUBKEY,
      content: 'hello from a real member',
      type: 'text',
      timestamp: 1_699_000_000,
      mid: 5,
      twebPeerId: Math.abs(GROUP_PEER_ID),
      isOutgoing: false,
      deliveryState: 'delivered'
    });
  }

  it('keeps senderPubkey when a partial write carries it as explicit undefined', async() => {
    await seed();

    // Shape of a device-sync ingest of a legacy row: every field is passed
    // through positionally, so an absent sender arrives as `undefined`.
    await store.saveMessage({
      eventId: 'ev-attr-1',
      conversationId: CONV_ID,
      senderPubkey: undefined,
      content: 'hello from a real member',
      type: 'text',
      timestamp: 1_699_000_000,
      deliveryState: 'read'
    } as any);

    const row = await store.getByEventId('ev-attr-1');
    expect(row.senderPubkey).toBe(SENDER_PUBKEY);   // was: undefined
    expect(row.deliveryState).toBe('read');          // the real update still applied
    expect(row.mid).toBe(5);
  });

  it('does not blank other established fields either', async() => {
    await seed();
    await store.saveMessage({
      eventId: 'ev-attr-1',
      conversationId: CONV_ID,
      senderPubkey: SENDER_PUBKEY,
      content: undefined,
      timestamp: undefined,
      deliveryState: 'read'
    } as any);

    const row = await store.getByEventId('ev-attr-1');
    expect(row.content).toBe('hello from a real member');
    expect(row.timestamp).toBe(1_699_000_000);
  });

  it('still applies a real value — the guard skips undefined, not falsy', async() => {
    await seed();
    // An edit that legitimately clears a caption must still win.
    await store.saveMessage({
      eventId: 'ev-attr-1',
      conversationId: CONV_ID,
      senderPubkey: SENDER_PUBKEY,
      content: '',
      timestamp: 1_699_000_000,
      deliveryState: 'read'
    } as any);

    const row = await store.getByEventId('ev-attr-1');
    expect(row.content).toBe('');
  });
});

describe('getGroupHistory — every rebuilt group bubble carries its sender', () => {
  const mockGetByPeerId = vi.hoisted(() => vi.fn());
  const mockGetMessagesPage = vi.hoisted(() => vi.fn());
  const mockGetTombstone = vi.hoisted(() => vi.fn());

  function storeMock() {
    return {
      getMessageStore: () => ({
        getAllConversationIds: vi.fn().mockResolvedValue([CONV_ID]),
        getTombstone: mockGetTombstone,
        deleteMessages: vi.fn(),
        getMessages: vi.fn().mockResolvedValue([]),
        getMessagesPage: mockGetMessagesPage,
        getConversationId: (a: string, b: string) => [a, b].sort().join(':')
      })
    };
  }
  function groupMock() {
    return {
      getGroupStore: () => ({
        getByPeerId: mockGetByPeerId,
        save: vi.fn(),
        getAll: vi.fn().mockResolvedValue([])
      })
    };
  }

  let VirtualMTProtoServer: any;

  beforeEach(async() => {
    vi.resetModules();
    [mockGetByPeerId, mockGetMessagesPage, mockGetTombstone].forEach((m) => m.mockReset());
    mockGetTombstone.mockResolvedValue(0);
    mockGetByPeerId.mockResolvedValue({
      groupId: GROUP_ID,
      name: 'Phantomyard',
      members: [OWN_PUBKEY, SENDER_PUBKEY],
      adminPubkey: OWN_PUBKEY,
      createdAt: 1
    });
    vi.doMock('@lib/phantomchat/message-store', storeMock);
    vi.doMock('@lib/phantomchat/group-store', groupMock);
    const mod = await import('@lib/phantomchat/virtual-mtproto-server');
    VirtualMTProtoServer = (mod as any).PhantomChatMTProtoServer;
  });

  function buildServer(ownPubkey: string | null = OWN_PUBKEY) {
    const server = new VirtualMTProtoServer();
    (server as any).ownPubkey = ownPubkey;
    return server;
  }

  it('emits from_id for an incoming member message, so the bubble is not attributed to the chat', async() => {
    mockGetMessagesPage.mockResolvedValue({
      messages: [{
        mid: 10, eventId: 'e1', conversationId: CONV_ID, senderPubkey: SENDER_PUBKEY,
        content: 'hello', timestamp: 1_699_000_000, type: 'text',
        deliveryState: 'delivered', isOutgoing: false
      }],
      total: 1,
      offsetIdOffset: 0
    });

    const result = await (buildServer() as any).getGroupHistory(GROUP_PEER_ID, {limit: 50});
    const msg = result.messages[0];

    expect(msg.from_id).toBeDefined();
    expect(msg.from_id._).toBe('peerUser');
    // Never the chat itself — that is exactly what produced the group-as-sender bubble.
    expect(msg.from_id.user_id).not.toBe(GROUP_PEER_ID);
    expect(msg.from_id.user_id).not.toBe(Math.abs(GROUP_PEER_ID));
    // The sender's User rides along so tweb can resolve the title + avatar
    // without a follow-up roundtrip.
    expect(result.users.some((u: any) => u.id === msg.from_id.user_id)).toBe(true);
  });

  it('emits from_id for our own outgoing message too', async() => {
    mockGetMessagesPage.mockResolvedValue({
      messages: [{
        mid: 11, eventId: 'e2', conversationId: CONV_ID, senderPubkey: OWN_PUBKEY,
        content: 'mine', timestamp: 1_699_000_001, type: 'text',
        deliveryState: 'sent', isOutgoing: true
      }],
      total: 1,
      offsetIdOffset: 0
    });

    const result = await (buildServer() as any).getGroupHistory(GROUP_PEER_ID, {limit: 50});
    expect(result.messages[0].from_id).toBeDefined();
    expect(result.users.length).toBe(1);
  });

  it('reports a row that has lost its sender instead of silently mis-attributing it', async() => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGetMessagesPage.mockResolvedValue({
      messages: [{
        mid: 12, eventId: 'e3', conversationId: CONV_ID, senderPubkey: undefined,
        content: 'orphaned by a pre-fix build', timestamp: 1_699_000_002,
        type: 'text', deliveryState: 'delivered', isOutgoing: false
      }],
      total: 1,
      offsetIdOffset: 0
    });

    await (buildServer() as any).getGroupHistory(GROUP_PEER_ID, {limit: 50});

    expect(err).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('no senderPubkey'),
      expect.objectContaining({eventId: 'e3'})
    );
    err.mockRestore();
  });
});
