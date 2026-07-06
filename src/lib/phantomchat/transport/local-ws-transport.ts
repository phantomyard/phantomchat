/*
 * PhantomChat.chat — same-machine transport over ws://localhost (issue #61)
 *
 * Tier 1 of the transport ladder. When the PWA and a phantombot node run on the
 * SAME machine, the browser can open a plain WebSocket to the node on loopback
 * with zero signaling and zero Nostr round-trip — the connection is a single WS
 * upgrade and steady-state latency is ~1ms.
 *
 * `localhost` is a secure context, so an HTTPS-served PWA is allowed to open
 * `ws://localhost` (this is NOT blocked as mixed content the way `ws://<LAN-IP>`
 * would be). If nothing is listening the browser fails with an immediate
 * connection-refused — there is no TCP timeout to wait on — so the fast-fail
 * cost of probing this tier is effectively zero. The explicit timeout below only
 * fires in the pathological "socket accepted but never opens" case.
 */

import {logSwallow} from '@lib/phantomchat/log-swallow';

/**
 * Default loopback port the local phantombot node exposes for the ws bridge.
 * MUST stay in sync with the port chosen in phantomyard/phantombot#258.
 */
export const DEFAULT_LOCAL_NODE_PORT = 47100;

/**
 * Fast-fail budget for the localhost probe. Kept aggressive on purpose: a
 * same-machine node connects in ~1ms and a missing node refuses instantly, so
 * this only bounds the rare "listening but stuck" case. Short enough that a peer
 * which advertised P2P but has no local node drops to the WebRTC tier with no
 * perceptible stall.
 */
export const LOCAL_PROBE_TIMEOUT_MS = 80;

/**
 * A cached WebSocket connection to a same-machine phantombot node. Lazily
 * connects on first use, reuses an open socket, and drops it on close so the
 * next attempt re-probes cleanly.
 */
export class LocalWsTransport {
  private port: number;
  private timeoutMs: number;
  private socket: WebSocket | null = null;
  private connecting: Promise<WebSocket | null> | null = null;
  /** Bumped on every port change so an in-flight probe for a stale port is
   * discarded rather than cached (see probe's open handler). */
  private portGen = 0;

  constructor(port: number = DEFAULT_LOCAL_NODE_PORT, timeoutMs: number = LOCAL_PROBE_TIMEOUT_MS) {
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  /** The loopback port this transport currently dials. */
  getPort(): number {
    return this.port;
  }

  /**
   * Point the transport at a newly-discovered loopback port (the local node's
   * OS-ephemeral port, learned from our own self-encrypted capability advert —
   * phantombot#258). No-op if unchanged. On a change, drops any cached/in-flight
   * socket so the next probe dials the new port cleanly.
   */
  setPort(port: number): void {
    if(!Number.isInteger(port) || port <= 0 || port === this.port) return;
    this.port = port;
    this.portGen++;
    this.close();
    this.connecting = null;
  }

  /** Is there an open loopback socket right now? */
  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  /**
   * Ensure a loopback socket is open, probing with the fast-fail budget.
   * Resolves true if a socket is ready, false if nothing is listening (or the
   * probe timed out). Never throws.
   */
  async ensureConnected(): Promise<boolean> {
    if(this.isConnected()) return true;
    if(this.connecting) return (await this.connecting) !== null;

    this.connecting = this.probe();
    const sock = await this.connecting;
    this.connecting = null;
    return sock !== null;
  }

  private probe(): Promise<WebSocket | null> {
    return new Promise<WebSocket | null>((resolve) => {
      let settled = false;
      let ws: WebSocket;
      // Snapshot the port generation: if setPort() runs mid-probe, this socket
      // is for a stale port and must be discarded, not cached.
      const gen = this.portGen;

      try {
        ws = new WebSocket(`ws://localhost:${this.port}`);
      } catch(e) {
        logSwallow('LocalWsTransport.construct', e);
        resolve(null);
        return;
      }

      const timer = setTimeout(() => {
        if(settled) return;
        settled = true;
        try {
          ws.close();
        } catch(e) { logSwallow('LocalWsTransport.probeTimeoutClose', e); }
        resolve(null);
      }, this.timeoutMs);

      ws.addEventListener('open', () => {
        if(settled) return;
        settled = true;
        clearTimeout(timer);
        // The port changed while this probe was in flight — this socket is for a
        // stale port. Drop it so the next attempt re-probes the current port.
        if(gen !== this.portGen) {
          try {
            ws.close();
          } catch(e) { logSwallow('LocalWsTransport.staleProbeClose', e); }
          resolve(null);
          return;
        }
        this.socket = ws;
        ws.addEventListener('close', () => {
          if(this.socket === ws) this.socket = null;
        });
        resolve(ws);
      });

      ws.addEventListener('error', () => {
        if(settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      });
    });
  }

  /**
   * Send a payload over the open loopback socket. Returns false if not
   * connected or the send fails; the caller then drops to the next tier.
   */
  send(payload: string): boolean {
    if(!this.isConnected() || !this.socket) return false;
    try {
      this.socket.send(payload);
      return true;
    } catch(e) {
      logSwallow('LocalWsTransport.send', e);
      return false;
    }
  }

  close(): void {
    if(this.socket) {
      try {
        this.socket.close();
      } catch(e) { logSwallow('LocalWsTransport.close', e); }
      this.socket = null;
    }
  }
}
