/**
 * Tests for NIP-42 relay AUTH + publish read-back verification (issue #130,
 * mirror of phantombot #370).
 *
 * Covers:
 *  - answering an ["AUTH", challenge] frame with a signed kind-22242 event
 *  - retrying publishes rejected with `auth-required:` after the handshake
 *  - giving up (loudly) after one retry
 *  - read-back verification confirming an ACK'd event was actually stored
 *  - read-back warning naming the relay when the event never landed
 *  - ephemeral events skipping read-back
 *  - re-authentication after reconnect (challenge is per-connection)
 */

import '../setup';
import {NostrRelay, NOSTR_KIND_AUTH, NostrEvent} from '@lib/phantomchat/nostr-relay';
import {generateSecretKey, getPublicKey, finalizeEvent, verifyEvent} from 'nostr-tools/pure';
import {bytesToHex} from 'nostr-tools/utils';

// Track last created WebSocket instance for test inspection
let lastMockWs: MockWebSocket | null = null;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  sentMessages: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.(new Event('open'));
    }, 10);
    lastMockWs = this;
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  simulateMessage(message: unknown): void {
    this.onmessage?.(new MessageEvent('message', {data: JSON.stringify(message)}));
  }
}

(global as any).WebSocket = MockWebSocket;

const RELAY_URL = 'wss://auth-test.relay';
const testPriv = generateSecretKey();
const testPubHex = getPublicKey(testPriv);

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** A relay with identity wired in, connected against the mock socket. */
async function makeConnectedRelay(): Promise<{relay: NostrRelay; ws: MockWebSocket}> {
  const relay = new NostrRelay(RELAY_URL);
  (relay as any).privateKey = testPriv;
  (relay as any).publicKey = testPubHex;
  relay.connect();
  await sleep(30); // let the mock onopen fire
  const ws = lastMockWs;
  if(!ws) throw new Error('mock ws not created');
  return {relay, ws};
}

function sentFrames(ws: MockWebSocket, type: string): unknown[][] {
  return ws.sentMessages
    .map(m => JSON.parse(m))
    .filter(m => Array.isArray(m) && m[0] === type);
}

function makeStoredEvent(content = 'test'): NostrEvent {
  return finalizeEvent({
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content,
  }, testPriv) as NostrEvent;
}

describe('NIP-42 AUTH (issue #130)', () => {
  test('answers an AUTH challenge with a signed kind-22242 event scoped to the relay', async () => {
    const {ws} = await makeConnectedRelay();

    ws.simulateMessage(['AUTH', 'challenge-abc']);

    const authFrames = sentFrames(ws, 'AUTH');
    expect(authFrames.length).toBe(1);
    const authEvent = authFrames[0][1] as NostrEvent & {id: string; sig: string};
    expect(authEvent.kind).toBe(NOSTR_KIND_AUTH);
    expect(authEvent.tags).toContainEqual(['relay', RELAY_URL]);
    expect(authEvent.tags).toContainEqual(['challenge', 'challenge-abc']);
    expect(verifyEvent(authEvent as any)).toBe(true);
    expect(authEvent.pubkey).toBe(testPubHex);
  });

  test('warns and does not answer AUTH when no identity is loaded', async () => {
    const relay = new NostrRelay(RELAY_URL);
    const warns: unknown[][] = [];
    (relay as any).log.warn = (...args: unknown[]) => warns.push(args);
    relay.connect();
    await sleep(30);
    const ws = lastMockWs!;

    ws.simulateMessage(['AUTH', 'challenge-abc']);

    expect(sentFrames(ws, 'AUTH').length).toBe(0);
    expect(warns.length).toBe(1);
  });

  test('retries an auth-required rejected publish after the AUTH handshake', async () => {
    const {relay, ws} = await makeConnectedRelay();
    const event = makeStoredEvent();

    relay.publishRawEvent(event);
    expect(sentFrames(ws, 'EVENT').length).toBe(1);

    // Relay rejects: needs auth first.
    ws.simulateMessage(['OK', event.id, false, 'auth-required: we only accept events from authenticated users']);
    // Relay then challenges (nostr-rs-relay sends AUTH at connect; either order works).
    ws.simulateMessage(['AUTH', 'challenge-xyz']);

    expect(sentFrames(ws, 'AUTH').length).toBe(1);
    const eventFrames = sentFrames(ws, 'EVENT');
    expect(eventFrames.length).toBe(2); // original + retry
    expect((eventFrames[1][1] as NostrEvent).id).toBe(event.id);
  });

  test('retries immediately when already authed on this connection', async () => {
    const {relay, ws} = await makeConnectedRelay();

    ws.simulateMessage(['AUTH', 'challenge-1']);
    expect(sentFrames(ws, 'AUTH').length).toBe(1);

    const event = makeStoredEvent();
    relay.publishRawEvent(event);
    ws.simulateMessage(['OK', event.id, false, 'auth-required: still want auth']);

    // No second challenge needed — the queued publish retries immediately.
    expect(sentFrames(ws, 'EVENT').length).toBe(2);
  });

  test('gives up after one retry — a second auth-required rejection does not loop', async () => {
    const {relay, ws} = await makeConnectedRelay();
    const warns: unknown[][] = [];
    const origWarn = (relay as any).log.warn.bind((relay as any).log);
    (relay as any).log.warn = (...args: unknown[]) => {
      warns.push(args);
      origWarn(...args);
    };

    const event = makeStoredEvent();
    relay.publishRawEvent(event);
    ws.simulateMessage(['OK', event.id, false, 'auth-required: need auth']);
    ws.simulateMessage(['AUTH', 'challenge-1']);
    expect(sentFrames(ws, 'EVENT').length).toBe(2); // retried once

    // Relay rejects AGAIN — must not requeue.
    ws.simulateMessage(['OK', event.id, false, 'auth-required: still no']);
    expect(sentFrames(ws, 'EVENT').length).toBe(2);
    expect(warns.some(w => String(w[0]).includes('giving up'))).toBe(true);
  });

  test('re-authenticates after reconnect (challenge is per-connection)', async () => {
    const {relay, ws} = await makeConnectedRelay();

    ws.simulateMessage(['AUTH', 'challenge-conn-1']);
    expect(sentFrames(ws, 'AUTH').length).toBe(1);

    // Simulate a dropped socket and a fresh dial.
    ws.readyState = MockWebSocket.CLOSED;
    (relay as any).connectionState = 'disconnected';
    relay.connect();
    await sleep(30);
    const ws2 = lastMockWs!;
    expect(ws2).not.toBe(ws);

    ws2.simulateMessage(['AUTH', 'challenge-conn-2']);
    const authFrames = sentFrames(ws2, 'AUTH');
    expect(authFrames.length).toBe(1);
    expect((authFrames[0][1] as NostrEvent).tags).toContainEqual(['challenge', 'challenge-conn-2']);
  });
});

