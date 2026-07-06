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

  describe('setPort — discovered ephemeral port', () => {
    it('dials the newly-set port on the next probe', async() => {
      const t = new LocalWsTransport();
      t.setPort(52345);
      expect(t.getPort()).toBe(52345);
      t.ensureConnected();
      expect(sockets[0].url).toBe('ws://localhost:52345');
    });

    it('is a no-op for an unchanged, zero, or negative port', () => {
      const t = new LocalWsTransport(50000);
      t.setPort(50000);
      t.setPort(0);
      t.setPort(-5);
      expect(t.getPort()).toBe(50000);
    });

    it('drops an existing connection so the next send re-probes the new port', async() => {
      const t = new LocalWsTransport(50000);
      const p = t.ensureConnected();
      fireOpen(sockets[0]);
      await p;
      expect(t.isConnected()).toBe(true);

      t.setPort(50001);
      expect(t.isConnected()).toBe(false); // old socket dropped
      t.ensureConnected();
      expect(sockets[1].url).toBe('ws://localhost:50001');
    });

    it('discards an in-flight probe whose port changed mid-connect (stale gen)', async() => {
      const t = new LocalWsTransport(50000);
      const p = t.ensureConnected(); // probing :50000
      t.setPort(50001); // port changes before the socket opens
      fireOpen(sockets[0]); // the stale :50000 socket finally opens
      expect(await p).toBe(false); // discarded, not cached
      expect(sockets[0].close).toHaveBeenCalled();
      expect(t.isConnected()).toBe(false);
    });
  });
});
