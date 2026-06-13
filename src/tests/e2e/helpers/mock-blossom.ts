/**
 * Mock Blossom server for E2E media tests.
 *
 * A tiny HTTP server that:
 *   - PUT /upload  → stores the body bytes under sha256(body), returns {url, sha256}
 *   - GET  /<sha>  → returns stored bytes
 *
 * Both browser contexts in an E2E test point at the same mock via the
 * window.__nostraTestBlossom override (read by blossom-upload-progress.ts).
 * Alice uploads the ciphertext; Bob downloads the same ciphertext when the
 * receiver-side decrypt hook resolves nostraFileMetadata.url.
 */

// @ts-nocheck
import http, {type Server} from 'http';
import crypto from 'crypto';
import type {BrowserContext} from 'playwright';

export class MockBlossom {
  private server: Server | null = null;
  private store = new Map<string, Buffer>();
  public port = 0;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost`);

      // CORS: Playwright's browser contexts are same-origin for localhost:8090
      // but the mock is on a different port, so XHR PUT requires preflight.
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'PUT, GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400'
      };

      if(req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }

      if(req.method === 'PUT' && url.pathname === '/upload') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks);
          const sha = crypto.createHash('sha256').update(body).digest('hex');
          this.store.set(sha, body);
          const base = `http://localhost:${this.port}`;
          res.writeHead(200, {...corsHeaders, 'Content-Type': 'application/json'});
          res.end(JSON.stringify({url: `${base}/${sha}`, sha256: sha}));
        });
        req.on('error', () => {
          res.writeHead(500);
          res.end();
        });
        return;
      }

      if(req.method === 'GET' && /^\/[0-9a-f]{64}$/.test(url.pathname)) {
        const sha = url.pathname.slice(1);
        const body = this.store.get(sha);
        if(!body) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          ...corsHeaders,
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length
        });
        res.end(body);
        return;
      }

      res.writeHead(404, corsHeaders);
      res.end();
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if(addr && typeof addr === 'object') {
          this.port = addr.port;
          resolve();
        } else {
          reject(new Error('mock blossom: no port'));
        }
      });
    });
  }

  /** URL base to inject via window.__nostraTestBlossom. */
  get url(): string {
    return `http://localhost:${this.port}`;
  }

  /** How many objects the server has stored. */
  size(): number {
    return this.store.size;
  }

  async stop(): Promise<void> {
    if(!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  async injectInto(ctx: BrowserContext): Promise<void> {
    const url = this.url;
    await ctx.addInitScript(`window.__nostraTestBlossom = ${JSON.stringify(url)};`);
  }
}
