/**
 * #391: an outgoing row must carry our own from_id on every read path, the
 * way injectOutgoingBubble stamps the live bubble. getDialogs (1:1 and group),
 * 1:1 getHistory and searchMessages used to pass no sender for outgoing rows;
 * tweb then falls back to `fromId = peer_id`, so a reloaded group bubble and
 * the dialog preview were attributed to the chat itself.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, vi, beforeEach} from 'vitest';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

const OWN = '99'.repeat(32);
const PEER = 'bb'.repeat(32);
const DM_CONV = [OWN, PEER].sort().join(':');
const GROUP_ID = 'cafebabe'.repeat(8);
const GROUP_CONV = `group:${GROUP_ID}`;
const GROUP_PEER_ID = -6000000000000001;
const OWN_PEER_ID = 1000001;
const PEER_PEER_ID = 1000002;

const rows = vi.hoisted(() => ({dm: [] as any[], group: [] as any[]}));

function row(mid: number, convId: string, isOutgoing: boolean, extra: any = {}) {
  return {
    mid, eventId: 'e' + mid, conversationId: convId,
    senderPubkey: isOutgoing ? OWN : PEER, content: 'needle ' + mid,
    timestamp: 1_699_000_000 + mid, type: 'text',
    deliveryState: isOutgoing ? 'sent' : 'delivered', isOutgoing, ...extra
  };
}

describe('outgoing rows are self-attributed on every read path (#391)', () => {
  let server: any;

  beforeEach(async() => {
    vi.resetModules();
    vi.doMock('@lib/phantomchat/message-store', () => ({
      getMessageStore: () => ({
        getAllConversationIds: async() => [DM_CONV, GROUP_CONV],
        getMessages: async(convId: string) => (convId === DM_CONV ? rows.dm : rows.group).slice().reverse(),
        getMessagesPage: async(convId: string) => {
          const messages = convId === DM_CONV ? rows.dm : rows.group;
          return {messages, total: messages.length, offsetIdOffset: 0};
        },
        getReadCursor: async() => 0,
        countUnread: async() => 0,
        getTombstone: async() => 0,
        deleteMessages: vi.fn(),
        getConversationId: (a: string, b: string) => [a, b].sort().join(':')
      })
    }));
    vi.doMock('@lib/phantomchat/group-store', () => {
      const group = {groupId: GROUP_ID, name: 'Phantomyard', peerId: GROUP_PEER_ID, members: [OWN, PEER], adminPubkey: OWN, createdAt: 1};
      return {getGroupStore: () => ({getAll: async() => [group], getByPeerId: async() => group, save: vi.fn()})};
    });
    vi.doMock('@lib/phantomchat/virtual-peers-db', async() => ({
      ...(await vi.importActual<any>('@lib/phantomchat/virtual-peers-db')),
      getPubkey: async(peerId: number) => (peerId === PEER_PEER_ID ? PEER : null),
      getMapping: async(): Promise<any> => undefined
    }));
    const mod = await import('@lib/phantomchat/virtual-mtproto-server');
    server = new (mod as any).PhantomChatMTProtoServer();
    server.ownPubkey = OWN;
    server.mapper.mapPubkey = async(pubkey: string) => (pubkey === OWN ? OWN_PEER_ID : PEER_PEER_ID);
  });

  it('getDialogs: 1:1 and group top messages carry our own from_id', async() => {
    rows.dm = [row(1, DM_CONV, true)];
    rows.group = [row(2, GROUP_CONV, true)];

    const result = await server.getDialogs({});
    const dm = result.messages.find((m: any) => m.id === 1);
    const group = result.messages.find((m: any) => m.id === 2);

    expect(dm.from_id).toEqual({_: 'peerUser', user_id: OWN_PEER_ID});
    expect(group.from_id).toEqual({_: 'peerUser', user_id: OWN_PEER_ID});
  });

  it('getDialogs: an outgoing group create row is self-attributed too', async() => {
    rows.dm = [];
    rows.group = [row(3, GROUP_CONV, true, {serviceType: 'chatCreate', content: '', servicePayload: {title: 'S', memberPeerIds: []}})];

    const result = await server.getDialogs({});
    const create = result.messages.find((m: any) => m.id === 3);
    expect(create._).toBe('messageService');
    expect(create.from_id).toEqual({_: 'peerUser', user_id: OWN_PEER_ID});
  });

  it('getHistory (1:1): outgoing rows are ours, incoming rows the peer', async() => {
    rows.dm = [row(4, DM_CONV, true), row(5, DM_CONV, false)];

    const result = await server.getHistory({peer: {_: 'inputPeerUser', user_id: PEER_PEER_ID}, limit: 50});
    const byId = new Map(result.messages.map((m: any) => [m.id, m]));
    expect((byId.get(4) as any).from_id).toEqual({_: 'peerUser', user_id: OWN_PEER_ID});
    expect((byId.get(5) as any).from_id).toEqual({_: 'peerUser', user_id: PEER_PEER_ID});
  });

  it('searchMessages: an outgoing hit carries our own from_id', async() => {
    rows.dm = [row(6, DM_CONV, true)];

    const result = await server.searchMessages({q: 'needle'});
    const hit = result.messages.find((m: any) => m.id === 6);
    expect(hit.from_id).toEqual({_: 'peerUser', user_id: OWN_PEER_ID});
  });

  it('clamps to no sender, loudly, when our own pubkey is unresolved', async() => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    server.ownPubkey = null;
    rows.dm = [row(7, DM_CONV, true)];

    const result = await server.getHistory({peer: {_: 'inputPeerUser', user_id: PEER_PEER_ID}, limit: 50});
    const msg = result.messages.find((m: any) => m.id === 7);
    expect(msg && msg.from_id).toBeUndefined();
    expect(err).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('getHistory: own pubkey unresolved'));
    err.mockRestore();
  });

  it('getGroupHistory: a create row with no sender emits from_id 0, not undefined', async() => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    rows.group = [row(8, GROUP_CONV, false, {senderPubkey: undefined, serviceType: 'chatCreate', content: '', servicePayload: {title: 'S', memberPeerIds: []}})];

    const result = await server.getGroupHistory(GROUP_PEER_ID, {limit: 50});
    expect(result.messages[0].from_id).toEqual({_: 'peerUser', user_id: 0});
    err.mockRestore();
  });
});
