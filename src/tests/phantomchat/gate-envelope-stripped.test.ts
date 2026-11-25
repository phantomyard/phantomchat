/**
 * #498: a gate-paused turn's control text must never reach a bubble.
 *
 * The engine may deliver its bracketed gate envelope ("[Approval needed …
 * POST /api/v1/gates/<id>/approve …]") as the persona's reply, and the channel
 * publishes it like any other message — leaking internal control-plane
 * endpoints to the conversation (and, in groups, to every member). PhantomChat
 * strips a whole-payload envelope at every receive entry point and stores a
 * neutral placeholder instead: 1:1 live relay receive, group live receive,
 * and group history backfill (the latter two both funnel through
 * handleGroupIncoming). A message that merely QUOTES an envelope is someone
 * talking about the gate and must pass untouched.
 */
import '../setup';
import {describe, it, expect, beforeAll, beforeEach, vi} from 'vitest';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

// ─── Fixtures ────────────────────────────────────────────────────

const GATE_ENVELOPE =
  '[Approval needed to run bash: Approve rm -rf? Answer with POST /api/v1/gates/pi-a4f52d11-0000/approve or POST /api/v1/gates/pi-a4f52d11-0000/deny. The turn is paused; the rest of the answer returns on that response.]';
const SECRET_ENVELOPE =
  '[Secret needed: GITHUB_TOKEN. Answer with POST /api/v1/gates/sec-a4f52d11-0000/secret {"value": "..."} to resume the turn.]';

const APPROVAL_PLACEHOLDER = 'Waiting for the operator to approve this action.';
const SECRET_PLACEHOLDER = 'Waiting for the operator to provide a required secret.';

const OWN_PUBKEY = '33'.repeat(32);
const PHANTOM_PUBKEY = '44'.repeat(32);
const GROUP_ID = 'c1'.repeat(32);
const GROUP_PEER_ID = -6100000000000001;
const NOW = Math.floor(Date.now() / 1000);

// ─── Shared mocks ───────────────────────────────────────────────

const storeMocks = vi.hoisted(() => ({
  saveMessage: vi.fn().mockResolvedValue(undefined),
  getTombstone: vi.fn().mockResolvedValue(0),
  getConversationId: vi.fn().mockReturnValue('conv-gate'),
  hasSeenEventId: vi.fn().mockReturnValue(false),
  getByEventId: vi.fn().mockResolvedValue(null),
  setReadCursor: vi.fn().mockResolvedValue(undefined),
  getMessages: vi.fn().mockResolvedValue([]),
  countUnread: vi.fn().mockResolvedValue(0),
  peekReadCursor: vi.fn().mockReturnValue(0)
}));

vi.mock('@lib/phantomchat/message-store', () => ({
  getMessageStore: () => storeMocks
}));

const {messageRequestMocks, bridgeMocks} = vi.hoisted(() => ({
  messageRequestMocks: {
    isBlocked: vi.fn().mockResolvedValue(false),
    isKnownContact: vi.fn().mockResolvedValue(true),
    addRequest: vi.fn().mockResolvedValue(undefined)
  },
  bridgeMocks: {
    mapPubkeyToPeerId: vi.fn().mockResolvedValue(9999999999),
    mapEventIdToMid: vi.fn().mockResolvedValue(123456),
    storePeerMapping: vi.fn().mockResolvedValue(undefined)
  }
}));

vi.mock('@lib/phantomchat/message-requests', () => ({
  getMessageRequestStore: () => messageRequestMocks
}));

vi.mock('@lib/phantomchat/phantomchat-bridge', () => ({
  PhantomChatBridge: {getInstance: () => bridgeMocks}
}));

vi.mock('@lib/phantomchat/group-store', () => ({
  getGroupStore: () => ({
    get: vi.fn().mockResolvedValue({
      groupId: GROUP_ID,
      name: 'A group',
      kind: 'group',
      adminPubkey: OWN_PUBKEY,
      members: [OWN_PUBKEY, PHANTOM_PUBKEY],
      peerId: GROUP_PEER_ID,
      createdAt: 1_699_000_000,
      updatedAt: 1_699_000_000
    }),
    getByPeerId: vi.fn().mockResolvedValue({groupId: GROUP_ID}),
    getAll: vi.fn().mockResolvedValue([]),
    save: vi.fn()
  })
}));

