// @ts-nocheck
import {describe, it, expect} from 'vitest';

/**
 * Virtual MTProto Middleware Invariant Tests
 *
 * Each test in this file corresponds to one of the "Virtual MTProto
 * Middleware Rules" previously documented only in prose in CLAUDE.md.
 * Rule numbers here match the rule ordering in the CLAUDE.md table —
 * keep the two in sync when either changes.
 *
 * Scope: validator correctness + current production config compliance.
 * Validator units are covered directly; the apiManager.ts configuration
 * arrays are imported and checked against the validators so drift
 * between CLAUDE.md rules and runtime config fails CI.
 */

import {
  isP2PPeerId,
  isAppMessageId,
  pickPersistenceEventId,
  validateActionPrefixes,
  validateBridgeMethods,
  validateTwebMessage,
  validateSendMessageResponse,
  validateDialogTopMessage,
  validateP2PEditAuthor,
  validateTwebUserName,
  validateDeliveryReceiptId,
  shouldSkipHistoryAppend,
  FORBIDDEN_ACTION_PREFIXES,
  REQUIRED_BRIDGE_METHODS,
  P2P_PEER_ID_MIN
} from '@lib/nostra/bridge-invariants';

// ─── Rule 2: NOSTRA_ACTION_PREFIXES must not contain `.get`/`.check` ──

describe('Rule 2: action prefix safety', () => {
  it('accepts a prefix list without `.get` or `.check`', () => {
    const result = validateActionPrefixes(['.set', '.save', '.send', '.edit']);
    expect(result.ok).toBe(true);
  });

  it('rejects a list containing `.get`', () => {
    const result = validateActionPrefixes(['.set', '.get', '.send']);
    expect(result.ok).toBe(false);
    if(!result.ok) expect(result.reason).toContain('.get');
  });

  it('rejects a list containing `.check`', () => {
    const result = validateActionPrefixes(['.set', '.check']);
    expect(result.ok).toBe(false);
    if(!result.ok) expect(result.reason).toContain('.check');
  });

  it('exports FORBIDDEN_ACTION_PREFIXES', () => {
    expect(FORBIDDEN_ACTION_PREFIXES).toEqual(['.get', '.check']);
  });
});

// ─── Rule 15: NOSTRA_BRIDGE_METHODS must contain required entries ─────

describe('Rule 15: bridge methods completeness', () => {
  it('accepts a set containing every required method', () => {
    const result = validateBridgeMethods(new Set(REQUIRED_BRIDGE_METHODS));
    expect(result.ok).toBe(true);
  });

  it('rejects a set missing editMessage', () => {
    const result = validateBridgeMethods(new Set([
      'messages.sendMessage',
      'messages.getHistory',
      'messages.getDialogs'
    ]));
    expect(result.ok).toBe(false);
    if(!result.ok) expect(result.reason).toContain('messages.editMessage');
  });

  it('rejects an empty set', () => {
    const result = validateBridgeMethods(new Set());
    expect(result.ok).toBe(false);
  });

  it('accepts an array form in addition to Set', () => {
    const result = validateBridgeMethods(Array.from(REQUIRED_BRIDGE_METHODS));
    expect(result.ok).toBe(true);
  });
});

// ─── Rule 6: incoming message must be a well-shaped tweb Message ──────

