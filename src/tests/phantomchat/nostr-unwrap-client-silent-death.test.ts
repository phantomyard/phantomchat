import {describe, it, expect, vi, afterEach} from 'vitest';
import {getNostrUnwrapClient, disposeNostrUnwrapClient} from '@lib/phantomchat/nostr-unwrap-client';
import {wrapNip17Message, type NTNostrEvent} from '@lib/phantomchat/nostr-crypto';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';

// Regression tests for issue #204: after a long Android-Chrome freeze, Chrome
// can kill the unwrap worker outright. A dead worker sends no `onerror`, so
// the client used to learn nothing — every unwrap ate a full 3s timeout and
// the strictly-serial catch-up backlog drained at ~1 message per 3 seconds
// (an app that looks dead for minutes, then "recovers").
//
// Contract under test: a timeout on a worker that has produced NO reply within
// a full round-trip window is worker death → degrade() (bounded respawn + sync
// fallback for everything in flight). A timeout on a worker that HAS replied
// recently stays the per-event rescue it always was.

// A worker that accepts the key and then never replies — the Chrome-killed
// worker's observable behaviour.
class SilentWorker {
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  constructor(public url: URL, public opts?: any) {}
  postMessage(_msg: any): void { /* silence */ }
  terminate(): void {}
}

// A live worker: echoes a rumor for the first `replies` unwrap posts, then
// goes silent (simulating the worker dying mid-session).
const ECHO_RUMOR = {kind: 14, content: 'echoed', pubkey: 'aa', created_at: 1, tags: [] as string[][], id: 'echo'};
class EchoThenSilentWorker {
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  replies = 1;
  constructor(public url: URL, public opts?: any) {}
  postMessage(msg: any): void {
    if(msg.type !== 'id' && !('event' in msg)) return; // key/warm posts: stay silent
    if(this.replies > 0) {
      this.replies--;
      this.onmessage?.({data: {id: msg.id, rumor: ECHO_RUMOR}});
    }
  }
  terminate(): void {}
}

describe('NostrUnwrapClient: silent worker = worker death (#204)', () => {
  const senderSk = generateSecretKey();
  const recipientSk = generateSecretKey();
  const recipientPub = getPublicKey(recipientSk);
  const client = getNostrUnwrapClient();

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).Worker;
    disposeNostrUnwrapClient();
  });

  it('treats a timeout on a never-replying worker as worker death (degrade + sync fallback)', async() => {
    (globalThis as any).Worker = SilentWorker;
    vi.useFakeTimers();

    const {wraps} = wrapNip17Message(senderSk, recipientPub, 'backlog msg');
    const p = client.unwrap(wraps[0] as NTNostrEvent, recipientSk);
    await vi.advanceTimersByTimeAsync(3000);
    const rumor = await p;

    // The message still unwraps correctly (sync fallback), via the death path.
    expect(rumor.content).toBe('backlog msg');
    expect(client.stats.timeout).toBeGreaterThan(0);
    expect(client.stats.timeoutDegrade).toBeGreaterThan(0);
    expect(client.stats.degrade).toBeGreaterThan(0);
  });

  it('drains the rest of a backlog synchronously instead of one 3s timeout each', async() => {
    (globalThis as any).Worker = SilentWorker;
    vi.useFakeTimers();

    const batch = Array.from({length: 4}, (_, i) =>
      wrapNip17Message(senderSk, recipientPub, `msg-${i}`));
    const promises = batch.map(({wraps}) => client.unwrap(wraps[0] as NTNostrEvent, recipientSk));

    // One window to fire the first timeout + degrade; degrade() drains the
    // remaining three synchronously in the same tick — pre-fix, each of the
    // four would need its own 3s advance.
    await vi.advanceTimersByTimeAsync(3100);
    const rumors = await Promise.all(promises);
    rumors.forEach((r, i) => expect(r.content).toBe(`msg-${i}`));
    expect(client.stats.timeoutDegrade).toBeGreaterThan(0);
    expect(client.stats.timeout).toBeLessThan(4); // degrade saved the other three timeouts
  });

  it('respawns a fresh worker only after the cooldown elapses (bounded, not thrashing)', async() => {
    (globalThis as any).Worker = SilentWorker;
    vi.useFakeTimers();

    const {wraps} = wrapNip17Message(senderSk, recipientPub, 'first');
    const p = client.unwrap(wraps[0] as NTNostrEvent, recipientSk);
    await vi.advanceTimersByTimeAsync(3000);
    await p;

    // Inside the cooldown: no respawn, straight synchronous fallback.
    const {wraps: wraps2} = wrapNip17Message(senderSk, recipientPub, 'second');
    const respawnsBefore = client.stats.respawn;
    const p2 = client.unwrap(wraps2[0] as NTNostrEvent, recipientSk);
    expect(client.stats.respawn).toBe(respawnsBefore);
    await vi.advanceTimersByTimeAsync(3000);
    await p2;

    // Past the cooldown: ensure() respawns a fresh worker.
    await vi.advanceTimersByTimeAsync(31000);
    const {wraps: wraps3} = wrapNip17Message(senderSk, recipientPub, 'third');
    const p3 = client.unwrap(wraps3[0] as NTNostrEvent, recipientSk);
    expect(client.stats.respawn).toBe(respawnsBefore + 1);
    await vi.advanceTimersByTimeAsync(3000);
    await p3;
  });

  it('does NOT degrade on a timeout when the worker replied within the window (slow, not dead)', async() => {
    (globalThis as any).Worker = EchoThenSilentWorker;
    vi.useFakeTimers();

    // First unwrap: the worker echoes immediately — liveness timestamp set.
    const {wraps} = wrapNip17Message(senderSk, recipientPub, 'alive');
    await client.unwrap(wraps[0] as NTNostrEvent, recipientSk);

    // Second unwrap: the worker has now gone silent. The timeout fires exactly
    // one window after the last reply — that is "slow round-trip", not death.
    const t0 = {timeout: client.stats.timeout, degrade: client.stats.timeoutDegrade, full: client.stats.degrade};
    const {wraps: wraps2} = wrapNip17Message(senderSk, recipientPub, 'slow');
    const p2 = client.unwrap(wraps2[0] as NTNostrEvent, recipientSk);
    await vi.advanceTimersByTimeAsync(3000);
    await p2; // per-event rescue, still correct

    expect(client.stats.timeout).toBe(t0.timeout + 1);
    expect(client.stats.timeoutDegrade).toBe(t0.degrade);
    expect(client.stats.degrade).toBe(t0.full);
  });
});