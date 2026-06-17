import {describe, it, expect} from 'vitest';
import {getNostrUnwrapClient} from '@lib/phantomchat/nostr-unwrap-client';
import {wrapNip17Message, GiftWrapVerificationError, type NTNostrEvent} from '@lib/phantomchat/nostr-crypto';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';

// In vitest there is no `Worker`, so the client takes its synchronous-fallback
// path. That is the contract these tests pin: with or without a worker, the
// client MUST behave exactly like the synchronous `unwrapNip17Message` — same
// rumor out, same GiftWrapVerificationError on a tampered wrap, never a hang.
describe('NostrUnwrapClient (synchronous fallback)', () => {
  const senderSk = generateSecretKey();
  const senderPub = getPublicKey(senderSk);
  const recipientSk = generateSecretKey();
  const recipientPub = getPublicKey(recipientSk);

  it('unwraps a valid gift-wrap to the original rumor', async() => {
    const {wraps, rumorId} = wrapNip17Message(senderSk, recipientPub, 'hello from a worker');
    // wraps[0] is the recipient wrap.
    const rumor = await getNostrUnwrapClient().unwrap(wraps[0] as NTNostrEvent, recipientSk);
    expect(rumor.content).toBe('hello from a worker');
    expect(rumor.pubkey).toBe(senderPub);
    expect(rumor.id).toBe(rumorId);
    expect(rumor.kind).toBe(14);
  });

  it('rejects a tampered wrap with GiftWrapVerificationError', async() => {
    const {wraps} = wrapNip17Message(senderSk, recipientPub, 'tamper me');
    // JSON round-trip strips nostr-tools' cached `verifiedSymbol`, otherwise
    // verifyEvent short-circuits to the original (true) result and never
    // re-checks the forged signature.
    const forged = JSON.parse(JSON.stringify(wraps[0])) as NTNostrEvent;
    forged.sig = '00'.repeat(64);
    await expect(getNostrUnwrapClient().unwrap(forged, recipientSk))
      .rejects.toBeInstanceOf(GiftWrapVerificationError);
  });

  it('handles many concurrent unwraps without crossing results', async() => {
    const wrapsAndIds = Array.from({length: 12}, (_, i) =>
      wrapNip17Message(senderSk, recipientPub, `msg-${i}`));
    const client = getNostrUnwrapClient();
    const rumors = await Promise.all(
      wrapsAndIds.map(({wraps}) => client.unwrap(wraps[0] as NTNostrEvent, recipientSk)));
    rumors.forEach((rumor, i) => expect(rumor.content).toBe(`msg-${i}`));
  });
});
