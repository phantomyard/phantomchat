/**
 * Regression test: the relay event dispatcher must forward kind 20001 (typing)
 * to the raw-event handler.
 *
 * Phantombot emits typing as a NIP-16 ephemeral kind-20001 event. The PWA
 * subscribes for it and the whole downstream chain (chat-api raw handler →
 * phantomchat-typing-receive → updateUserTyping → topbar + chat list) is wired
 * and waiting. But the dispatcher in nostr-relay.ts only forwarded reactions
 * (7) and deletes (5); kind 20001 fell through to the gift-wrap-only gate and
 * was silently dropped ("ignoring non-gift-wrap event kind: 20001"), so the
 * three-dots indicator never fired.
 *
 * Fix: add NOSTR_KIND_TYPING to the raw-event forwarding condition.
 */

import '../setup';
import {describe, it, expect, vi} from 'vitest';
import {generateSecretKey, getPublicKey, finalizeEvent} from 'nostr-tools/pure';
import {NostrRelay, NOSTR_KIND_TYPING} from '@lib/phantomchat/nostr-relay';

describe('relay dispatcher: typing (kind 20001) forwarding', () => {
  it('exports NOSTR_KIND_TYPING as 20001', () => {
    expect(NOSTR_KIND_TYPING).toBe(20001);
  });

  it('forwards a validly-signed kind 20001 event to the raw-event handler', async() => {
    const relay = new NostrRelay('wss://example.invalid');
    const recipientSk = generateSecretKey();
    (relay as any).privateKey = recipientSk;
    (relay as any).publicKey = getPublicKey(recipientSk);

    const onRaw = vi.fn();
    relay.onRawEvent(onRaw);

    const senderSk = generateSecretKey();
    const typingEvent = finalizeEvent({
      kind: NOSTR_KIND_TYPING,
      content: '',
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', (relay as any).publicKey]]
    }, senderSk);

    await (relay as any).handleEvent(typingEvent);

    expect(onRaw).toHaveBeenCalledTimes(1);
    expect(onRaw.mock.calls[0][0].kind).toBe(20001);
  });

  it('drops a kind 20001 event with a tampered signature', async() => {
    const relay = new NostrRelay('wss://example.invalid');
    const recipientSk = generateSecretKey();
    (relay as any).privateKey = recipientSk;
    (relay as any).publicKey = getPublicKey(recipientSk);

    const onRaw = vi.fn();
    relay.onRawEvent(onRaw);

    const senderSk = generateSecretKey();
    const typingEvent: any = finalizeEvent({
      kind: NOSTR_KIND_TYPING,
      content: '',
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', (relay as any).publicKey]]
    }, senderSk);

    // JSON-roundtrip strips nostr-tools' verifiedSymbol cache, then tamper.
    const tampered: any = JSON.parse(JSON.stringify(typingEvent));
    tampered.sig = tampered.sig.slice(0, -2) +
      ((parseInt(tampered.sig.slice(-2), 16) ^ 0xff).toString(16).padStart(2, '0'));

    await (relay as any).handleEvent(tampered);

    expect(onRaw).not.toHaveBeenCalled();
  });
});
