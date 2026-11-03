/**
 * Voice-note waveform + media class must survive the wire and the store.
 *
 * Field symptoms (Phantomyard Desktop, a group session):
 *  - the sender's own voice notes drew a flat progress line instead of bars.
 *    The composer's recorder hands over a Uint8Array; it went onto the wire
 *    unconverted (JSON.stringify makes it {"0":n,...}, which every receiver's
 *    string guard dropped) and into the sender's own stored row as raw bytes,
 *    which the stored-row builder could not read.
 *  - a bot's group voice note without duration/waveform came back as a
 *    generic "file-<mid> 0:00" attachment after a reload, because the stored
 *    group row lost the rumor's top-level `type: 'voice'`.
 */
import '../setup';
import {describe, it, expect, beforeAll, beforeEach, vi} from 'vitest';
import {buildPhantomChatMedia, waveformToBase64} from '@lib/phantomchat/phantomchat-media-shape';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

const GROUP_ID = 'c1'.repeat(32);
const GROUP_PEER_ID = -6100000000000001;
const OWN_PUBKEY = '33'.repeat(32);
const SENDER_PUBKEY = '44'.repeat(32);
const RUMOR_ID = 'ab'.repeat(32);

const FILE_METADATA = {
  url: 'http://localhost/blossom/abc',
  sha256: 'ff'.repeat(32),
  keyHex: '00'.repeat(32),
  ivHex: '11'.repeat(16),
  mimeType: 'audio/ogg',
  size: 4096,
  duration: 3,
  waveform: 'AAAA'
};

const mocks = vi.hoisted(() => ({
  dispatchEvent: vi.fn(),
  saveMessage: vi.fn().mockResolvedValue(undefined),
  im: {chat: {peerId: 0}, isChatVisible: true},
  managers: {} as any
}));

vi.mock('@lib/phantomchat/message-store', () => ({
  getMessageStore: () => ({
    getTombstone: vi.fn().mockResolvedValue(0),
    setReadCursor: vi.fn().mockResolvedValue(undefined),
    saveMessage: mocks.saveMessage,
    getByEventId: vi.fn().mockResolvedValue(null),
    getMessages: vi.fn().mockResolvedValue([]),
    hasSeenEventId: vi.fn().mockReturnValue(false),
    countUnread: vi.fn().mockResolvedValue(0),
    getConversationId: vi.fn().mockReturnValue('conv'),
    peekReadCursor: vi.fn().mockReturnValue(0)
  })
}));

vi.mock('@lib/phantomchat/group-store', () => ({
  getGroupStore: () => ({
    get: vi.fn().mockResolvedValue({
      groupId: GROUP_ID,
      name: 'A group',
      kind: 'group',
      adminPubkey: OWN_PUBKEY,
      members: [OWN_PUBKEY, SENDER_PUBKEY],
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
      appImManager: mocks.im,
      apiManagerProxy: {mirrors: {messages: {}, chats: {}, dialogs: {}, peers: {}}}
    }
  };
});

vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: mocks.dispatchEvent,
    dispatchEventSingle: vi.fn(),
    addEventListener: vi.fn(),
    managers: mocks.managers
  }
}));


// What the composer's recorder produces (5-bit packed bytes).
const RECORDED = new Uint8Array([0x21, 0x84, 0x10, 0xff, 0x3c, 0x91, 0x42, 0x08, 0xa5, 0x7e]);

const fm = (waveform: unknown, extra: any = {}) => ({
  url: 'u', sha256: 's', mimeType: 'audio/ogg', size: 10, keyHex: 'k', ivHex: 'i',
  duration: 5, waveform, mediaType: 'voice', ...extra
}) as any;

const barsOf = (media: any) => {
  const attr = media.document.attributes.find((a: any) => a._ === 'documentAttributeAudio');
  // AudioElement feeds this straight into decodeWaveform, which needs the
  // packed bytes themselves (not base64, not an index-keyed object).
  return attr.waveform instanceof Uint8Array ? Array.from(attr.waveform) : [];
};

