/**
 * Security regression tests for the 2 CRITICAL + 3 HIGH audit findings.
 *
 * Covers:
 *  1. Schnorr signature verification on inbound kind 1059 / kind 0 events.
 *  2. Seal/rumor pubkey binding in `unwrapNip17Message` (anti-impersonation).
 *  3. `created_at` window enforcement in the relay receive pipeline.
 *  4. Conversation-key cache — `clearConversationKeyCache` wired into cleanup.
 *  5. `privateKeyBytes` zeroed + nulled on `NostrRelayPool.disconnect()`.
 */

import '../setup';
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {
  unwrapNip17Message,
  wrapNip17Message,
  clearConversationKeyCache,
  GiftWrapVerificationError,
  getConversationKey,
  nip44Encrypt,
  nip44Decrypt
} from '@lib/nostra/nostr-crypto';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  getEventHash
} from 'nostr-tools/pure';
import {hexToBytes} from 'nostr-tools/utils';
import {isCreatedAtInWindow, handleRelayMessage} from '@lib/nostra/chat-api-receive';
import type {DecryptedMessage} from '@lib/nostra/nostr-relay';

// Mocks needed so `handleRelayMessage` can run without touching IndexedDB
vi.mock('@lib/nostra/message-requests', () => ({
  getMessageRequestStore: () => ({
    isBlocked: vi.fn().mockResolvedValue(false),
    isKnownContact: vi.fn().mockResolvedValue(true),
    addRequest: vi.fn().mockResolvedValue(undefined)
  })
}));
vi.mock('@lib/nostra/message-store', () => ({
  getMessageStore: () => ({
    saveMessage: vi.fn().mockResolvedValue(undefined),
    getConversationId: vi.fn().mockReturnValue('conv-1'),
    getByEventId: vi.fn().mockResolvedValue(null),
    getByAppMessageId: vi.fn().mockResolvedValue(null),
    deleteMessages: vi.fn().mockResolvedValue(undefined)
  })
}));
vi.mock('@lib/rootScope', () => ({
  default: {dispatchEvent: vi.fn(), addEventListener: vi.fn()}
}));

// ──────────────────────────────────────────────────────────────────
// 1. Schnorr verification on inbound events
// ──────────────────────────────────────────────────────────────────

describe('Schnorr verification on inbound gift-wraps', () => {
  it('a forged signature is rejected by unwrapNip17Message', () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);

    const {wraps: [wrap]} = wrapNip17Message(senderSk, recipientPk, 'hello');

    // Tamper with the signature. nostr-tools caches verifyEvent results in
    // a `verifiedSymbol` property on the event, and object spread copies
    // symbols — so we must strip via JSON serialization to force re-verify.
    const cloned = JSON.parse(JSON.stringify(wrap));
    const origSig: string = cloned.sig;
    cloned.sig = origSig.slice(0, -2) +
      ((parseInt(origSig.slice(-2), 16) ^ 0xff).toString(16).padStart(2, '0'));

    expect(() => unwrapNip17Message(cloned, recipientSk))
    .toThrow(GiftWrapVerificationError);
  });

  it('handleEvent in NostrRelay calls verifyEvent and drops bad sigs', async() => {
    const {NostrRelay} = await import('@lib/nostra/nostr-relay');
    const relay = new NostrRelay('wss://example.invalid');
    const recipientSk = generateSecretKey();
    (relay as any).privateKey = recipientSk;
    (relay as any).publicKey = getPublicKey(recipientSk);

    const onMessage = vi.fn();
    relay.onMessage(onMessage);

    const senderSk = generateSecretKey();
    const {wraps: [wrap]} = wrapNip17Message(senderSk, (relay as any).publicKey, 'payload');

    // JSON-roundtrip strips the `verifiedSymbol` cache, then we tamper.
    const tampered: any = JSON.parse(JSON.stringify(wrap));
    tampered.sig = tampered.sig.slice(0, -2) +
      ((parseInt(tampered.sig.slice(-2), 16) ^ 0xff).toString(16).padStart(2, '0'));

    await (relay as any).handleEvent(tampered);

    expect(onMessage).not.toHaveBeenCalled();
  });

  it('a valid gift-wrap still decrypts normally (regression guard)', () => {
    const senderSk = generateSecretKey();
    const senderPk = getPublicKey(senderSk);
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);

    const {wraps: [wrap]} = wrapNip17Message(senderSk, recipientPk, 'hello secure world');
    const rumor = unwrapNip17Message(wrap, recipientSk);

    expect(rumor.content).toBe('hello secure world');
    expect(rumor.pubkey).toBe(senderPk);
    expect(rumor.kind).toBe(14);
  });
});

