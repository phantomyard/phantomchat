// @ts-nocheck
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {LocalWsTransport} from '@lib/phantomchat/transport/local-ws-transport';

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

describe('LocalWsTransport — per-peer ws://localhost tier', () => {
  beforeEach(() => { sockets = []; });
  afterEach(() => vi.useRealTimers());

  it('dials the recipient-advertised port', async() => {
    const t = new LocalWsTransport();
    const p = t.ensureConnected(33297);
    expect(sockets[0].url).toBe('ws://localhost:33297');
    fireOpen(sockets[0]);
    expect(await p).toBe(true);
    expect(t.isConnected(33297)).toBe(true);
  });

  it('refuses an invalid port without opening a socket', async() => {
    const t = new LocalWsTransport();
    expect(await t.ensureConnected(0)).toBe(false);
    expect(await t.ensureConnected(-5)).toBe(false);
    expect(sockets.length).toBe(0);
  });

  it('resolves false instantly on connection-refused (no listener)', async() => {
    const t = new LocalWsTransport();
    const p = t.ensureConnected(40000);
    fireError(sockets[0]);
    expect(await p).toBe(false);
    expect(t.isConnected(40000)).toBe(false);
  });

  it('fast-fails at the timeout when the socket never opens', async() => {
    vi.useFakeTimers();
    const t = new LocalWsTransport(80);
    const p = t.ensureConnected(40000);
    await vi.advanceTimersByTimeAsync(80);
    expect(await p).toBe(false);
    expect(sockets[0].close).toHaveBeenCalled();
  });

  it('reuses an open socket for the same port instead of re-probing', async() => {
    const t = new LocalWsTransport();
    const p = t.ensureConnected(40000);
    fireOpen(sockets[0]);
    await p;
    expect(await t.ensureConnected(40000)).toBe(true);
    expect(sockets.length).toBe(1); // no second socket created
  });

  it('keeps separate sockets per recipient port', async() => {
    const t = new LocalWsTransport();
    const a = t.ensureConnected(33297);
    const b = t.ensureConnected(44112);
    expect(sockets.map((s) => s.url)).toEqual([
      'ws://localhost:33297',
      'ws://localhost:44112'
    ]);
    fireOpen(sockets[0]);
    fireOpen(sockets[1]);
    await a; await b;
    expect(t.isConnected(33297)).toBe(true);
    expect(t.isConnected(44112)).toBe(true);
  });

  it('send() targets the socket for the given port', async() => {
    const t = new LocalWsTransport();
    expect(t.send(33297, 'x')).toBe(false); // not connected yet
    const p = t.ensureConnected(33297);
    fireOpen(sockets[0]);
    await p;
    expect(t.send(33297, 'hello')).toBe(true);
    expect(sockets[0].send).toHaveBeenCalledWith('hello');
    // A port with no socket declines rather than misrouting.
    expect(t.send(44112, 'nope')).toBe(false);
  });

  it('close(port) drops one socket; close() drops all', async() => {
    const t = new LocalWsTransport();
    const a = t.ensureConnected(33297);
    const b = t.ensureConnected(44112);
    fireOpen(sockets[0]); fireOpen(sockets[1]);
    await a; await b;

    t.close(33297);
    expect(t.isConnected(33297)).toBe(false);
    expect(t.isConnected(44112)).toBe(true);

    t.close();
    expect(t.isConnected(44112)).toBe(false);
  });
});
