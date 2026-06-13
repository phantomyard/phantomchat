/**
 * Tests for NostraSync
 *
 * Verifies incoming message persistence, event dispatch, and
 * profile/presence update handling.
 */

import '../setup';
import {describe, it, expect, beforeEach, vi} from 'vitest';

// Mock NostraPeerMapper — must be declared before any imports that pull it
vi.mock('@lib/nostra/nostra-peer-mapper', () => {
  return {
    NostraPeerMapper: vi.fn().mockImplementation(() => ({
      mapPubkey: vi.fn().mockResolvedValue(1000000000000001),
      mapEventId: vi.fn().mockResolvedValue(2000000001)
    }))
  };
});

// Mock message-store — all vars defined inside factory to avoid hoisting issues
vi.mock('@lib/nostra/message-store', () => {
  return {
    getMessageStore: vi.fn().mockReturnValue({
      saveMessage: vi.fn().mockResolvedValue(undefined),
      getConversationId: vi.fn().mockReturnValue('aaa:bbb')
    })
  };
});

import {NostraSync} from '@lib/nostra/nostra-sync';
import {NostraPeerMapper} from '@lib/nostra/nostra-peer-mapper';
import {getMessageStore} from '@lib/nostra/message-store';

const OWN_PUBKEY = 'aaaa'.repeat(16);
const SENDER_PUBKEY = 'bbbb'.repeat(16);

const makeTextMsg = (): any => ({
  id: 'evt-abc123',
  from: SENDER_PUBKEY,
  to: OWN_PUBKEY,
  type: 'text',
  content: 'Hello world',
  timestamp: 1712345678000,
  status: 'delivered'
});

const makeFileMsg = (): any => ({
  id: 'evt-file456',
  from: SENDER_PUBKEY,
  to: OWN_PUBKEY,
  type: 'image',
  content: '',
  timestamp: 1712345679000,
  status: 'delivered',
  fileMetadata: {
    url: 'https://example.com/img.jpg',
    sha256: 'deadbeef',
    mimeType: 'image/jpeg',
    size: 12345,
    keyHex: 'key',
    ivHex: 'iv'
  }
});