// ──────────────────────────────────────────────────────────────────
// 2. Seal/rumor pubkey binding
// ──────────────────────────────────────────────────────────────────

describe('seal/rumor pubkey binding in unwrap', () => {
  it('rejects a wrap whose rumor.pubkey differs from seal.pubkey (impersonation)', () => {
    // Attacker: builds a rumor claiming to be from `victim` but seals it
    // under the attacker's own signing key.
    const attackerSk = generateSecretKey();
    const attackerPk = getPublicKey(attackerSk);
    const victimSk = generateSecretKey();
    const victimPk = getPublicKey(victimSk);
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);

    // Rumor with *victim's* pubkey but signed-by-nobody (rumors are unsigned).
    const rumor: any = {
      kind: 14,
      content: 'I am totally the victim',
      tags: [['p', recipientPk]],
      pubkey: victimPk,
      created_at: Math.floor(Date.now() / 1000)
    };
    rumor.id = getEventHash(rumor);

    // Seal encrypted under recipient's NIP-44 ECDH with *attacker* key — then
    // finalize (sign) with the attacker's key, so seal.pubkey === attackerPk.
    const sealConvKey = getConversationKey(attackerSk, recipientPk);
    const sealContent = nip44Encrypt(JSON.stringify(rumor), sealConvKey);
    const seal = finalizeEvent({
      kind: 13,
      content: sealContent,
      created_at: Math.floor(Date.now() / 1000),
      tags: []
    }, attackerSk);

    // Wrap as kind 1059 addressed to recipient.
    const ephemeralSk = generateSecretKey();
    const wrapConvKey = getConversationKey(ephemeralSk, recipientPk);
    const wrapContent = nip44Encrypt(JSON.stringify(seal), wrapConvKey);
    const wrap = finalizeEvent({
      kind: 1059,
      content: wrapContent,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPk]]
    }, ephemeralSk);

    // Sanity: attacker is NOT the victim — and yet the unwrap MUST refuse.
    expect(attackerPk).not.toBe(victimPk);

    let caught: unknown = null;
    try {
      unwrapNip17Message(wrap as any, recipientSk);
    } catch(err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GiftWrapVerificationError);
    expect((caught as GiftWrapVerificationError).code).toBe('pubkey_binding');
  });
});

// ──────────────────────────────────────────────────────────────────
// 3. created_at window validation
// ──────────────────────────────────────────────────────────────────

