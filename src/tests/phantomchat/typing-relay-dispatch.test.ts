/**
 * Regression test: the relay event dispatcher must forward legacy kind-20001
 * (ephemeral typing) events to the raw-event handler for backward compat with
 * bots that haven't migrated to gift-wrapped typing yet.
 *
 * Typing ticks are now gift-wrapped (kind-1059 → kind-14 rumor) for privacy +
 * collision avoidance. The nostr-relay.ts unwrap handler detects the typing
 * content and routes it to the raw-event handler. But bare kind-20001 events
 * from old bots must still be accepted during the migration period.
 */

import '../setup';
import {describe, it, expect, vi} from 'vitest';
import {generateSecretKey, getPublicKey, finalizeEvent} from 'nostr-tools/pure';
import {NostrRelay, NOSTR_KIND_TYPING, NOSTR_KIND_TYPING_LEGACY} from '@lib/phantomchat/nostr-relay';

describe('relay dispatcher: typing forwarding', () => {
  it('exports NOSTR_KIND_TYPING as 30001 (reference, no longer on wire)', () => {
    expect(NOSTR_KIND_TYPING).toBe(30001);
  });

  it('exports NOSTR_KIND_TYPING_LEGACY as 20001', () => {
    expect(NOSTR_KIND_TYPING_LEGACY).toBe(20001);
  });

  it('forwards a validly-signed legacy kind-20001 event to the raw-event handler', async() => {
    const relay = new NostrRelay('wss://example.invalid');
    const recipientSk = generateSecretKey();
    (relay as any).privateKey = recipientSk;
    (relay as any).publicKey = getPublicKey(recipientSk);

    const onRaw = vi.fn();
    relay.onRawEvent(onRaw);

    const senderSk = generateSecretKey();
    const typingEvent = finalizeEvent({
      kind: NOSTR_KIND_TYPING_LEGACY,
      content: '',
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', (relay as any).publicKey]]
    }, senderSk);

    await (relay as any).handleEvent(typingEvent);

    expect(onRaw).toHaveBeenCalledTimes(1);
    expect(onRaw.mock.calls[0][0].kind).toBe(20001);
  });

  it('drops a legacy kind-20001 event with a tampered signature', async() => {
    const relay = new NostrRelay('wss://example.invalid');
    const recipientSk = generateSecretKey();
    (relay as any).privateKey = recipientSk;
    (relay as any).publicKey = getPublicKey(recipientSk);

    const onRaw = vi.fn();
    relay.onRawEvent(onRaw);

    const senderSk = generateSecretKey();
    const typingEvent: any = finalizeEvent({
      kind: NOSTR_KIND_TYPING_LEGACY,
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

  it('drops bare kind-30001 events (typing is now gift-wrapped)', async() => {
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

    // kind-30001 is no longer in the raw-event handler → should be dropped
    expect(onRaw).not.toHaveBeenCalled();
  });
});
