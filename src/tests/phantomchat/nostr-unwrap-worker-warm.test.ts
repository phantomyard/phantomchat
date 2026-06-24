/**
 * Worker-cache warming (#root-cause: startup freeze).
 *
 * v2 unwrap derives its key from the unwrap worker's OWN symmetric-key cache,
 * which starts empty. Unwarmed, every v2 gift-wrap misses, the worker replies
 * `no_matching_key`, and the client retries unwrapV2 on the MAIN thread — so a
 * cold-load backfill of that crypto freezes the UI. These tests pin the fix:
 *   - warm(sk, peers) actually posts {type:'warm', peers} to the worker.
 *   - a worker no_matching_key for a v2 event self-heals by warming the worker
 *     with the real sender so the next message unwraps in-worker.
 *
 * vitest has no real Worker, so we install a controllable mock.
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {getNostrUnwrapClient, disposeNostrUnwrapClient} from '@lib/phantomchat/nostr-unwrap-client';
import {getSymmetricKey, wrapV2, type NTNostrEvent} from '@lib/phantomchat/nostr-crypto';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';

const posted: any[] = [];
let lastWorker: MockWorker | null = null;

class MockWorker {
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  constructor(_url: any, _opts?: any) { lastWorker = this; }
  postMessage(msg: any) { posted.push(msg); }
  terminate() {}
  // Test helper: simulate the worker replying for a given request id.
  reply(id: number, payload: any) { this.onmessage?.({data: {id, ...payload}}); }
}

describe('unwrap worker cache warming', () => {
  const senderSk = generateSecretKey();
  const senderPub = getPublicKey(senderSk);
  const recipientSk = generateSecretKey();

  beforeEach(() => {
    posted.length = 0;
    lastWorker = null;
    (globalThis as any).Worker = MockWorker as any;
    disposeNostrUnwrapClient(); // reset singleton so it re-spawns the mock
  });

  afterEach(() => {
    disposeNostrUnwrapClient();
    delete (globalThis as any).Worker; // restore vitest's no-Worker default for other files
  });

  it('warm() posts the key then the peer list to the worker', () => {
    getNostrUnwrapClient().warm(recipientSk, [senderPub]);
    // ensure() posts the key first, then warm posts the peers.
    expect(posted[0]).toMatchObject({type: 'key'});
    expect(posted.find((m) => m.type === 'warm')).toMatchObject({type: 'warm', peers: [senderPub]});
  });

  it('self-heals the worker after a no_matching_key main-thread fallback', async() => {
    // Pre-warm the MAIN-thread cache so the fallback unwrapV2 can actually decrypt.
    await getSymmetricKey(recipientSk, senderPub);
    const {event} = await wrapV2(senderSk, getPublicKey(recipientSk), 'unfreeze me');

    const client = getNostrUnwrapClient();
    const p = client.unwrap(event as NTNostrEvent, recipientSk);

    // The request was dispatched to the worker...
    const req = posted.find((m) => m.id !== undefined);
    expect(req).toBeTruthy();

    // ...the worker reports an empty-cache miss for this v2 event.
    lastWorker!.reply(req.id, {error: {code: 'no_matching_key'}});

    const rumor = await p;
    expect(rumor.content).toBe('unfreeze me');
    expect(rumor.pubkey).toBe(senderPub);

    // Self-heal: the worker was taught this sender for next time.
    const heal = posted.filter((m) => m.type === 'warm').pop();
    expect(heal).toMatchObject({type: 'warm', peers: [senderPub]});
  });
});
