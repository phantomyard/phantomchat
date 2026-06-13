/**
 * Tests for NostraPeerMapper
 *
 * Verifies that createTwebUser, createTwebMessage, createTwebDialog,
 * and createTwebChat produce correctly-shaped tweb-native objects.
 */

import '../setup';
import {describe, it, expect} from 'vitest';

// Polyfill Number.prototype.toPeerId (tweb runtime addition, not available in test)
if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

import {NostraPeerMapper} from '@lib/nostra/nostra-peer-mapper';

const SAMPLE_PUBKEY = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const SAMPLE_PEER_ID = 1234567890123456;

describe('NostraPeerMapper', () => {
  let mapper: NostraPeerMapper;

  // Fresh instance per test
  const getMapper = () => new NostraPeerMapper();

  // ─── createTwebUser ───────────────────────────────────────────────

  describe('createTwebUser', () => {
    it('creates a user with provided firstName', () => {
      mapper = getMapper();
      const user = mapper.createTwebUser({
        peerId: SAMPLE_PEER_ID,
        firstName: 'Alice',
        pubkey: SAMPLE_PUBKEY
      });

      expect(user._).toBe('user');
      expect(user.id).toBe(SAMPLE_PEER_ID);
      expect(user.first_name).toBe('Alice');
      expect(user.pFlags).toEqual({});
      expect(user.access_hash).toBe('0');
      expect((user.status as any)._).toBe('userStatusRecently');
      expect((user.status as any).pFlags).toEqual({by_me: true});
    });

    it('falls back to pubkey prefix when firstName is not provided', () => {
      mapper = getMapper();
      const user = mapper.createTwebUser({
        peerId: SAMPLE_PEER_ID,
        pubkey: SAMPLE_PUBKEY
      });

      expect(user._).toBe('user');
      expect(user.first_name).toBe(SAMPLE_PUBKEY.slice(0, 12));
    });

    it('includes lastName when provided', () => {
      mapper = getMapper();
      const user = mapper.createTwebUser({
        peerId: SAMPLE_PEER_ID,
        firstName: 'Bob',
        lastName: 'Smith',
        pubkey: SAMPLE_PUBKEY
      });

      expect(user.first_name).toBe('Bob');
      expect(user.last_name).toBe('Smith');
    });
  });

  // ─── createTwebMessage ───────────────────────────────────────────

  describe('createTwebMessage', () => {
    const MID = 1000000000001;
    const DATE = 1712345678;
    const TEXT = 'Hello world';

    it('creates an outgoing message with pFlags.out and no from_id', () => {
      mapper = getMapper();
      const msg = mapper.createTwebMessage({
        mid: MID,
        peerId: SAMPLE_PEER_ID,
        date: DATE,
        text: TEXT,
        isOutgoing: true
      });

      expect(msg._).toBe('message');
      expect(msg.id).toBe(MID);
      expect(msg.date).toBe(DATE);
      expect(msg.message).toBe(TEXT);
      expect(msg.pFlags.out).toBe(true);
      expect((msg as any).from_id).toBeUndefined();
      expect((msg.peer_id as any)._).toBe('peerUser');
      expect((msg.peer_id as any).user_id).toBe(SAMPLE_PEER_ID);
      expect((msg as any).mid).toBe(MID);
    });

    it('creates an incoming message with from_id set', () => {
      mapper = getMapper();
      const FROM_ID = 9876543210987654;
      const msg = mapper.createTwebMessage({
        mid: MID,
        peerId: SAMPLE_PEER_ID,
        fromPeerId: FROM_ID,
        date: DATE,
        text: TEXT,
        isOutgoing: false
      });

      expect(msg.pFlags.out).toBeUndefined();
      expect(msg.pFlags.unread).toBe(true);
      expect((msg as any).from_id).toBeDefined();
      expect((msg as any).from_id._).toBe('peerUser');
      expect((msg as any).from_id.user_id).toBe(FROM_ID);
    });

    it('creates a group message with peerChat for negative peerId', () => {
      mapper = getMapper();
      const GROUP_PEER_ID = -2000000000000100;
      const msg = mapper.createTwebMessage({
        mid: MID,
        peerId: GROUP_PEER_ID,
        date: DATE,
        text: TEXT,
        isOutgoing: false
      });

      expect((msg.peer_id as any)._).toBe('peerChat');
      expect((msg.peer_id as any).chat_id).toBe(Math.abs(GROUP_PEER_ID));
    });

    it('sets mid and peerId on the message object', () => {
      mapper = getMapper();
      const msg = mapper.createTwebMessage({
        mid: MID,
        peerId: SAMPLE_PEER_ID,
        date: DATE,
        text: TEXT,
        isOutgoing: true
      });

      expect((msg as any).mid).toBe(MID);
      expect((msg as any).peerId).toBeDefined();
    });
  });

  // ─── createTwebDialog ────────────────────────────────────────────

  describe('createTwebDialog', () => {
    it('creates a dialog without pFlags.pinned', () => {
      mapper = getMapper();
      const dialog = mapper.createTwebDialog({
        peerId: SAMPLE_PEER_ID,
        topMessage: 42,
        topMessageDate: 1712345678
      });

      expect(dialog._).toBe('dialog');
      expect((dialog.pFlags as any).pinned).toBeUndefined();
      expect(dialog.top_message).toBe(42);
      expect(dialog.unread_count).toBe(0);
    });

    it('sets unreadCount when provided', () => {
      mapper = getMapper();
      const dialog = mapper.createTwebDialog({
        peerId: SAMPLE_PEER_ID,
        topMessage: 10,
        topMessageDate: 1712345678,
        unreadCount: 5
      });

      expect(dialog.unread_count).toBe(5);
    });

    it('creates a peerUser dialog for positive peerId', () => {
      mapper = getMapper();
      const dialog = mapper.createTwebDialog({
        peerId: SAMPLE_PEER_ID,
        topMessage: 1,
        topMessageDate: 1712345678
      });

      expect((dialog.peer as any)._).toBe('peerUser');
      expect((dialog.peer as any).user_id).toBe(SAMPLE_PEER_ID);
    });

    it('creates a peerChat dialog for group (isGroup: true)', () => {
      mapper = getMapper();
      const GROUP_PEER_ID = -2000000000000100;
      const dialog = mapper.createTwebDialog({
        peerId: GROUP_PEER_ID,
        topMessage: 1,
        topMessageDate: 1712345678,
        isGroup: true
      });

      expect((dialog.peer as any)._).toBe('peerChat');
      expect((dialog.peer as any).chat_id).toBe(Math.abs(GROUP_PEER_ID));
      expect((dialog.pFlags as any).pinned).toBeUndefined();
    });

    it('creates a peerChat dialog for negative peerId (auto-detect group)', () => {
      mapper = getMapper();
      const GROUP_PEER_ID = -2000000000000200;
      const dialog = mapper.createTwebDialog({
        peerId: GROUP_PEER_ID,
        topMessage: 0,
        topMessageDate: 1712345678
      });

      expect((dialog.peer as any)._).toBe('peerChat');
    });
  });

  // ─── createTwebChat ──────────────────────────────────────────────

  describe('createTwebChat', () => {
    it('creates a Chat.chat with correct fields', () => {
      mapper = getMapper();
      const chat = mapper.createTwebChat({
        chatId: 123456,
        title: 'Test Group',
        membersCount: 5,
        date: 1712345678
      });

      expect(chat._).toBe('chat');
      expect(chat.id).toBe(123456);
      expect(chat.title).toBe('Test Group');
      expect(chat.participants_count).toBe(5);
      expect(chat.date).toBe(1712345678);
      expect(chat.pFlags).toEqual({});
    });
  });
});
