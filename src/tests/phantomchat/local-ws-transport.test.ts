// @ts-nocheck
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {LocalWsTransport, DEFAULT_LOCAL_NODE_PORT} from '@lib/phantomchat/transport/local-ws-transport';

// Mock WebSocket (mirrors the pattern in nostr-relay.test.ts). Defined and
// installed at module load so the transport resolves it via `new WebSocket()`.
let sockets = [];

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.handlers = {};
    this.send = vi.fn();
    this.close = vi.fn(() => { this.readyState = MockWebSocket.CLOSED; });
    sockets.push(this);
  }

  addEventListener(ev, h) { this.handlers[ev] = h; }
}

(global as any).WebSocket = MockWebSocket;

function fireOpen(sock) { sock.readyState = MockWebSocket.OPEN; sock.handlers.open?.(); }
function fireError(sock) { sock.handlers.error?.(new Error('refused')); }

describe('LocalWsTransport — same-machine ws://localhost tier', () => {
  beforeEach(() => { sockets = []; });
  afterEach(() => vi.useRealTimers());

  it('connects to ws://localhost on the default node port', async() => {
    const t = new LocalWsTransport();
    const p = t.ensureConnected();
    expect(sockets[0].url).toBe(`ws://localhost:${DEFAULT_LOCAL_NODE_PORT}`);
    fireOpen(sockets[0]);
    expect(await p).toBe(true);
    expect(t.isConnected()).toBe(true);
  });

  it('resolves false instantly on connection-refused (no listener)', async() => {
    const t = new LocalWsTransport();
    const p = t.ensureConnected();
    fireError(sockets[0]);
    expect(await p).toBe(false);
    expect(t.isConnected()).toBe(false);
  });

  it('fast-fails at the timeout when the socket never opens', async() => {
    vi.useFakeTimers();
    const t = new LocalWsTransport(DEFAULT_LOCAL_NODE_PORT, 80);
    const p = t.ensureConnected();
    await vi.advanceTimersByTimeAsync(80);
    expect(await p).toBe(false);
    expect(sockets[0].close).toHaveBeenCalled();
  });

  it('reuses an open socket instead of re-probing', async() => {
    const t = new LocalWsTransport();
    const p = t.ensureConnected();
    fireOpen(sockets[0]);
    await p;
    expect(await t.ensureConnected()).toBe(true);
    expect(sockets.length).toBe(1); // no second socket created
  });

  it('send() returns false when not connected, true when connected', async() => {
    const t = new LocalWsTransport();
    expect(t.send('x')).toBe(false);
    const p = t.ensureConnected();
    fireOpen(sockets[0]);
    await p;
    expect(t.send('hello')).toBe(true);
    expect(sockets[0].send).toHaveBeenCalledWith('hello');
  });
});