describe('created_at window validation', () => {
  it('isCreatedAtInWindow accepts timestamps within 3 days', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isCreatedAtInWindow(now)).toBe(true);
    expect(isCreatedAtInWindow(now - 2 * 86400)).toBe(true);
    expect(isCreatedAtInWindow(now + 2 * 86400)).toBe(true);
  });

  it('isCreatedAtInWindow rejects timestamps beyond 3 days', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isCreatedAtInWindow(now + 10 * 365 * 86400)).toBe(false);
    expect(isCreatedAtInWindow(now - 4 * 86400)).toBe(false);
    expect(isCreatedAtInWindow(now + 4 * 86400)).toBe(false);
  });

  it('isCreatedAtInWindow handles malformed values', () => {
    expect(isCreatedAtInWindow(NaN)).toBe(false);
    expect(isCreatedAtInWindow(Infinity)).toBe(false);
    expect(isCreatedAtInWindow(undefined as any)).toBe(false);
  });

  it('handleRelayMessage drops a far-future message without persisting', async() => {
    const now = Math.floor(Date.now() / 1000);
    const farFuture: DecryptedMessage = {
      id: 'a'.repeat(64),
      from: 'b'.repeat(64),
      content: 'pin me to the top',
      timestamp: now + 10 * 365 * 86400, // 10 years ahead
      rumorKind: 14,
      tags: []
    };

    const onMessage = vi.fn();
    const ctx = {
      ownId: 'c'.repeat(64),
      history: [] as any[],
      activePeer: null as string | null,
      deliveryTracker: null as any,
      offlineQueue: null as any,
      onMessage,
      onEdit: null as any,
      log: Object.assign(vi.fn(), {warn: vi.fn(), error: vi.fn()}) as any
    };

    const result = await handleRelayMessage(farFuture, ctx);
    expect(result.action).toBe('skipped');
    if(result.action === 'skipped') {
      expect(result.reason).toBe('created_at_out_of_window');
    }
    expect(onMessage).not.toHaveBeenCalled();
    expect(ctx.log.warn).toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────
// 4. Conversation key cache behavior
// ──────────────────────────────────────────────────────────────────

describe('conversation key cache', () => {
  beforeEach(() => {
    clearConversationKeyCache();
  });

  it('clearConversationKeyCache empties the cache so new calls re-derive', () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(generateSecretKey());
    const a = getConversationKey(sk, pk);
    const b = getConversationKey(sk, pk);
    expect(a).toBe(b); // same reference on cache hit

    // Snapshot the derived bytes BEFORE clearing (clear zeroes them in place)
    const snapshot = new Uint8Array(a);

    clearConversationKeyCache();

    // After clear: cached bytes were zeroed in place
    const allZero = Array.from(a).every((v) => v === 0);
    expect(allZero).toBe(true);

    const c = getConversationKey(sk, pk);
    expect(c).not.toBe(a); // freshly derived object after clear
    // ECDH is deterministic: freshly re-derived key matches the pre-clear value
    expect(Array.from(c)).toEqual(Array.from(snapshot));
  });

  it('nostra-cleanup clearAllNostraData invokes clearConversationKeyCache', async() => {
    // Warm the cache so we can observe it being cleared.
    const sk = generateSecretKey();
    const pk = getPublicKey(generateSecretKey());
    const warmed = getConversationKey(sk, pk);
    // Sanity-check via a roundtrip on the warmed key.
    const ct = nip44Encrypt('probe', warmed);
    expect(nip44Decrypt(ct, warmed)).toBe('probe');

    // Snapshot before clear (cleanup zeroes the derived bytes in place).
    const snapshot = new Uint8Array(warmed);

    const {clearAllNostraData} = await import('@lib/nostra/nostra-cleanup');

    // Running full cleanup is heavy; we only care that the cache is cleared
    // as part of the pipeline. If the IndexedDB side fails in the jsdom env,
    // swallow it and still assert on the cache state.
    try {
      await clearAllNostraData();
    } catch{
      // cleanup may fail on DB ops in jsdom — not the subject of this test
    }

    // The previously-cached key bytes should now be zeroed in place.
    expect(Array.from(warmed).every((v) => v === 0)).toBe(true);

    // A fresh derivation after cleanup produces a NEW object whose bytes
    // match the original pre-clear value (ECDH is deterministic).
    const afterClear = getConversationKey(sk, pk);
    expect(afterClear).not.toBe(warmed);
    expect(Array.from(afterClear)).toEqual(Array.from(snapshot));
  });
});

// ──────────────────────────────────────────────────────────────────
// 5. Private key zeroing on disconnect
// ──────────────────────────────────────────────────────────────────

describe('NostrRelayPool.disconnect zeroes private key bytes', () => {
  it('privateKeyBytes is null after disconnect()', async() => {
    const {NostrRelayPool} = await import('@lib/nostra/nostr-relay-pool');
    const pool = new NostrRelayPool({
      relays: [],
      onMessage: () => {}
    });

    // Simulate the state initialize() would leave: populated key bytes.
    const sk = generateSecretKey();
    (pool as any).privateKeyBytes = new Uint8Array(sk);

    const snapshot = (pool as any).privateKeyBytes as Uint8Array;
    expect(snapshot).toBeInstanceOf(Uint8Array);
    expect(snapshot.length).toBe(32);

    pool.disconnect();

    // After disconnect the class field must be nulled...
    expect((pool as any).privateKeyBytes).toBeNull();

    // ...AND the backing bytes we captured must be zeroed in-place so that
    // any lingering references on other heap objects also see zeros.
    const allZero = Array.from(snapshot).every((b) => b === 0);
    expect(allZero).toBe(true);
  });

  it('disconnect() is idempotent when privateKeyBytes is already null', async() => {
    const {NostrRelayPool} = await import('@lib/nostra/nostr-relay-pool');
    const pool = new NostrRelayPool({
      relays: [],
      onMessage: () => {}
    });

    // No privateKeyBytes set — must not throw.
    expect(() => pool.disconnect()).not.toThrow();
    expect((pool as any).privateKeyBytes).toBeNull();
  });
});

// Keep the hexToBytes import live (otherwise the linter nags) — used as a
// safety net in case future tests need to construct keys from fixtures.
void hexToBytes;