describe('publish read-back verification (issue #130)', () => {
  test('resolves true when the relay returns the published event', async () => {
    const {relay, ws} = await makeConnectedRelay();
    const event = makeStoredEvent('readback-ok');

    const verifyPromise = relay.verifyStored(event, {settleMs: 5, timeoutMs: 500});
    await sleep(20); // let the REQ go out

    const reqs = sentFrames(ws, 'REQ');
    expect(reqs.length).toBe(1);
    const [, subId, filter] = reqs[0] as [string, string, {ids: string[]}];
    expect(filter.ids).toEqual([event.id]);

    // Relay answers: event found, then EOSE.
    ws.simulateMessage(['EVENT', subId, event]);
    ws.simulateMessage(['EOSE', subId]);

    await expect(verifyPromise).resolves.toBe(true);
  });

  test('warns naming the relay when an ACKed event is never stored', async () => {
    const {relay, ws} = await makeConnectedRelay();
    const warns: unknown[][] = [];
    const origWarn = (relay as any).log.warn.bind((relay as any).log);
    (relay as any).log.warn = (...args: unknown[]) => {
      warns.push(args);
      origWarn(...args);
    };
    const event = makeStoredEvent('readback-missing');

    const verifyPromise = relay.verifyStored(event, {settleMs: 5, timeoutMs: 100});
    await expect(verifyPromise).resolves.toBe(false);

    // The read-back REQ still went out.
    expect(sentFrames(ws, 'REQ').length).toBe(1);
    const dropWarn = warns.find(w => String(w[0]).includes('NOT confirmed stored'));
    expect(dropWarn).toBeDefined();
    expect(dropWarn).toContain(RELAY_URL);
  });

  test('skips ephemeral events (kinds 20000–29999) — relays do not store them', async () => {
    const {relay, ws} = await makeConnectedRelay();
    const typingEvent = {
      kind: 20001,
      id: bytesToHex(generateSecretKey()),
    };

    const result = await relay.verifyStored(typingEvent, {settleMs: 5, timeoutMs: 100});

    expect(result).toBe(true);
    expect(sentFrames(ws, 'REQ').length).toBe(0);
  });

  test('read-back runs for live publishes (fire-and-forget, no throw)', async () => {
    const {relay, ws} = await makeConnectedRelay();
    (relay as any).readBackSettleMs = 5;
    (relay as any).readBackTimeoutMs = 100;

    const event = makeStoredEvent('readback-live');
    relay.publishRawEvent(event);

    await sleep(30);
    const reqs = sentFrames(ws, 'REQ');
    expect(reqs.length).toBe(1);
    const [, , filter] = reqs[0] as [string, string, {ids: string[]}];
    expect(filter.ids).toEqual([event.id]);
  });
});
