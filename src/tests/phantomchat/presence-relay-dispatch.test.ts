/**
 * Regression test: the relay event dispatcher must forward kind 30315 (NIP-38
 * presence) to the raw-event handler.
 *
 * Same failure shape as the typing bug: phantombot (and any peer) republishes a
 * kind-30315 heartbeat p-tagged to us, and the whole downstream chain (chat-api
 * raw handler → phantomchat-presence → tweb user status → topbar + chat list)
 * is wired and waiting. But the dispatcher in nostr-relay.ts forwarded only
 * reactions (7), deletes (5), and typing (20001); kind 30315 fell through to the
 * gift-wrap-only gate and was silently dropped, so presence never updated and
 * contacts stayed stuck on "last seen recently".
 *
 * Fix: add NOSTR_KIND_PRESENCE to the raw-event forwarding condition (and to the
 * subscription filter so the relay actually delivers it).
 */

import '../setup';
import {describe, it, expect, vi} from 'vitest';
import {generateSecretKey, getPublicKey, finalizeEvent} from 'nostr-tools/pure';
import {NostrRelay, NOSTR_KIND_PRESENCE} from '@lib/phantomchat/nostr-relay';

function makeRelay() {
  const relay = new NostrRelay('wss://example.invalid');
  const recipientSk = generateSecretKey();
  (relay as any).privateKey = recipientSk;
  (relay as any).publicKey = getPublicKey(recipientSk);
  return relay;
}

describe('relay dispatcher: presence (kind 30315) forwarding', () => {
  it('exports NOSTR_KIND_PRESENCE as 30315', () => {
    expect(NOSTR_KIND_PRESENCE).toBe(30315);
  });

  it('forwards a validly-signed kind 30315 event to the raw-event handler', async() => {
    const relay = makeRelay();
    const onRaw = vi.fn();
    relay.onRawEvent(onRaw);

    const senderSk = generateSecretKey();
    const presenceEvent = finalizeEvent({
      kind: NOSTR_KIND_PRESENCE,
      content: 'online',
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', 'general'], ['status', 'online'], ['p', (relay as any).publicKey]]
    }, senderSk);

    await (relay as any).handleEvent(presenceEvent);

    expect(onRaw).toHaveBeenCalledTimes(1);
    expect(onRaw.mock.calls[0][0].kind).toBe(30315);
  });

  it('drops a kind 30315 event with a tampered signature', async() => {
    const relay = makeRelay();
    const onRaw = vi.fn();
    relay.onRawEvent(onRaw);

    const senderSk = generateSecretKey();
    const presenceEvent: any = finalizeEvent({
      kind: NOSTR_KIND_PRESENCE,
      content: 'online',
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', 'general'], ['status', 'online'], ['p', (relay as any).publicKey]]
    }, senderSk);

    // JSON-roundtrip strips nostr-tools' verifiedSymbol cache, then tamper.
    const tampered: any = JSON.parse(JSON.stringify(presenceEvent));
    tampered.sig = tampered.sig.slice(0, -2) +
      ((parseInt(tampered.sig.slice(-2), 16) ^ 0xff).toString(16).padStart(2, '0'));

    await (relay as any).handleEvent(tampered);

    expect(onRaw).not.toHaveBeenCalled();
  });
});
