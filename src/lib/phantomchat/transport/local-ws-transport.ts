/*
 * PhantomChat.chat — same-machine transport over ws://localhost (issue #61)
 *
 * Tier 1 of the transport ladder. When the PWA and a RECIPIENT's phantombot node
 * run on the SAME machine, the browser opens a plain WebSocket to that node on
 * loopback with zero signaling and zero Nostr round-trip — a single WS upgrade,
 * steady-state latency ~1ms — and hands it the recipient-addressed gift-wrap.
 *
 * PER-PEER PORTS. Each phantombot node binds its OWN OS-ephemeral loopback port
 * and advertises it (plaintext) in its capability advert; the ingestor stores it
 * as `PeerCapabilities.localWsPort`. So there is no single "the local node" — a
 * box may run several nodes (max, lena, …) each on a different port. This
 * transport therefore keys its cached sockets BY PORT: `ensureConnected(port)`
 * dials/reuses the socket for that recipient's node, and the selector passes the
 * recipient's advertised port straight through.
 *
 * `localhost` is a secure context, so an HTTPS-served PWA is allowed to open
 * `ws://localhost` (this is NOT blocked as mixed content the way `ws://<LAN-IP>`
 * would be). If nothing is listening the browser fails with an immediate
 * connection-refused — there is no TCP timeout to wait on — so the fast-fail
 * cost of probing a port is effectively zero. The explicit timeout below only
 * fires in the pathological "socket accepted but never opens" case.
 */

import {logSwallow} from '@lib/phantomchat/log-swallow';

/**
 * Fast-fail budget for a localhost probe. Kept aggressive on purpose: a
 * same-machine node connects in ~1ms and a missing node refuses instantly, so
 * this only bounds the rare "listening but stuck" case. Short enough that a peer
 * which advertised P2P but has no reachable local node drops to the WebRTC tier
 * with no perceptible stall.
 */
export const LOCAL_PROBE_TIMEOUT_MS = 80;

/** A cached socket + its in-flight probe for one loopback port. */
interface PortEntry {
  socket: WebSocket | null;
  connecting: Promise<WebSocket | null> | null;
}

/**
 * A pool of cached WebSocket connections to same-machine phantombot nodes, keyed
 * by loopback port. Each recipient's node lives on its own OS-ephemeral port; the
 * pool lazily connects per port on first use, reuses an open socket, and drops it
 * on close so the next attempt re-probes cleanly.
 */
export class LocalWsTransport {
  private timeoutMs: number;
  private ports = new Map<number, PortEntry>();

  constructor(timeoutMs: number = LOCAL_PROBE_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  private entry(port: number): PortEntry {
    let e = this.ports.get(port);
    if(!e) {
      e = {socket: null, connecting: null};
      this.ports.set(port, e);
    }
    return e;
  }

  /** Is there an open loopback socket to `port` right now? */
  isConnected(port: number): boolean {
    const e = this.ports.get(port);
    return !!e && e.socket !== null && e.socket.readyState === WebSocket.OPEN;
  }

  /**
   * Ensure a loopback socket to `port` is open, probing with the fast-fail
   * budget. Resolves true if a socket is ready, false if nothing is listening
   * (or the probe timed out / the port is invalid). Never throws.
   */
  async ensureConnected(port: number): Promise<boolean> {
    if(!Number.isInteger(port) || port <= 0) return false;
    if(this.isConnected(port)) return true;
    const e = this.entry(port);
    if(e.connecting) return (await e.connecting) !== null;

    e.connecting = this.probe(port);
    const sock = await e.connecting;
    e.connecting = null;
    return sock !== null;
  }

  private probe(port: number): Promise<WebSocket | null> {
    return new Promise<WebSocket | null>((resolve) => {
      let settled = false;
      let ws: WebSocket;

      try {
        ws = new WebSocket(`ws://localhost:${port}`);
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
        const e = this.entry(port);
        e.socket = ws;
        ws.addEventListener('close', () => {
          if(e.socket === ws) e.socket = null;
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
   * Send a payload over the open loopback socket to `port`. Returns false if not
   * connected or the send fails; the caller then drops to the next tier.
   */
  send(port: number, payload: string): boolean {
    const e = this.ports.get(port);
    if(!e || !this.isConnected(port) || !e.socket) return false;
    try {
      e.socket.send(payload);
      return true;
    } catch(err) {
      logSwallow('LocalWsTransport.send', err);
      return false;
    }
  }

  /** Close one port's socket, or all of them when `port` is omitted. */
  close(port?: number): void {
    const closeEntry = (e: PortEntry) => {
      if(e.socket) {
        try {
          e.socket.close();
        } catch(err) { logSwallow('LocalWsTransport.close', err); }
        e.socket = null;
      }
    };
    if(port === undefined) {
      for(const e of this.ports.values()) closeEntry(e);
      this.ports.clear();
      return;
    }
    const e = this.ports.get(port);
    if(e) closeEntry(e);
  }
}
