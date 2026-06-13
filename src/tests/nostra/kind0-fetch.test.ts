/**
 * Tests for kind 0 profile fetch → display name update flow (Checklist 1.4)
 *
 * Verifies:
 * 1. fetchNostrProfile() returns parsed profile from a mocked relay
 * 2. profileToDisplayName() extracts the correct display name
 * 3. End-to-end: WebSocket receives kind 0 → display_name is derived
 */

import '../setup';
import {fetchNostrProfile, profileToDisplayName, NostrProfile} from '@lib/nostra/nostr-profile';

// --- MockWebSocket ---

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
    lastMockWs = this;
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', {data: JSON.stringify(data)}));
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

// Install mock WebSocket globally
const OriginalWebSocket = (global as any).WebSocket;

beforeEach(() => {
  lastMockWs = null;
  (global as any).WebSocket = MockWebSocket;
});

afterEach(() => {
  (global as any).WebSocket = OriginalWebSocket;
});

// --- Kind 0 fetch unit tests ---

describe('kind 0 profile fetch', () => {
  const testPubkey = 'ab'.repeat(32);

  test('fetchNostrProfile returns profile with display_name from relay', async() => {
    const promise = fetchNostrProfile(testPubkey, ['wss://relay.test']);

    await vi.waitFor(() => expect(lastMockWs).not.toBeNull());
    const ws = lastMockWs!;
    ws.simulateOpen();

    const req = JSON.parse(ws.sentMessages[0]);
    const subId = req[1];

    // Simulate relay responding with kind 0 event containing display_name
    ws.simulateMessage([
      'EVENT',
      subId,
      {
        kind: 0,
        content: JSON.stringify({display_name: 'TestName'})
      }
    ]);

    const result = await promise;
    expect(result).toEqual({display_name: 'TestName'});
  });

  test('profileToDisplayName extracts display_name from fetched profile', () => {
    const profile: NostrProfile = {display_name: 'TestName'};
    expect(profileToDisplayName(profile)).toBe('TestName');
  });

  test('end-to-end: relay kind 0 event → profileToDisplayName returns correct name', async() => {
    const profileData = {
      display_name: 'AliceProfile',
      name: 'alice',
      about: 'Hello world'
    };

    const promise = fetchNostrProfile(testPubkey, ['wss://relay.test']);

    await vi.waitFor(() => expect(lastMockWs).not.toBeNull());
    const ws = lastMockWs!;
    ws.simulateOpen();

    const req = JSON.parse(ws.sentMessages[0]);
    const subId = req[1];

    ws.simulateMessage([
      'EVENT',
      subId,
      {
        kind: 0,
        content: JSON.stringify(profileData)
      }
    ]);

    const profile = await promise;
    expect(profile).not.toBeNull();
    expect(profileToDisplayName(profile)).toBe('AliceProfile');
  });

  test('fetchNostrProfile sends correct REQ filter for kind 0', async() => {
    const promise = fetchNostrProfile(testPubkey, ['wss://relay.test']);

    await vi.waitFor(() => expect(lastMockWs).not.toBeNull());
    const ws = lastMockWs!;
    ws.simulateOpen();

    expect(ws.sentMessages.length).toBe(1);
    const req = JSON.parse(ws.sentMessages[0]);
    expect(req[0]).toBe('REQ');
    expect(req[2]).toEqual({
      kinds: [0],
      authors: [testPubkey],
      limit: 1
    });

    // Clean up — send EOSE to resolve the promise
    ws.simulateMessage(['EOSE', req[1]]);
    await promise;
  });

  test('fetchNostrProfile returns null when relay has no kind 0 for pubkey', async() => {
    const promise = fetchNostrProfile(testPubkey, ['wss://relay.test']);

    await vi.waitFor(() => expect(lastMockWs).not.toBeNull());
    const ws = lastMockWs!;
    ws.simulateOpen();

    const req = JSON.parse(ws.sentMessages[0]);
    ws.simulateMessage(['EOSE', req[1]]);

    const result = await promise;
    expect(result).toBeNull();
    expect(profileToDisplayName(result)).toBeNull();
  });

  test('fetchNostrProfile handles profile with name but no display_name', async() => {
    const promise = fetchNostrProfile(testPubkey, ['wss://relay.test']);

    await vi.waitFor(() => expect(lastMockWs).not.toBeNull());
    const ws = lastMockWs!;
    ws.simulateOpen();

    const req = JSON.parse(ws.sentMessages[0]);
    const subId = req[1];

    ws.simulateMessage([
      'EVENT',
      subId,
      {
        kind: 0,
        content: JSON.stringify({name: 'bob_nostr'})
      }
    ]);

    const profile = await promise;
    expect(profile).toEqual({name: 'bob_nostr'});
    expect(profileToDisplayName(profile)).toBe('bob_nostr');
  });

  test('fetchNostrProfile handles profile with all fields', async() => {
    const fullProfile = {
      display_name: 'Alice Display',
      name: 'alice',
      nip05: 'alice@example.com',
      picture: 'https://example.com/avatar.jpg',
      about: 'I am Alice'
    };

    const promise = fetchNostrProfile(testPubkey, ['wss://relay.test']);

    await vi.waitFor(() => expect(lastMockWs).not.toBeNull());
    const ws = lastMockWs!;
    ws.simulateOpen();

    const req = JSON.parse(ws.sentMessages[0]);
    ws.simulateMessage([
      'EVENT',
      req[1],
      {kind: 0, content: JSON.stringify(fullProfile)}
    ]);

    const profile = await promise;
    expect(profile).toEqual(fullProfile);
    expect(profileToDisplayName(profile)).toBe('Alice Display');
  });

  test('CLOSE is sent to relay after receiving EVENT', async() => {
    const promise = fetchNostrProfile(testPubkey, ['wss://relay.test']);

    await vi.waitFor(() => expect(lastMockWs).not.toBeNull());
    const ws = lastMockWs!;
    ws.simulateOpen();

    const req = JSON.parse(ws.sentMessages[0]);
    const subId = req[1];

    ws.simulateMessage([
      'EVENT',
      subId,
      {kind: 0, content: JSON.stringify({display_name: 'Test'})}
    ]);

    await promise;

    // Verify CLOSE was sent after receiving the event
    expect(ws.sentMessages.length).toBe(2);
    const closeMsg = JSON.parse(ws.sentMessages[1]);
    expect(closeMsg).toEqual(['CLOSE', subId]);
  });
});