vi.mock('@lib/phantomchat/group-types', async() => {
  const actual = await vi.importActual<typeof import('@lib/phantomchat/group-types')>('@lib/phantomchat/group-types');
  return {...actual, groupIdToPeerId: vi.fn().mockResolvedValue(GROUP_PEER_ID)};
});

vi.mock('@lib/phantomchat/ensure-sender-user-injected', () => ({
  ensureSenderUserInjected: vi.fn().mockResolvedValue({isNewPeer: false})
}));

vi.mock('@stores/peers', () => ({reconcilePeer: vi.fn()}));

vi.mock('@config/debug', async() => {
  const actual = await vi.importActual<any>('@config/debug');
  return {
    ...actual,
    MOUNT_CLASS_TO: {
      appImManager: {chat: {peerId: 0}, isChatVisible: true},
      apiManagerProxy: {mirrors: {messages: {}, chats: {}, dialogs: {}, peers: {}}}
    }
  };
});

vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn(),
    dispatchEventSingle: vi.fn(),
    addEventListener: vi.fn(),
    managers: {}
  }
}));

// ─── Module handles (loaded after mocks) ─────────────────────────

let matchGateEnvelope: typeof import('@lib/phantomchat/gate-envelope')['matchGateEnvelope'];
let resolveGatePlaceholder: typeof import('@lib/phantomchat/gate-envelope')['resolveGatePlaceholder'];
let setGatePlaceholderResolver: typeof import('@lib/phantomchat/gate-envelope')['setGatePlaceholderResolver'];
let handleRelayMessage: typeof import('@lib/phantomchat/chat-api-receive')['handleRelayMessage'];
let handleGroupIncoming: typeof import('@lib/phantomchat/phantomchat-groups-sync')['handleGroupIncoming'];
let ingestBackfilledGroupHistory: typeof import('@lib/phantomchat/phantomchat-groups-sync')['ingestBackfilledGroupHistory'];

beforeAll(async() => {
  vi.resetModules();
  const gateEnvelope = await import('@lib/phantomchat/gate-envelope');
  matchGateEnvelope = gateEnvelope.matchGateEnvelope;
  resolveGatePlaceholder = gateEnvelope.resolveGatePlaceholder;
  setGatePlaceholderResolver = gateEnvelope.setGatePlaceholderResolver;
  handleRelayMessage = (await import('@lib/phantomchat/chat-api-receive')).handleRelayMessage;
  const groupsSync = await import('@lib/phantomchat/phantomchat-groups-sync');
  handleGroupIncoming = groupsSync.handleGroupIncoming;
  ingestBackfilledGroupHistory = groupsSync.ingestBackfilledGroupHistory;
});

beforeEach(() => {
  // Isolation: no localized resolver leaks between tests.
  setGatePlaceholderResolver(() => undefined);
  storeMocks.saveMessage.mockClear();
  bridgeMocks.mapPubkeyToPeerId.mockClear();
  bridgeMocks.storePeerMapping.mockClear();
});

// ─── Pure matcher ───────────────────────────────────────────────

