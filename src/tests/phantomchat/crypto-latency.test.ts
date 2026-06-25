/**
 * Crypto latency profile — quantifies the per-message encrypt/decrypt cost so we
 * can answer "are we spending too long in crypto?" with numbers, and guards
 * against a future regression that makes the messaging path crawl.
 *
 * Run: pnpm test run src/tests/phantomchat/crypto-latency.test.ts
 * The console table is the deliverable; the assertions are deliberately loose
 * (≈10x headroom) so they catch a real regression, not normal machine variance.
 */
import {describe, it, expect} from 'vitest';
import {
  getSymmetricKey,
  encryptV2,
  decryptV2,
  wrapV2,
  unwrapV2,
  wrapNip17Message,
  unwrapNip17Message
} from '@lib/phantomchat/nostr-crypto';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';

function bench(label: string, iterations: number, fn: () => Promise<void> | void) {
  return (async() => {
    // warm up (JIT, subtle key import) before timing
    await fn();
    const t0 = performance.now();
    for(let i = 0; i < iterations; i++) await fn();
    const total = performance.now() - t0;
    const per = total / iterations;
    return {label, iterations, perMs: per};
  })();
}

describe('crypto latency profile', () => {
  const skA = generateSecretKey();
  const pkA = getPublicKey(skA);
  const skB = generateSecretKey();
  const pkB = getPublicKey(skB);
  const content = 'Hi Lena can you read this?';

  it('profiles wrap/unwrap and the cached-key scan', async() => {
    const results: {label: string; iterations: number; perMs: number}[] = [];

    // Pre-warm both directions of the symmetric-key cache (steady-state: a real
    // conversation already has the shared key derived).
    await getSymmetricKey(skA, pkB);
    await getSymmetricKey(skB, pkA);

    // --- v2 (AES-256-GCM) wrap / unwrap ---
    results.push(await bench('wrapV2 (encrypt+sign)', 100, async() => {
      wrapV2(skA, pkB, content);
    }));

    const v2wrap = await wrapV2(skA, pkB, content);
    results.push(await bench('unwrapV2 (verify+decrypt)', 100, async() => {
      await unwrapV2(v2wrap.event as any, skB);
    }));

    // --- NIP-17 (legacy double NIP-44 gift-wrap) for comparison ---
    results.push(await bench('wrapNip17 (legacy)', 50, async() => {
      wrapNip17Message(skA, pkB, content);
    }));

    const n17 = wrapNip17Message(skA, pkB, content);
    // recipient wrap is wraps[0]
    results.push(await bench('unwrapNip17 (legacy)', 50, async() => {
      unwrapNip17Message(n17.wraps[0], skB);
    }));

    // --- The O(N) cached-key scan: unwrapV2 tries every cached symmetric key
    // until one decrypts. Model it directly as N wrong-key attempts + 1 hit,
    // which is exactly what decryptWithAnyCachedKey does internally. ---
    const {key: realKey} = await getSymmetricKey(skB, pkA);
    const wrongSk = generateSecretKey();
    const {key: wrongKey} = await getSymmetricKey(wrongSk, pkA);
    const ciphertext = await encryptV2(content, realKey);

    for(const N of [1, 10, 50, 200, 500]) {
      results.push(await bench(`cache scan @ ${N} peers (worst case)`, 20, async() => {
        for(let i = 0; i < N; i++) {
          try {
            await decryptV2(ciphertext, wrongKey); // wrong key -> auth-tag reject
          } catch{ /* expected */ }
        }
        await decryptV2(ciphertext, realKey); // the hit
      }));
    }

    // Pretty-print the profile.
    // eslint-disable-next-line no-console
    console.log('\n=== PhantomChat crypto latency profile ===');
    for(const r of results) {
      // eslint-disable-next-line no-console
      console.log(`${r.label.padEnd(38)} ${r.perMs.toFixed(3).padStart(8)} ms/op  (${r.iterations}x)`);
    }
    // eslint-disable-next-line no-console
    console.log('==========================================\n');

    const byLabel = (s: string) => results.find((r) => r.label.startsWith(s))!.perMs;

    // Sanity bounds with generous headroom (node's WebCrypto is far slower than a
    // browser's native subtle, and CI machines vary). These catch a real ≥10x
    // regression, not normal variance.
    expect(byLabel('wrapV2')).toBeLessThan(80);
    expect(byLabel('unwrapV2')).toBeLessThan(80);

    // A single inbound v2 event for a normal user (a handful of conversations)
    // is single-digit ms of crypto — NOT where messaging latency lives. The
    // O(N) cache scan only becomes material in the hundreds-of-peers range,
    // which is why the unbounded symmetricKeyCache wants an LRU cap + per-peer
    // keying (see recommendations).
    expect(byLabel('cache scan @ 50')).toBeLessThan(80);
  }, 60_000);
});