describe('waveformToBase64', () => {
  const expected = btoa(String.fromCharCode(...RECORDED));
  it('accepts every shape a waveform has been seen in', () => {
    expect(waveformToBase64(RECORDED)).toBe(expected);
    expect(waveformToBase64(Array.from(RECORDED))).toBe(expected);
    expect(waveformToBase64(JSON.parse(JSON.stringify(RECORDED))), 'index-keyed object already on relays').toBe(expected);
    expect(waveformToBase64(expected)).toBe(expected);
  });
  it('returns undefined for empty or junk input', () => {
    expect(waveformToBase64(undefined)).toBeUndefined();
    expect(waveformToBase64('')).toBeUndefined();
    expect(waveformToBase64(new Uint8Array())).toBeUndefined();
    expect(waveformToBase64({a: 1})).toBeUndefined();
    expect(waveformToBase64(42)).toBeUndefined();
  });
});

describe('stored voice row → bubble bars', () => {
  const want = Array.from(RECORDED);
  it('draws bars from a row holding the raw recorder bytes (sender, pre-fix rows)', () => {
    expect(barsOf(buildPhantomChatMedia(1, fm(RECORDED)))).toEqual(want);
  });
  it('draws bars from the index-keyed object a receiver got off the wire', () => {
    expect(barsOf(buildPhantomChatMedia(1, fm(JSON.parse(JSON.stringify(RECORDED)))))).toEqual(want);
  });
  it('draws bars from a base64 row', () => {
    expect(barsOf(buildPhantomChatMedia(1, fm(waveformToBase64(RECORDED))))).toEqual(want);
  });
});

let handleGroupIncoming: typeof import('@lib/phantomchat/phantomchat-groups-sync')['handleGroupIncoming'];

function groupVoiceRumor(id: string, fileMetadata: any) {
  return {
    id,
    kind: 14,
    pubkey: SENDER_PUBKEY,
    created_at: 1_699_000_100,
    content: JSON.stringify({id: 'grp-voice-' + id.slice(0, 4), content: '', type: 'voice', timestamp: 1_699_000_100_000, fileMetadata}),
    tags: [['group', GROUP_ID]]
  };
}

describe('group voice receive → stored row', () => {
  beforeAll(async() => {
    vi.resetModules();
    handleGroupIncoming = (await import('@lib/phantomchat/phantomchat-groups-sync')).handleGroupIncoming;
  });

  beforeEach(() => {
    mocks.saveMessage.mockClear();
    Object.assign(mocks.managers, {
      appMessagesManager: {
        setMessageToStorage: vi.fn().mockResolvedValue(undefined),
        invalidateHistoryCache: vi.fn().mockResolvedValue(undefined),
        setDialogTopMessage: vi.fn().mockResolvedValue(undefined),
        appendLocalHistoryMessage: vi.fn().mockResolvedValue(undefined)
      },
      appChatsManager: {saveApiChat: vi.fn().mockResolvedValue(undefined)},
      dialogsStorage: {setLocalDialogUnreadCount: vi.fn().mockResolvedValue(undefined)}
    });
  });

  const savedRow = () => mocks.saveMessage.mock.calls.at(-1)?.[0];

  it('persists the rumor type so a reload still renders a voice note without duration/waveform', async() => {
    // Bot TTS that is not Ogg/Opus ships neither duration nor waveform.
    const {duration, waveform, ...bare} = FILE_METADATA;
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, groupVoiceRumor('a1'.repeat(32), bare), SENDER_PUBKEY, vi.fn());

    const row = savedRow();
    expect(row?.fileMetadata?.mediaType).toBe('voice');
    const media = buildPhantomChatMedia(row.mid, row.fileMetadata);
    expect(media.document.attributes.some((a: any) => a.pFlags?.voice), 'reload renders a voice player, not file-<mid>').toBe(true);
  });

  it('keeps a waveform that arrived as the JSON form of a Uint8Array', async() => {
    const wire = JSON.parse(JSON.stringify({...FILE_METADATA, waveform: RECORDED}));
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, groupVoiceRumor('a2'.repeat(32), wire), SENDER_PUBKEY, vi.fn());

    expect(savedRow()?.fileMetadata?.waveform).toBe(waveformToBase64(RECORDED));
  });
});