describe('matchGateEnvelope', () => {
  it('recognizes an approval envelope', () => {
    expect(matchGateEnvelope(GATE_ENVELOPE)).toBe('approval');
  });

  it('recognizes a secret envelope', () => {
    expect(matchGateEnvelope(SECRET_ENVELOPE)).toBe('secret');
  });

  it('tolerates surrounding whitespace', () => {
    expect(matchGateEnvelope('\n  ' + GATE_ENVELOPE + '  \n')).toBe('approval');
  });

  it('leaves a quoted envelope inside a longer message untouched', () => {
    const quoted = 'The turn paused earlier with ' + GATE_ENVELOPE + ' and then resumed.';
    expect(matchGateEnvelope(quoted)).toBeNull();
  });

  it('leaves ordinary bracketed text untouched', () => {
    expect(matchGateEnvelope('[see the wiki for details]')).toBeNull();
    expect(matchGateEnvelope('[Approval needed, said the sign]')).toBeNull();
  });

  it('rejects non-strings and oversized payloads', () => {
    expect(matchGateEnvelope(undefined as any)).toBeNull();
    expect(matchGateEnvelope('')).toBeNull();
    expect(matchGateEnvelope('[' + GATE_ENVELOPE.slice(1, -1) + 'x'.repeat(4000) + ']')).toBeNull();
  });

  it('resolves to the neutral placeholders by default, and honors a wired resolver', () => {
    expect(resolveGatePlaceholder('approval')).toBe(APPROVAL_PLACEHOLDER);
    expect(resolveGatePlaceholder('secret')).toBe(SECRET_PLACEHOLDER);

    setGatePlaceholderResolver((key) => key === 'Chat.Gate.ApprovalPaused' ? 'Wachten op goedkeuring' : undefined);
    expect(resolveGatePlaceholder('approval')).toBe('Wachten op goedkeuring');
    expect(resolveGatePlaceholder('secret')).toBe(SECRET_PLACEHOLDER);

    // A resolver that returns the raw key (I18n with an unloaded pack) must
    // fall back to English, never leak the key into a bubble.
    setGatePlaceholderResolver((key) => key);
    expect(resolveGatePlaceholder('approval')).toBe(APPROVAL_PLACEHOLDER);
  });
});

// ─── 1:1 receive ────────────────────────────────────────────────

describe('1:1 relay receive strips the gate envelope', () => {
  const ctx = () => {
    const log = Object.assign((() => {}) as any, {warn: () => {}, error: () => {}});
    return {
      ownId: OWN_PUBKEY,
      history: [] as any[],
      activePeer: null as string | null,
      deliveryTracker: null as any,
      offlineQueue: null as any,
      onMessage: null as any,
      onEdit: null as any,
      log
    };
  };

  const dm = (id: string, text: string) => ({
    id,
    from: PHANTOM_PUBKEY,
    content: JSON.stringify({id: id + '-app', from: PHANTOM_PUBKEY, to: OWN_PUBKEY, type: 'text', content: text, timestamp: NOW}),
    timestamp: NOW
  });

  beforeEach(async() => {
    const gate = await import('@lib/phantomchat/sender-gate');
    gate.resetSenderGateForTests();
    gate.rememberLocalPhantom(PHANTOM_PUBKEY);
    gate.markContactsSettled();
  });

  it('stores the neutral placeholder for an approval gate, never the endpoints', async() => {
    const result = await handleRelayMessage(dm('gate-event-1', GATE_ENVELOPE), ctx());
    expect(result.action).toBe('received');

    const message = (result as any).message;
    expect(message.content).toBe(APPROVAL_PLACEHOLDER);
    expect(message.content).not.toContain('/api/v1/gates/');

    const saved = storeMocks.saveMessage.mock.calls[0]?.[0];
    expect(saved.content).toBe(APPROVAL_PLACEHOLDER);
  });

  it('stores the secret placeholder for a secret gate', async() => {
    const result = await handleRelayMessage(dm('gate-event-2', SECRET_ENVELOPE), ctx());
    expect((result as any).message.content).toBe(SECRET_PLACEHOLDER);
  });

  it('passes a message that merely quotes an envelope', async() => {
    const quoted = 'The turn paused earlier with ' + GATE_ENVELOPE + ' and then resumed.';
    const result = await handleRelayMessage(dm('gate-event-3', quoted), ctx());
    expect((result as any).message.content).toBe(quoted);
  });

  it('passes ordinary text untouched', async() => {
    const result = await handleRelayMessage(dm('gate-event-4', 'plain hello'), ctx());
    expect((result as any).message.content).toBe('plain hello');
  });

  it('strips the envelope when it rides a FILE CAPTION — the one surface the !fileMetadata guard left raw', async() => {
    const filePayload = JSON.stringify({
      url: 'https://blossom.example/f.png',
      sha256: 'aa'.repeat(32),
      key: 'bb'.repeat(16),
      iv: 'cc'.repeat(8),
      mimeType: 'image/png',
      size: 1024,
      mediaType: 'image',
      caption: GATE_ENVELOPE
    });
    const result = await handleRelayMessage(dm('gate-event-5', filePayload), ctx());
    expect(result.action).toBe('received');

    const message = (result as any).message;
    expect(message.type).toBe('file');
    expect(message.content).toBe(APPROVAL_PLACEHOLDER);
    expect(message.content).not.toContain('/api/v1/gates/');
  });
});