describe('NostraSync', () => {
  let sync: NostraSync;
  let dispatch: ReturnType<typeof vi.fn>;
  let storeMock: ReturnType<typeof getMessageStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-register the per-test mock store so saveMessage/getConversationId are fresh
    (getMessageStore as ReturnType<typeof vi.fn>).mockReturnValue({
      saveMessage: vi.fn().mockResolvedValue(undefined),
      getConversationId: vi.fn().mockReturnValue('aaa:bbb')
    });
    storeMock = getMessageStore();
    dispatch = vi.fn();
    sync = new NostraSync(OWN_PUBKEY, dispatch);
  });

  // ─── onIncomingMessage ────────────────────────────────────────────

  describe('onIncomingMessage', () => {
    it('saves to message store with correct fields', async() => {
      const msg = makeTextMsg();
      await sync.onIncomingMessage(msg, SENDER_PUBKEY);

      expect(storeMock.saveMessage).toHaveBeenCalledOnce();
      const saved = (storeMock.saveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(saved.eventId).toBe(msg.id);
      expect(saved.conversationId).toBe('aaa:bbb');
      expect(saved.senderPubkey).toBe(SENDER_PUBKEY);
      expect(saved.content).toBe('Hello world');
      expect(saved.type).toBe('text');
      expect(saved.deliveryState).toBe('delivered');
      expect(saved.isOutgoing).toBe(false);
      expect(saved.mid).toBe(2000000001);
      expect(saved.twebPeerId).toBe(1000000000000001);
    });

    it('dispatches nostra_new_message event with peerId and mid', async() => {
      const msg = makeTextMsg();
      await sync.onIncomingMessage(msg, SENDER_PUBKEY);

      expect(dispatch).toHaveBeenCalledOnce();
      const [eventName, data] = dispatch.mock.calls[0];
      expect(eventName).toBe('nostra_new_message');
      expect(data.peerId).toBe(1000000000000001);
      expect(data.mid).toBe(2000000001);
      expect(data.senderPubkey).toBe(SENDER_PUBKEY);
      expect(data.message).toBe(msg);
    });

    it('preserves UNIX-seconds timestamp (no ms→s conversion)', async() => {
      const msg = makeTextMsg();
      await sync.onIncomingMessage(msg, SENDER_PUBKEY);

      const saved = (storeMock.saveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // msg.timestamp comes from rumor.created_at which is already in UNIX seconds;
      // NostraSync uses Math.floor(msg.timestamp) without dividing by 1000
      expect(saved.timestamp).toBe(1712345678000);

      const [, data] = dispatch.mock.calls[0];
      expect(data.timestamp).toBe(1712345678000);
    });

    it('handles file messages with fileMetadata (type !== text)', async() => {
      const msg = makeFileMsg();
      await sync.onIncomingMessage(msg, SENDER_PUBKEY);

      const saved = (storeMock.saveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(saved.type).toBe('file');
      expect(saved.fileMetadata).toEqual(msg.fileMetadata);
    });

    it('does not include fileMetadata when absent', async() => {
      const msg = makeTextMsg();
      await sync.onIncomingMessage(msg, SENDER_PUBKEY);

      const saved = (storeMock.saveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(saved.fileMetadata).toBeUndefined();
    });
  });

  // ─── onProfileUpdate ─────────────────────────────────────────────

  describe('onProfileUpdate', () => {
    it('dispatches nostra_profile_update with displayName from display_name', async() => {
      await sync.onProfileUpdate(SENDER_PUBKEY, {
        display_name: 'Alice Nostra',
        name: 'alice',
        about: 'Bio here',
        picture: 'https://example.com/pic.jpg'
      });

      expect(dispatch).toHaveBeenCalledOnce();
      const [eventName, data] = dispatch.mock.calls[0];
      expect(eventName).toBe('nostra_profile_update');
      expect(data.peerId).toBe(1000000000000001);
      expect(data.pubkey).toBe(SENDER_PUBKEY);
      expect(data.displayName).toBe('Alice Nostra');
      expect(data.about).toBe('Bio here');
      expect(data.picture).toBe('https://example.com/pic.jpg');
    });

    it('falls back to name when display_name is absent', async() => {
      await sync.onProfileUpdate(SENDER_PUBKEY, {name: 'alice'});

      const [, data] = dispatch.mock.calls[0];
      expect(data.displayName).toBe('alice');
    });

    it('dispatches undefined displayName when neither field set', async() => {
      await sync.onProfileUpdate(SENDER_PUBKEY, {about: 'no name'});

      const [, data] = dispatch.mock.calls[0];
      expect(data.displayName).toBeUndefined();
    });
  });

  // ─── onPresenceUpdate ─────────────────────────────────────────────

  describe('onPresenceUpdate', () => {
    it('dispatches nostra_presence_update with status', async() => {
      await sync.onPresenceUpdate(SENDER_PUBKEY, 'online');

      expect(dispatch).toHaveBeenCalledOnce();
      const [eventName, data] = dispatch.mock.calls[0];
      expect(eventName).toBe('nostra_presence_update');
      expect(data.peerId).toBe(1000000000000001);
      expect(data.pubkey).toBe(SENDER_PUBKEY);
      expect(data.status).toBe('online');
    });

    it('passes through offline and recently status values', async() => {
      await sync.onPresenceUpdate(SENDER_PUBKEY, 'offline');
      expect(dispatch.mock.calls[0][1].status).toBe('offline');

      dispatch.mockClear();
      await sync.onPresenceUpdate(SENDER_PUBKEY, 'recently');
      expect(dispatch.mock.calls[0][1].status).toBe('recently');
    });
  });
});
