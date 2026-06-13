/**
 * Tests for nostr-profile.ts — profile display name derivation and relay fetching
 */

import '../setup';
import {profileToDisplayName, fetchNostrProfile, NostrProfile} from '@lib/nostra/nostr-profile';

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

  // Test helpers
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

// --- profileToDisplayName tests ---

describe('profileToDisplayName', () => {
  test('returns null for null profile', () => {
    expect(profileToDisplayName(null)).toBeNull();
  });

  test('returns display_name when present', () => {
    const profile: NostrProfile = {display_name: 'Alice', name: 'alice'};
    expect(profileToDisplayName(profile)).toBe('Alice');
  });

  test('falls back to name when display_name is missing', () => {
    const profile: NostrProfile = {name: 'alice'};
    expect(profileToDisplayName(profile)).toBe('alice');
  });

  test('falls back to name when display_name is empty', () => {
    const profile: NostrProfile = {display_name: '', name: 'bob'};
    expect(profileToDisplayName(profile)).toBe('bob');
  });

  test('falls back to name when display_name is whitespace-only', () => {
    const profile: NostrProfile = {display_name: '   ', name: 'charlie'};
    expect(profileToDisplayName(profile)).toBe('charlie');
  });

  test('falls back to nip05 when name and display_name are missing', () => {
    const profile: NostrProfile = {nip05: 'alice@example.com'};
    expect(profileToDisplayName(profile)).toBe('alice@example.com');
  });

  test('falls back to nip05 when name and display_name are empty', () => {
    const profile: NostrProfile = {display_name: '', name: '', nip05: 'user@relay.io'};
    expect(profileToDisplayName(profile)).toBe('user@relay.io');
  });

  test('returns null when all fields are empty strings', () => {
    const profile: NostrProfile = {display_name: '', name: '', nip05: ''};
    expect(profileToDisplayName(profile)).toBeNull();
  });

  test('returns null for empty profile object', () => {
    const profile: NostrProfile = {};
    expect(profileToDisplayName(profile)).toBeNull();
  });

  test('trims whitespace from display_name', () => {
    const profile: NostrProfile = {display_name: '  Alice  '};
    expect(profileToDisplayName(profile)).toBe('Alice');
  });

  test('trims whitespace from name', () => {
    const profile: NostrProfile = {name: '  bob  '};
    expect(profileToDisplayName(profile)).toBe('bob');
  });

  test('trims whitespace from nip05', () => {
    const profile: NostrProfile = {nip05: '  user@relay.io  '};
    expect(profileToDisplayName(profile)).toBe('user@relay.io');
  });

  test('priority: display_name > name > nip05', () => {
    const profile: NostrProfile = {
      display_name: 'Display',
      name: 'name',
      nip05: 'nip@05.com'
    };
    expect(profileToDisplayName(profile)).toBe('Display');
  });
});

// --- fetchNostrProfile tests ---

describe('fetchNostrProfile', () => {
  const testPubkey = 'a'.repeat(64);

  test('returns profile when relay responds with EVENT', async() => {
    const profileData: NostrProfile = {
      display_name: 'Alice',
      name: 'alice',
      picture: 'https://example.com/pic.jpg'
    };

    const promise = fetchNostrProfile(testPubkey, ['wss://relay.test']);

    // Wait for WebSocket to be created
    await vi.waitFor(() => expect(lastMockWs).not.toBeNull());
    const ws = lastMockWs!;

    // Simulate connection
    ws.simulateOpen();

    // Verify the REQ was sent
    expect(ws.sentMessages.length).toBe(1);
    const req = JSON.parse(ws.sentMessages[0]);
    expect(req[0]).toBe('REQ');
    expect(req[2].kinds).toEqual([0]);
    expect(req[2].authors).toEqual([testPubkey]);
    expect(req[2].limit).toBe(1);

    const subId = req[1];

    // Simulate EVENT response
    ws.simulateMessage([
      'EVENT',
      subId,
      {kind: 0, content: JSON.stringify(profileData)}
    ]);

    const result = await promise;
    expect(result).toEqual(profileData);
  });

  test('returns null when relay responds with EOSE (no profile)', async() => {
    const promise = fetchNostrProfile(testPubkey, ['wss://relay.test']);

    await vi.waitFor(() => expect(lastMockWs).not.toBeNull());
    const ws = lastMockWs!;
    ws.simulateOpen();

    const req = JSON.parse(ws.sentMessages[0]);
    const subId = req[1];

    // Simulate EOSE (end of stored events, no profile)
    ws.simulateMessage(['EOSE', subId]);

    const result = await promise;
    expect(result).toBeNull();
  });

  test('returns null when WebSocket errors on all relays', async() => {
    const promise = fetchNostrProfile(testPubkey, ['wss://relay.test']);

    await vi.waitFor(() => expect(lastMockWs).not.toBeNull());
    const ws = lastMockWs!;

    ws.simulateError();

    const result = await promise;
    expect(result).toBeNull();
  });

  test('tries next relay when first relay fails', async() => {
    const profileData: NostrProfile = {name: 'Bob'};

    const promise = fetchNostrProfile(testPubkey, [
      'wss://relay1.test',
      'wss://relay2.test'
    ]);

    // First relay — error
    await vi.waitFor(() => expect(lastMockWs).not.toBeNull());
    const ws1 = lastMockWs!;
    expect(ws1.url).toBe('wss://relay1.test');
    ws1.simulateError();

    // Second relay — success
    await vi.waitFor(() => lastMockWs !== ws1);
    const ws2 = lastMockWs!;
    expect(ws2.url).toBe('wss://relay2.test');
    ws2.simulateOpen();

    const req = JSON.parse(ws2.sentMessages[0]);
    const subId = req[1];

    ws2.simulateMessage([
      'EVENT',
      subId,
      {kind: 0, content: JSON.stringify(profileData)}
    ]);

    const result = await promise;
    expect(result).toEqual(profileData);
  });

  test('returns null when WebSocket closes before any response', async() => {
    const promise = fetchNostrProfile(testPubkey, ['wss://relay.test']);

    await vi.waitFor(() => expect(lastMockWs).not.toBeNull());
    const ws = lastMockWs!;
    ws.simulateClose();

    const result = await promise;
    expect(result).toBeNull();
  });
});
