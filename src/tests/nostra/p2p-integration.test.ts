/**
 * P2P chat rendering integration tests for Nostra.chat
 *
 * Tests the critical integration points between P2P messaging and
 * the chat rendering pipeline: isOurMessage(), generateFlags(), and
 * P2P message finalization in appMessagesManager.
 */

import {describe, it, expect, vi, beforeEach} from 'vitest';

// ── Constants ──────────────────────────────────────────────────────

const VIRTUAL_PEER_BASE = 1e15;
const VIRTUAL_PEER_ID = VIRTUAL_PEER_BASE + 42;

// ══════════════════════════════════════════════════════════════════
// 1. isOurMessage() — Chat component P2P fallback
// ══════════════════════════════════════════════════════════════════

describe('Chat.isOurMessage() P2P fallback', () => {
  /**
   * The real Chat class has heavy dependencies (AppImManager, DOM, Solid.js).
   * We extract and test the isOurMessage logic directly, matching the
   * implementation in src/components/chat/chat.ts ~line 1384.
   */
  function isOurMessage(
    message: {fromId?: number; pFlags: {out?: true; post?: true}},
    opts: {isMegagroup: boolean; myId: number}
  ): boolean {
    if(opts.isMegagroup) {
      return !!message.pFlags.out;
    }

    if(message.fromId === opts.myId && !message.pFlags.post) {
      return true;
    }

    // [Nostra.chat] When myId is NULL (P2P mode, no MTProto auth),
    // use pFlags.out as fallback
    if(!opts.myId && message.pFlags.out) {
      return true;
    }

    return false;
  }

  it('returns true when myId is 0 (NULL) and pFlags.out is true', () => {
    const message = {fromId: 0, pFlags: {out: true as const}};
    expect(isOurMessage(message, {isMegagroup: false, myId: 0})).toBe(true);
  });

  it('returns false when myId is 0 (NULL), pFlags.out is absent, and fromId differs', () => {
    // When myId=0 and fromId is nonzero (incoming P2P message), and out is not set
    const message = {fromId: VIRTUAL_PEER_ID, pFlags: {}};
    expect(isOurMessage(message, {isMegagroup: false, myId: 0})).toBe(false);
  });

  it('returns true when myId is set and fromId matches (normal MTProto case)', () => {
    const message = {fromId: 12345, pFlags: {}};
    expect(isOurMessage(message, {isMegagroup: false, myId: 12345})).toBe(true);
  });

  it('returns false when myId is set and fromId does not match', () => {
    const message = {fromId: 99999, pFlags: {}};
    expect(isOurMessage(message, {isMegagroup: false, myId: 12345})).toBe(false);
  });

  it('returns true in megagroup when pFlags.out is set regardless of myId', () => {
    const message = {fromId: 0, pFlags: {out: true as const}};
    expect(isOurMessage(message, {isMegagroup: true, myId: 0})).toBe(true);
  });

  it('returns false when myId matches but pFlags.post is set', () => {
    const message = {fromId: 12345, pFlags: {post: true as const}};
    expect(isOurMessage(message, {isMegagroup: false, myId: 12345})).toBe(false);
  });

  it('P2P fallback does not trigger when myId is nonzero', () => {
    // Even with pFlags.out, the P2P branch should not fire when myId is set
    const message = {fromId: 99999, pFlags: {out: true as const}};
    // myId is nonzero so !myId is false — P2P fallback skipped
    // fromId !== myId so normal check fails
    // not megagroup so megagroup check skipped
    expect(isOurMessage(message, {isMegagroup: false, myId: 12345})).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// 2. generateFlags() — P2P flag generation
// ══════════════════════════════════════════════════════════════════

describe('generateFlags() for P2P virtual peers', () => {
  /**
   * Extracted from appMessagesManager.ts ~line 3071.
   * When getSelf() returns undefined (Nostra.chat mode), fromId becomes 0
   * and peerId !== 0 is always true for virtual peers, so pFlags.out is set.
   */
  function generateFlags(
    peerId: number,
    opts: {
      getSelf: () => {id: number} | undefined;
      isChannel: (id: number) => boolean;
      isBot: (id: number) => boolean;
      isBroadcast: (id: number) => boolean;
    }
  ): Record<string, boolean | undefined> {
    const pFlags: Record<string, boolean | undefined> = {};
    const self = opts.getSelf();
    const fromId = self?.id ?? 0;
    if(peerId !== fromId) {
      pFlags.out = true;

      if(!opts.isChannel(peerId) && !opts.isBot(peerId)) {
        pFlags.unread = true;
      }
    }

    if(opts.isBroadcast(peerId)) {
      pFlags.post = true;
    }

    return pFlags;
  }

  const defaultOpts = {
    isChannel: () => false,
    isBot: () => false,
    isBroadcast: () => false
  };

  it('sets pFlags.out when getSelf() is undefined and peerId is a virtual peer', () => {
    const flags = generateFlags(VIRTUAL_PEER_ID, {
      ...defaultOpts,
      getSelf: () => undefined
    });
    expect(flags.out).toBe(true);
  });

  it('sets pFlags.unread when getSelf() is undefined and peerId is a virtual peer', () => {
    const flags = generateFlags(VIRTUAL_PEER_ID, {
      ...defaultOpts,
      getSelf: () => undefined
    });
    expect(flags.unread).toBe(true);
  });

  it('does not set pFlags.out when peerId matches self.id', () => {
    const flags = generateFlags(12345, {
      ...defaultOpts,
      getSelf: () => ({id: 12345})
    });
    expect(flags.out).toBeUndefined();
  });

  it('does not set pFlags.unread when peerId is a channel', () => {
    const flags = generateFlags(VIRTUAL_PEER_ID, {
      ...defaultOpts,
      getSelf: () => undefined,
      isChannel: () => true
    });
    expect(flags.out).toBe(true);
    expect(flags.unread).toBeUndefined();
  });

  it('does not set pFlags.unread when peerId is a bot', () => {
    const flags = generateFlags(VIRTUAL_PEER_ID, {
      ...defaultOpts,
      getSelf: () => undefined,
      isBot: () => true
    });
    expect(flags.out).toBe(true);
    expect(flags.unread).toBeUndefined();
  });

  it('sets pFlags.post when peerId is a broadcast channel', () => {
    const flags = generateFlags(VIRTUAL_PEER_ID, {
      ...defaultOpts,
      getSelf: () => undefined,
      isBroadcast: () => true
    });
    expect(flags.post).toBe(true);
  });

  it('fromId falls back to 0 when getSelf returns undefined, so any nonzero peerId gets out', () => {
    // Even a regular (non-virtual) peerId gets out=true when self is missing
    const flags = generateFlags(42, {
      ...defaultOpts,
      getSelf: () => undefined
    });
    expect(flags.out).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// 3. P2P message finalization — empty updates handling
// ══════════════════════════════════════════════════════════════════

describe('P2P message finalization (empty updates for virtual peer)', () => {
  /**
   * Extracted from appMessagesManager.ts ~line 1408.
   * When nostraIntercept returns empty updates for a P2P peer (peerId >= 1e15),
   * the pending message is finalized: is_outgoing deleted, out set to true.
   */
  function finalizeP2PMessage(
    updates: {_: string; updates?: any[]},
    peerId: number,
    message: {
      pFlags: Record<string, boolean | undefined>;
      pending?: boolean;
    },
    dispatchEvent: (name: string) => void
  ): boolean {
    if(
      updates?._ === 'updates' &&
      (updates as any).updates?.length === 0 &&
      Number(peerId) >= 1e15
    ) {
      delete message.pFlags.is_outgoing;
      delete message.pending;
      message.pFlags.out = true;
      message.pFlags.unread = true;
      dispatchEvent('messages_pending');
      return true;
    }
    return false;
  }

  let dispatchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatchSpy = vi.fn();
  });

  it('deletes is_outgoing and sets out=true for empty updates with virtual peer', () => {
    const message = {
      pFlags: {is_outgoing: true} as Record<string, boolean | undefined>,
      pending: true
    };
    const updates = {_: 'updates', updates: [] as any[]};

    const handled = finalizeP2PMessage(updates, VIRTUAL_PEER_ID, message, dispatchSpy);

    expect(handled).toBe(true);
    expect(message.pFlags.is_outgoing).toBeUndefined();
    expect(message.pFlags.out).toBe(true);
    expect(message.pFlags.unread).toBe(true);
    expect(message.pending).toBeUndefined();
  });

  it('dispatches messages_pending event after finalization', () => {
    const message = {
      pFlags: {} as Record<string, boolean | undefined>,
      pending: true
    };
    const updates = {_: 'updates', updates: [] as any[]};

    finalizeP2PMessage(updates, VIRTUAL_PEER_ID, message, dispatchSpy);

    expect(dispatchSpy).toHaveBeenCalledWith('messages_pending');
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not finalize when peerId is below virtual peer threshold', () => {
    const message = {
      pFlags: {is_outgoing: true} as Record<string, boolean | undefined>,
      pending: true
    };
    const updates = {_: 'updates', updates: [] as any[]};

    const handled = finalizeP2PMessage(updates, 12345, message, dispatchSpy);

    expect(handled).toBe(false);
    expect(message.pFlags.is_outgoing).toBe(true);
    expect(message.pending).toBe(true);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('does not finalize when updates array is non-empty', () => {
    const message = {
      pFlags: {is_outgoing: true} as Record<string, boolean | undefined>,
      pending: true
    };
    const updates = {_: 'updates', updates: [{_: 'updateNewMessage'}]};

    const handled = finalizeP2PMessage(updates, VIRTUAL_PEER_ID, message, dispatchSpy);

    expect(handled).toBe(false);
    expect(message.pFlags.is_outgoing).toBe(true);
  });

  it('does not finalize when updates type is not "updates"', () => {
    const message = {
      pFlags: {is_outgoing: true} as Record<string, boolean | undefined>,
      pending: true
    };
    const updates = {_: 'updateShortSentMessage', updates: [] as any[]};

    const handled = finalizeP2PMessage(updates, VIRTUAL_PEER_ID, message, dispatchSpy);

    expect(handled).toBe(false);
    expect(message.pFlags.is_outgoing).toBe(true);
  });

  it('handles peerId exactly at virtual peer boundary (1e15)', () => {
    const message = {
      pFlags: {is_outgoing: true} as Record<string, boolean | undefined>,
      pending: true
    };
    const updates = {_: 'updates', updates: [] as any[]};

    const handled = finalizeP2PMessage(updates, 1e15, message, dispatchSpy);

    expect(handled).toBe(true);
    expect(message.pFlags.out).toBe(true);
  });

  it('handles peerId just below virtual peer boundary', () => {
    const message = {
      pFlags: {is_outgoing: true} as Record<string, boolean | undefined>,
      pending: true
    };
    const updates = {_: 'updates', updates: [] as any[]};

    const handled = finalizeP2PMessage(updates, 1e15 - 1, message, dispatchSpy);

    expect(handled).toBe(false);
    expect(message.pFlags.is_outgoing).toBe(true);
  });
});