// ─── Group receive (live + backfill) ────────────────────────────

describe('group receive strips the gate envelope', () => {
  const rumor = (id: string, text: string) => ({
    id,
    kind: 14,
    pubkey: PHANTOM_PUBKEY,
    created_at: NOW,
    content: JSON.stringify({content: text, type: 'text', id: id + '-app', timestamp: NOW * 1000}),
    tags: [['group', GROUP_ID]]
  });

  const savedRows = () => storeMocks.saveMessage.mock.calls.map((c: any[]) => c[0]);
  const dispatchedMessages = (dispatch: any) =>
    dispatch.mock.calls.filter((c: any[]) => c[0] === 'phantomchat_new_message').map((c: any[]) => c[1].message);

  it('live receive: stores and dispatches the placeholder, never the endpoints', async() => {
    const dispatch = vi.fn();
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor('ab'.repeat(32), GATE_ENVELOPE), PHANTOM_PUBKEY, dispatch);

    expect(savedRows()[0].content).toBe(APPROVAL_PLACEHOLDER);
    const dispatched = dispatchedMessages(dispatch)[0];
    expect(dispatched.content).toBe(APPROVAL_PLACEHOLDER);
    expect(dispatched.content).not.toContain('/api/v1/gates/');
  });

  it('live receive: secret gate maps to the secret placeholder', async() => {
    const dispatch = vi.fn();
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor('cd'.repeat(32), SECRET_ENVELOPE), PHANTOM_PUBKEY, dispatch);
    expect(savedRows()[0].content).toBe(SECRET_PLACEHOLDER);
  });

  it('live receive: a quoted envelope passes untouched', async() => {
    const quoted = 'The turn paused earlier with ' + GATE_ENVELOPE + ' and then resumed.';
    const dispatch = vi.fn();
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor('ef'.repeat(32), quoted), PHANTOM_PUBKEY, dispatch);
    expect(savedRows()[0].content).toBe(quoted);
  });

  it('history backfill: a replayed envelope from before the fix still stores the placeholder', async() => {
    const dispatch = vi.fn();
    const ingested = await ingestBackfilledGroupHistory(OWN_PUBKEY, GROUP_ID, [{
      rumorId: 'ab'.repeat(32),
      payload: JSON.stringify({content: GATE_ENVELOPE, type: 'text', id: 'bf-app-1', timestamp: 1_699_000_000_000}),
      createdAt: 1_699_000_000,
      senderPubkey: PHANTOM_PUBKEY
    }], dispatch);
    expect(ingested).toBe(1);
    expect(savedRows()[0].content).toBe(APPROVAL_PLACEHOLDER);
  });

  it('ordinary group text passes untouched', async() => {
    const dispatch = vi.fn();
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor('12'.repeat(32), 'just chatting'), PHANTOM_PUBKEY, dispatch);
    expect(savedRows()[0].content).toBe('just chatting');
  });

  it('live receive: a file whose CAPTION is the whole envelope is stripped — the surface the !fileMetadata guard left raw', async() => {
    const dispatch = vi.fn();
    const fileRumor = {
      id: '56'.repeat(32),
      kind: 14,
      pubkey: PHANTOM_PUBKEY,
      created_at: NOW,
      content: JSON.stringify({
        content: GATE_ENVELOPE,
        type: 'image',
        id: '56'.repeat(32) + '-app',
        timestamp: NOW * 1000,
        fileMetadata: {
          url: 'https://blossom.example/f.png',
          sha256: 'aa'.repeat(32),
          keyHex: 'bb'.repeat(16),
          ivHex: 'cc'.repeat(8),
          mimeType: 'image/png',
          size: 1024
        }
      }),
      tags: [['group', GROUP_ID]]
    };
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, fileRumor, PHANTOM_PUBKEY, dispatch);

    expect(savedRows()[0].content).toBe(APPROVAL_PLACEHOLDER);
    expect(savedRows()[0].content).not.toContain('/api/v1/gates/');
  });
});