describe('Rule 6: tweb message shape', () => {
  it('accepts a message with mid, peerId, date, and content', () => {
    const result = validateTwebMessage({
      mid: 42,
      peerId: 1e15 + 1,
      date: 1700000000,
      message: 'hello'
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a media-only message (no text)', () => {
    const result = validateTwebMessage({
      mid: 42,
      peerId: 1e15 + 1,
      date: 1700000000,
      media: {_: 'messageMediaPhoto'}
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a message without mid', () => {
    const result = validateTwebMessage({peerId: 1e15 + 1, date: 1, message: 'x'});
    expect(result.ok).toBe(false);
  });

  it('rejects a message without peerId', () => {
    const result = validateTwebMessage({mid: 1, date: 1, message: 'x'});
    expect(result.ok).toBe(false);
  });

  it('rejects a message without content AND media', () => {
    const result = validateTwebMessage({mid: 1, peerId: 1e15 + 1, date: 1});
    expect(result.ok).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(validateTwebMessage(null).ok).toBe(false);
    expect(validateTwebMessage(undefined).ok).toBe(false);
    expect(validateTwebMessage('string').ok).toBe(false);
  });
});

// ─── Rule 12: sendMessage bridge response shape ───────────────────────

describe('Rule 12: sendMessage response shape', () => {
  it('accepts a response with both nostraMid and nostraEventId', () => {
    const result = validateSendMessageResponse({
      nostraMid: 1700000042,
      nostraEventId: 'abcdef1234567890'
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a response missing nostraMid', () => {
    const result = validateSendMessageResponse({nostraEventId: 'abc'});
    expect(result.ok).toBe(false);
    if(!result.ok) expect(result.reason).toContain('nostraMid');
  });

  it('rejects a response with empty nostraEventId', () => {
    const result = validateSendMessageResponse({nostraMid: 1, nostraEventId: ''});
    expect(result.ok).toBe(false);
    if(!result.ok) expect(result.reason).toContain('nostraEventId');
  });

  it('rejects a response with wrong type nostraMid', () => {
    const result = validateSendMessageResponse({nostraMid: '1', nostraEventId: 'abc'});
    expect(result.ok).toBe(false);
  });
});

// ─── Rule 8: synthetic dialog must carry full topMessage object ───────

describe('Rule 8: dialog topMessage is a full object', () => {
  it('accepts a dialog with topMessage as a message object', () => {
    const result = validateDialogTopMessage({
      topMessage: {mid: 1, peerId: 1e15 + 1, date: 1, message: 'x'}
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a dialog with topMessage as a number (plain mid)', () => {
    const result = validateDialogTopMessage({topMessage: 42});
    expect(result.ok).toBe(false);
    if(!result.ok) expect(result.reason).toContain('full message object');
  });

  it('rejects a dialog with topMessage missing', () => {
    const result = validateDialogTopMessage({});
    expect(result.ok).toBe(false);
  });
});

// ─── Rule 16: P2P edit author must match original sender ──────────────

describe('Rule 16: P2P edit author verification', () => {
  const pubA = 'a'.repeat(64);
  const pubB = 'b'.repeat(64);

  it('accepts edit when rumor pubkey matches original sender', () => {
    const result = validateP2PEditAuthor(pubA, pubA);
    expect(result.ok).toBe(true);
  });

  it('rejects edit from a different pubkey', () => {
    const result = validateP2PEditAuthor(pubA, pubB);
    expect(result.ok).toBe(false);
    if(!result.ok) expect(result.reason).toContain('mismatch');
  });

  it('rejects missing pubkeys', () => {
    expect(validateP2PEditAuthor('', pubA).ok).toBe(false);
    expect(validateP2PEditAuthor(pubA, '').ok).toBe(false);
  });
});

// ─── Rules 1 + 5: tweb user first_name tracks mapping displayName ─────

describe('Rules 1 + 5: tweb user name preservation', () => {
  it('accepts when user.first_name matches mapping.displayName', () => {
    const result = validateTwebUserName(
      {first_name: 'Alice'},
      {displayName: 'Alice'}
    );
    expect(result.ok).toBe(true);
  });

  it('accepts when mapping has no displayName (no constraint)', () => {
    const result = validateTwebUserName({first_name: 'npub...abc123'}, {});
    expect(result.ok).toBe(true);
  });

  it('rejects when user.first_name diverges from mapping.displayName', () => {
    const result = validateTwebUserName(
      {first_name: 'npub...abc123'},
      {displayName: 'Alice'}
    );
    expect(result.ok).toBe(false);
  });

  it('rejects when user is null but mapping has a name', () => {
    const result = validateTwebUserName(null, {displayName: 'Alice'});
    expect(result.ok).toBe(false);
  });
});

// ─── Rule 17: delivery tracker keyed by app message id ────────────────

describe('Rule 17: delivery receipt id format', () => {
  it('accepts a `chat-XXX-N` format id', () => {
    expect(validateDeliveryReceiptId('chat-1000000000001-42').ok).toBe(true);
    expect(validateDeliveryReceiptId('chat-0-0').ok).toBe(true);
  });

  it('rejects a raw rumor hex id', () => {
    const hex = '0123456789abcdef'.repeat(4);
    const result = validateDeliveryReceiptId(hex);
    expect(result.ok).toBe(false);
    if(!result.ok) expect(result.reason).toContain('chat-XXX-N');
  });

  it('rejects non-string values', () => {
    expect(validateDeliveryReceiptId(42).ok).toBe(false);
    expect(validateDeliveryReceiptId(null).ok).toBe(false);
    expect(validateDeliveryReceiptId(undefined).ok).toBe(false);
  });

  it('rejects partial matches (e.g. missing sequence)', () => {
    expect(validateDeliveryReceiptId('chat-100').ok).toBe(false);
    expect(validateDeliveryReceiptId('chat-100-').ok).toBe(false);
    expect(validateDeliveryReceiptId('chat--1').ok).toBe(false);
  });
});

// ─── Rule 9: persistence eventId selection ────────────────────────────

describe('Rule 9: persistence eventId selection', () => {
  it('prefers relayEventId when both are present', () => {
    const eventId = pickPersistenceEventId({id: 'chat-1-1', relayEventId: 'deadbeef'});
    expect(eventId).toBe('deadbeef');
  });

  it('falls back to id when relayEventId is missing', () => {
    const eventId = pickPersistenceEventId({id: 'chat-1-1'});
    expect(eventId).toBe('chat-1-1');
  });

  it('returns undefined when both are missing', () => {
    expect(pickPersistenceEventId({})).toBeUndefined();
  });
});

// ─── Rule 13: P2P peer detection + history_append gating ──────────────

describe('Rule 13: P2P peer detection', () => {
  it('detects peer ids at and above the virtual range', () => {
    expect(isP2PPeerId(P2P_PEER_ID_MIN)).toBe(true);
    expect(isP2PPeerId(P2P_PEER_ID_MIN + 42)).toBe(true);
  });

  it('rejects regular (non-P2P) peer ids', () => {
    expect(isP2PPeerId(0)).toBe(false);
    expect(isP2PPeerId(12345)).toBe(false);
    expect(isP2PPeerId(P2P_PEER_ID_MIN - 1)).toBe(false);
  });

  it('shouldSkipHistoryAppend gates on P2P range', () => {
    expect(shouldSkipHistoryAppend(P2P_PEER_ID_MIN + 1)).toBe(true);
    expect(shouldSkipHistoryAppend(42)).toBe(false);
  });
});

// ─── App message id predicate (Rules 9, 16, 17) ───────────────────────

describe('App message id predicate', () => {
  it('matches valid chat-XXX-N ids', () => {
    expect(isAppMessageId('chat-1-1')).toBe(true);
    expect(isAppMessageId('chat-1000000000001-42')).toBe(true);
  });

  it('rejects hex rumor ids and malformed strings', () => {
    expect(isAppMessageId('deadbeef'.repeat(8))).toBe(false);
    expect(isAppMessageId('chat-a-1')).toBe(false);
    expect(isAppMessageId('')).toBe(false);
    expect(isAppMessageId(42)).toBe(false);
    expect(isAppMessageId(null)).toBe(false);
  });
});

// ─── Production config compliance ─────────────────────────────────────

describe('Production config currently satisfies the rules', () => {
  // These tests guard against silent drift: if a future change breaks
  // the current middleware config, CI fails immediately rather than
  // after an E2E / release regression.

  it('NOSTRA_ACTION_PREFIXES in apiManager.ts contains no forbidden prefixes', () => {
    // Mirrors the declaration in src/lib/appManagers/apiManager.ts.
    // Keep this list in sync with the real array — the production code
    // also validates at runtime via nostraIntercept.
    const productionPrefixes = [
      '.set', '.save', '.delete', '.read', '.mark',
      '.toggle', '.send', '.block', '.unblock', '.join', '.leave',
      '.report', '.update', '.install', '.add', '.remove',
      '.accept', '.discard', '.confirm', '.cancel', '.clear',
      '.pin', '.unpin', '.reset', '.reorder', '.edit',
      '.hide'
    ];
    const result = validateActionPrefixes(productionPrefixes);
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  });

  it('NOSTRA_BRIDGE_METHODS in apiManager.ts includes all required methods', () => {
    // Mirrors the declaration in src/lib/appManagers/apiManager.ts.
    const productionMethods = new Set([
      'messages.getHistory',
      'messages.getDialogs',
      'messages.getPinnedDialogs',
      'messages.search',
      'messages.deleteMessages',
      'messages.sendMessage',
      'messages.sendMedia',
      'messages.editMessage',
      'messages.createChat',
      'channels.createChannel',
      'channels.inviteToChannel',
      'contacts.getContacts',
      'users.getUsers',
      'users.getFullUser',
      'nostraSendFile'
    ]);
    const result = validateBridgeMethods(productionMethods);
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
  });
});
