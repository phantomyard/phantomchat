/**
 * Local Nostr relay (strfry in Docker) for E2E tests.
 *
 * Usage:
 *   const relay = new LocalRelay();
 *   await relay.start();          // starts container, waits for health
 *   const url = relay.url;        // ws://localhost:7777
 *   await relay.injectInto(ctx);  // pre-populates browser context IndexedDB
 *   // ... run tests ...
 *   await relay.stop();           // removes container
 */

// @ts-nocheck
import {execSync} from 'child_process';
import type {BrowserContext} from 'playwright';

const CONTAINER_NAME = 'nostra-e2e-relay';
const HOST_PORT = 7777;
const IMAGE = 'pluja/strfry:latest';

const STRFRY_CONF = `
relay {
    bind = "0.0.0.0"
    port = ${HOST_PORT}
    nofiles = 100000
    info {
        name = "E2E Test Relay"
        description = "Local relay for Nostra.chat E2E tests"
    }
}
events {
    maxEventSize = 65536
    rejectEventsNewerThanSeconds = 900
    rejectEventsOlderThanSeconds = 94608000
    rejectEphemeralEventsOlderThanSeconds = 60
    ephemeralEventsLifetimeSeconds = 300
    maxNumTags = 2000
    maxTagValSize = 1024
}
`.trim();

function exec(cmd: string): string {
  return execSync(cmd, {encoding: 'utf-8', timeout: 30000}).trim();
}

export class LocalRelay {
  public readonly url = `ws://localhost:${HOST_PORT}`;
  private running = false;

  /** Start the strfry Docker container. Idempotent — skips if already running. */
  async start(): Promise<void> {
    // Check if already running
    try {
      const state = exec(`docker inspect -f '{{.State.Running}}' ${CONTAINER_NAME} 2>/dev/null`);
      if(state === 'true') {
        this.running = true;
        return;
      }
    } catch{ /* not running */ }

    // Remove any stopped container with same name
    try { exec(`docker rm -f ${CONTAINER_NAME} 2>/dev/null`); } catch{ /* ignore */ }

    // Clean data dir via a throwaway container (files are owned by root)
    try { exec('docker run --rm -v /tmp/strfry-e2e-data:/d alpine rm -rf /d/*'); } catch{ /* ignore */ }

    // Write config to temp file
    const confPath = '/tmp/strfry-e2e.conf';
    const fs = await import('fs');
    fs.writeFileSync(confPath, STRFRY_CONF);

    // Start container with --user so data files are owned by the host user.
    // This makes stop() cleanup reliable without needing root or a helper container.
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    exec([
      'docker run -d',
      `--name ${CONTAINER_NAME}`,
      `--user ${uid}:${gid}`,
      `-p ${HOST_PORT}:${HOST_PORT}`,
      `-v ${confPath}:/etc/strfry.conf:ro`,
      `--tmpfs /app/strfry-db:uid=${uid},gid=${gid}`,
      IMAGE
    ].join(' '));

    // Wait for TCP readiness (up to 10s)
    const deadline = Date.now() + 10000;
    while(Date.now() < deadline) {
      try {
        const net = await import('net');
        await new Promise<void>((resolve, reject) => {
          const c = net.createConnection(HOST_PORT, 'localhost');
          c.on('connect', () => { c.end(); resolve(); });
          c.on('error', reject);
          setTimeout(() => reject(new Error('timeout')), 1000);
        });
        this.running = true;
        return;
      } catch{
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error('LocalRelay: strfry failed to start within 10s');
  }

  /** Stop and remove the Docker container. */
  async stop(): Promise<void> {
    try { exec(`docker rm -f ${CONTAINER_NAME} 2>/dev/null`); } catch{ /* ignore */ }
    // With --tmpfs the data dir lives in RAM inside the container —
    // nothing on disk to clean up. Remove stale host-mounted dirs from
    // older runs if they exist.
    try { exec('rm -rf /tmp/strfry-e2e-data 2>/dev/null'); } catch{ /* ignore */ }
    this.running = false;
  }

  /**
   * Inject the local relay URL into a Playwright BrowserContext.
   * Sets window.__nostraTestRelays BEFORE any app code loads, which
   * nostr-relay-pool.ts reads at module init time to override DEFAULT_RELAYS.
   */
  async injectInto(ctx: BrowserContext): Promise<void> {
    const relayConfig = JSON.stringify([
      {url: this.url, read: true, write: true}
    ]);

    await ctx.addInitScript(`
      window.__nostraTestRelays = ${relayConfig};
      // Disable Tor for LocalRelay-based tests. LocalRelay is a direct ws://
      // and Tor bootstrap can stall indefinitely in headless Chromium, leaving
      // initGlobalSubscription gated on a promise that never resolves. Without
      // this, the receiving peer's relay pool never comes up and receive-side
      // tests flake. Tor-specific tests (e2e-tor-*) do not use LocalRelay.
      try {
        localStorage.setItem('nostra-tor-mode', 'off');
        localStorage.removeItem('nostra-tor-enabled');
      } catch(e) {}
    `);
  }

  /** Wait for an event matching the filter to appear, polling strfry scan. */
  async waitForEvent(filter: {kinds?: number[]}, timeoutMs = 15000): Promise<any | null> {
    const filterJson = JSON.stringify(filter);
    const start = Date.now();
    while(Date.now() - start < timeoutMs) {
      try {
        // Use full path — strfry is at /app/strfry, not in PATH
        const out = exec(`docker exec ${CONTAINER_NAME} /app/strfry scan '${filterJson}' 2>/dev/null || true`);
        if(out) {
          // Filter to only JSON-looking lines (events) — strfry outputs INFO log lines too
          const lines = out.split('\n').filter((l) => l.trim().startsWith('{'));
          if(lines.length > 0) {
            try { return JSON.parse(lines[lines.length - 1]); } catch{ /* try next */ }
          }
        }
      } catch{ /* not ready */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  /** Check if the relay is reachable. */
  async isHealthy(): Promise<boolean> {
    try {
      const net = await import('net');
      await new Promise<void>((resolve, reject) => {
        const c = net.createConnection(HOST_PORT, 'localhost');
        c.on('connect', () => { c.end(); resolve(); });
        c.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 2000);
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch every event strfry has seen during the run. Uses the platform
   * WebSocket (Node 22+ built-in) + strfry's default indexed-query. Only
   * for fuzz regression checks — not for production code paths.
   */
  async getAllEvents(): Promise<Array<{kind: number; id: string; pubkey: string; created_at: number}>> {
    const sock: WebSocket = new (globalThis as any).WebSocket(this.url);
    const events: any[] = [];
    return new Promise((resolve, reject) => {
      const subId = 'fuzz-all-' + Math.random().toString(36).slice(2, 8);
      const timeout = setTimeout(() => {
        try{ sock.close(); } catch{}
        reject(new Error('LocalRelay.getAllEvents timeout'));
      }, 5000);
      sock.addEventListener('open', () => {
        // Empty filter matches all events up to strfry's query cap.
        sock.send(JSON.stringify(['REQ', subId, {}]));
      });
      sock.addEventListener('message', (evt: any) => {
        try {
          const msg = JSON.parse(String(evt.data));
          if(Array.isArray(msg) && msg[0] === 'EVENT' && msg[1] === subId) {
            events.push(msg[2]);
          } else if(Array.isArray(msg) && msg[0] === 'EOSE' && msg[1] === subId) {
            clearTimeout(timeout);
            try{ sock.close(); } catch{}
            resolve(events);
          }
        } catch{ /* ignore malformed */ }
      });
      sock.addEventListener('error', (err: any) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
}
