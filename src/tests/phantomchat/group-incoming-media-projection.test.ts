/**
 * A live group voice note must reach the projection handler as a MEDIA message
 * attributed to the SENDER.
 *
 * Symptom from the field: recording a voice note in an open group, then the
 * peer's voice note showed up only after switching chats and coming back.
 *
 * Chain: handleGroupIncoming persists the row and dispatches
 * `phantomchat_new_message`, which the shared projection handler
 * (handleIncomingMessage → injectIntoMirrors → appendLocalHistoryMessage)
 * turns into a SECOND tweb message for the same mid. The group dispatch used
 * to carry neither `fileMetadata` nor the sender's peer id, so that copy had no
 * `media` and was attributed to the group. bubbles.ts renders from whatever the
 * history storage holds for the mid, so whenever the lossy copy won the race
 * wrapDocument threw on `message.media.document` and the bubble was dropped
 * until the chat was reopened from IndexedDB.
 *
 * The dispatch payload is the contract between the two writers — these tests
 * fail if it loses either half again.
 */
import '../setup';
import {describe, it, expect, beforeAll, beforeEach, vi} from 'vitest';

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
  im: {chat: {peerId: 0}, isChatVisible: true},
  managers: {} as any
}));

vi.mock('@lib/phantomchat/message-store', () => ({
  getMessageStore: () => ({
    getTombstone: vi.fn().mockResolvedValue(0),
    setReadCursor: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn().mockResolvedValue(undefined),
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

let handleGroupIncoming: typeof import('@lib/phantomchat/phantomchat-groups-sync')['handleGroupIncoming'];
let buildTwebMessage: typeof import('@lib/phantomchat/phantomchat-message-handler')['buildTwebMessage'];

function voiceRumor(id: string) {
  return {
    id,
    kind: 14,
    pubkey: SENDER_PUBKEY,
    created_at: 1_699_000_100,
    content: JSON.stringify({
      id: 'grp-voice-1',
      content: '',
      type: 'voice',
      timestamp: 1_699_000_100_000,
      fileMetadata: FILE_METADATA
    }),
    tags: [['group', GROUP_ID]]
  };
}

const newMessagePayload = (dispatch: any) => {
  const call = dispatch.mock.calls.find((c: any[]) => c[0] === 'phantomchat_new_message');
  return call?.[1];
};

describe('group receive → projection payload', () => {
  beforeAll(async() => {
    vi.resetModules();
    handleGroupIncoming = (await import('@lib/phantomchat/phantomchat-groups-sync')).handleGroupIncoming;
    buildTwebMessage = (await import('@lib/phantomchat/phantomchat-message-handler')).buildTwebMessage;
  });

  beforeEach(() => {
    mocks.dispatchEvent.mockClear();
    mocks.im.chat.peerId = 0;
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

  it('carries the file metadata so the projected message has media', async() => {
    const dispatch = vi.fn();
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, voiceRumor(RUMOR_ID), SENDER_PUBKEY, dispatch);

    const payload = newMessagePayload(dispatch);
    expect(payload, 'phantomchat_new_message must be dispatched').toBeTruthy();
    expect(payload.message.fileMetadata).toMatchObject({
      url: FILE_METADATA.url,
      duration: FILE_METADATA.duration,
      mediaType: 'voice'
    });

    const msg = buildTwebMessage(payload);
    expect(msg.media?._, 'a voice note must project as a media message').toBe('messageMediaDocument');
    expect(msg.media.document.attributes?.[0]?.pFlags?.voice).toBe(true);
  });

  it('carries the sender peer id so the projected bubble is not attributed to the group', async() => {
    const dispatch = vi.fn();
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, voiceRumor(RUMOR_ID), SENDER_PUBKEY, dispatch);

    const payload = newMessagePayload(dispatch);
    expect(payload.fromPeerId, 'the sender peer id must travel with the payload').toBeTruthy();
    expect(payload.fromPeerId).not.toBe(GROUP_PEER_ID);

    const msg = buildTwebMessage(payload);
    expect(msg.fromId).toBe(payload.fromPeerId);
    expect(msg.fromId).not.toBe(GROUP_PEER_ID);
  });

  it('keeps the caption as the bubble text of a file message', async() => {
    const dispatch = vi.fn();
    const rumor = voiceRumor('cd'.repeat(32));
    const parsed = JSON.parse(rumor.content);
    parsed.content = 'listen to this';
    rumor.content = JSON.stringify(parsed);

    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor, SENDER_PUBKEY, dispatch);

    const msg = buildTwebMessage(newMessagePayload(dispatch));
    expect(msg.message).toBe('listen to this');
  });

  it('carries the direction so an own echo does not project as incoming', async() => {
    const dispatch = vi.fn();
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, voiceRumor(RUMOR_ID), OWN_PUBKEY, dispatch);

    const payload = newMessagePayload(dispatch);
    expect(payload.isOutgoing, 'the direction must travel with the payload').toBe(true);
    expect(buildTwebMessage(payload).pFlags.out, 'an own echo renders on our side').toBe(true);
  });

  it('projects a peer message as incoming', async() => {
    const dispatch = vi.fn();
    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, voiceRumor(RUMOR_ID), SENDER_PUBKEY, dispatch);

    expect(buildTwebMessage(newMessagePayload(dispatch)).pFlags.out).toBeUndefined();
  });

  it('keeps a caption that only the metadata carries', async() => {
    const dispatch = vi.fn();
    const rumor = voiceRumor('cd'.repeat(32));
    const parsed = JSON.parse(rumor.content);
    parsed.content = '';
    parsed.fileMetadata = {...FILE_METADATA, caption: 'from the metadata'};
    rumor.content = JSON.stringify(parsed);

    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor, SENDER_PUBKEY, dispatch);

    expect(buildTwebMessage(newMessagePayload(dispatch)).message).toBe('from the metadata');
  });

  it('does not add a media payload to a text message', async() => {
    const dispatch = vi.fn();
    const rumor = {
      id: 'ef'.repeat(32),
      kind: 14,
      pubkey: SENDER_PUBKEY,
      created_at: 1_699_000_100,
      content: JSON.stringify({id: 'grp-text-1', content: 'hello', type: 'text', timestamp: 1_699_000_100_000}),
      tags: [['group', GROUP_ID]]
    };

    await handleGroupIncoming(OWN_PUBKEY, GROUP_ID, rumor, SENDER_PUBKEY, dispatch);

    const payload = newMessagePayload(dispatch);
    expect(payload.message.fileMetadata).toBeUndefined();
    expect(buildTwebMessage(payload).media).toBeUndefined();
  });
});

describe('pickRenderableMessage — one mid, two writers', () => {
  let pickRenderableMessage: typeof import('@lib/phantomchat/phantomchat-media-shape')['pickRenderableMessage'];
  let hasRenderableMedia: typeof import('@lib/phantomchat/phantomchat-media-shape')['hasRenderableMedia'];
  let healLossyCopy: typeof import('@lib/phantomchat/phantomchat-media-shape')['healLossyCopy'];

  beforeAll(async() => {
    ({
      pickRenderableMessage,
      hasRenderableMedia,
      healLossyCopy
    } = await import('@lib/phantomchat/phantomchat-media-shape'));
  });

  const media = {_: 'messageMediaDocument', document: {_: 'document'}};
  const withMedia = {mid: 7, peerId: -100, media};
  const mediaLess = {mid: 7, peerId: -100};

  it('falls back to the caller when the stored copy lost its media', () => {
    expect(pickRenderableMessage(mediaLess, withMedia)).toBe(withMedia);
  });

  it('keeps the stored copy when it still has media', () => {
    expect(pickRenderableMessage(withMedia, withMedia)).toBe(withMedia);
  });

  it('keeps the stored copy when neither has media', () => {
    expect(pickRenderableMessage(mediaLess, mediaLess)).toBe(mediaLess);
  });

  it('falls back when history storage has no copy at all', () => {
    expect(pickRenderableMessage(undefined, withMedia)).toBe(withMedia);
  });

  // Album rendering calls this per mid while holding ONE message (the root).
  // Returning the root for a sibling mid would stamp the album slot with the
  // root's document and leave the sibling's file missing — silently wrong.
  it('never substitutes a DIFFERENT message, even when that one renders', () => {
    const siblingStored = {mid: 8, peerId: -100};
    const siblingWithMedia = {mid: 8, peerId: -100, media};
    expect(pickRenderableMessage(siblingStored, withMedia)).toBe(siblingStored);
    expect(pickRenderableMessage(undefined, withMedia)).toBe(withMedia);
  });

  it('does not substitute a same-mid message from another peer', () => {
    const otherPeerCopy = {...withMedia, peerId: -200};
    expect(pickRenderableMessage(mediaLess, otherPeerCopy)).toBe(mediaLess);
  });

  it('treats a hollow media object as unrenderable', () => {
    // `media` set but no document: wrapDocument dereferences
    // `media.document || media.webpage.document` and throws on exactly this.
    const hollow = {mid: 7, peerId: -100, media: {_: 'messageMediaEmpty'}};
    expect(hasRenderableMedia(hollow)).toBe(false);
    expect(hasRenderableMedia(withMedia)).toBe(true);
    expect(hasRenderableMedia(mediaLess)).toBe(false);
    expect(pickRenderableMessage(hollow, withMedia)).toBe(withMedia);
  });

  describe('healLossyCopy', () => {
    const ROW = {type: 'file', content: 'the caption', fileMetadata: FILE_METADATA};

    it('re-derives media from the raw stored row', async() => {
      const healed: any = await healLossyCopy(mediaLess, 7, async() => ROW as any);
      expect(hasRenderableMedia(healed)).toBe(true);
      expect(healed.media.document.attributes?.[0]?.pFlags?.voice).toBe(true);
      expect(healed.message).toBe('the caption');
      expect(healed.mid, 'the copy keeps its identity').toBe(7);
    });

    it('leaves a copy with media alone and never touches the store', async() => {
      const load = vi.fn();
      expect(await healLossyCopy(withMedia, 7, load)).toBe(withMedia);
      expect(load).not.toHaveBeenCalled();
    });

    it('returns the copy untouched when the row is gone or media-less', async() => {
      expect(await healLossyCopy(mediaLess, 7, async() => null)).toBe(mediaLess);
      expect(await healLossyCopy(mediaLess, 7, async() => ({type: 'text', content: 'hi'}))).toBe(mediaLess);
    });

    it('swallows a failing lookup rather than breaking the render', async() => {
      const copy = {...mediaLess, message: 'keep me'};
      const healed: any = await healLossyCopy(copy, 7, async() => {
        throw new Error('idb closed');
      });
      expect(healed).toBe(copy);
    });
  });
});
