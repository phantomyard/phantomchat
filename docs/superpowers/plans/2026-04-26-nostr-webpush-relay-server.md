# nostr-webpush-relay (server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a small, modular, open-source Nostr → Web Push relay (Node.js + TypeScript, AGPL-3.0) that the Nostra.chat client can register with for background push notifications. Deploy on the project owner's existing VPS, fronted by Cloudflare Tunnel for IP masking + DDoS protection.

**Architecture:** Single Node.js process. HTTP API for subscription registration (NIP-98 authenticated). Persistent WebSocket pool to user-supplied Nostr relays. On any kind 1059 event tagged `#p:[registered_pubkey]`, dispatch a Web Push (VAPID + aes128gcm) to the registered browser endpoint. SQLite for state.

**Tech Stack:** Node.js 20+, TypeScript 5.7, Fastify (HTTP framework), `better-sqlite3`, `web-push`, `nostr-tools`, `ws`, Vitest.

**Repo:** https://github.com/nostra-chat/nostr-webpush-relay (already created, AGPL-3.0)

**Spec:** `docs/superpowers/specs/2026-04-26-background-push-notifications-design.md` (revised)

**Local working dir:** `/home/raider/Repository/nostr-webpush-relay`

---

## Pre-flight constraints

- **Single-binary philosophy**: minimize external services. SQLite (single file) over Postgres. No Redis. No message queue.
- **AGPL-3.0**: every source file should carry an SPDX header.
- **No NIP-98 over HTTP for `GET /info`** — that endpoint is unauthenticated and returns the VAPID public key.
- **Field names locked here** are the contract the Nostra.chat client (in the parallel plan `2026-04-26-background-push-notifications.md`) consumes. Any change here cascades to the client; align both before commit.

## API contract (locks)

| Route | Method | Auth | Body | Response |
|---|---|---|---|---|
| `/info` | GET | none | — | `{vapid_public_key: string, version: string}` |
| `/subscription/:pubkey_hex` | PUT | NIP-98 | `{endpoint: string, keys: {p256dh: string, auth: string}, relays?: string[]}` | `{subscription_id: string}` (200) |
| `/subscription/:pubkey_hex` | DELETE | NIP-98 | — | 204 No Content |
| `/healthz` | GET | none | — | `{status: 'ok', uptime_s: number}` |

Discriminator field for the SW handler: payload key `nostra_event` (full serialized rumor envelope JSON, mirroring `notepush`'s `nostr_event` convention but renamed to avoid collision).

Web Push payload shape:
```json
{
  "app": "nostra-webpush-relay",
  "version": 1,
  "event_id": "<gift wrap event id, hex>",
  "recipient_pubkey": "<our pubkey, hex>",
  "nostra_event": "<JSON.stringify of the full kind 1059 event>"
}
```

The SW client uses `payload.app === 'nostra-webpush-relay'` (or `typeof payload.nostra_event === 'string'`) as the discriminator — this is more specific than just `'nostra'` and won't collide with hypothetical future Nostra-shape pushes from a different actor.

## File structure (server repo)

```
nostr-webpush-relay/
├── package.json
├── tsconfig.json
├── eslint.config.js
├── vitest.config.ts
├── README.md
├── LICENSE  (AGPL-3.0, already present)
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── systemd/nostr-webpush-relay.service
├── docs/
│   ├── DEPLOY.md       (Cloudflare Tunnel + systemd + docker)
│   └── PROTOCOL.md     (HTTP API + push payload reference)
├── src/
│   ├── index.ts        (entrypoint: load env, init storage, start http + relay subscriber)
│   ├── config.ts       (env parsing, defaults)
│   ├── storage.ts      (SQLite wrapper, subscriptions CRUD)
│   ├── nip98.ts        (auth middleware: parse + verify Authorization: Nostr header)
│   ├── http.ts         (Fastify routes: PUT/DELETE /subscription, GET /info, /healthz)
│   ├── relay-pool.ts   (WS pool, persistent reconnect, filter, event dispatch)
│   ├── push-sender.ts  (VAPID signing, aes128gcm encryption, HTTP POST, retry)
│   ├── pubkey.ts       (hex/npub helpers)
│   └── log.ts          (minimal pino logger)
└── tests/
    ├── storage.test.ts
    ├── nip98.test.ts
    ├── http.test.ts
    ├── relay-pool.test.ts
    ├── push-sender.test.ts
    └── integration.test.ts
```

---

## Task S1: Scaffold the repo

**Files:**
- All files in `/home/raider/Repository/nostr-webpush-relay/` listed above (skeleton — implementations come later).

- [ ] **Step 1: Initialize Node.js project**

```bash
cd /home/raider/Repository/nostr-webpush-relay
git pull --ff-only
pnpm init
```

Edit `package.json`:
```json
{
  "name": "nostr-webpush-relay",
  "version": "0.1.0",
  "description": "Web Push relay for Nostr browser clients (NIP-17 → VAPID).",
  "license": "AGPL-3.0-or-later",
  "type": "module",
  "engines": {"node": ">=20"},
  "main": "dist/index.js",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint 'src/**/*.ts' 'tests/**/*.ts'"
  },
  "dependencies": {
    "fastify": "^5.0.0",
    "better-sqlite3": "^11.0.0",
    "web-push": "^3.6.0",
    "nostr-tools": "^2.7.0",
    "ws": "^8.18.0",
    "pino": "^9.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.0.0",
    "vitest": "^2.0.0",
    "eslint": "^9.0.0",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.0"
  }
}
```

- [ ] **Step 2: Add `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "noImplicitAny": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "declaration": false,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Add `eslint.config.js` (flat, minimal)**

```javascript
import js from '@eslint/js';
export default [
  js.configs.recommended,
  {
    languageOptions: {ecmaVersion: 2022, sourceType: 'module'},
    rules: {
      'no-unused-vars': ['error', {argsIgnorePattern: '^_'}],
      'eqeqeq': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-trailing-spaces': 'error'
    }
  }
];
```

`pnpm add -D @eslint/js`

- [ ] **Step 4: Add `vitest.config.ts`**

```typescript
import {defineConfig} from 'vitest/config';
export default defineConfig({test: {environment: 'node', testTimeout: 10000}});
```

- [ ] **Step 5: Create `src/log.ts` with AGPL header (template for all source files)**

```typescript
// SPDX-License-Identifier: AGPL-3.0-or-later
// nostr-webpush-relay © 2026 Nostra.chat contributors
import pino from 'pino';
export const log = pino({level: process.env.LOG_LEVEL || 'info'});
```

- [ ] **Step 6: Create stub `src/index.ts`**

```typescript
// SPDX-License-Identifier: AGPL-3.0-or-later
import {log} from './log.js';
log.info('nostr-webpush-relay starting');
process.on('SIGINT', () => { log.info('shutdown'); process.exit(0); });
```

- [ ] **Step 7: Install + smoke run**

```bash
pnpm install
pnpm dev
# Expected log: {"level":30,"time":...,"msg":"nostr-webpush-relay starting"}
# Ctrl+C
```

- [ ] **Step 8: README skeleton**

Replace the auto-generated README with:

```markdown
# nostr-webpush-relay

Web Push (RFC 8030) relay for Nostr browser/PWA clients. Subscribes to NIP-17 gift-wraps on Nostr relays and dispatches Web Push notifications to registered browsers.

> **Status: pre-alpha, in active development.**

## What it does

1. Browsers register a `(pubkey, push_endpoint, p256dh, auth, relays)` tuple via `PUT /subscription/:pubkey` (NIP-98 authenticated).
2. The relay maintains persistent WebSocket connections to each user's preferred Nostr relays, subscribed to `{kinds:[1059], '#p':[<that user's pubkey>]}`.
3. When an event matches, the relay sends a VAPID-signed Web Push to the registered browser endpoint.
4. The browser Service Worker decrypts the gift-wrap locally (private key never leaves the device) and shows a notification.

## License

AGPL-3.0-or-later. If you run a public instance, you must also publish your modifications.

## Status

- [ ] S1 — Scaffold (this commit)
- [ ] S2 — SQLite storage
- [ ] S3 — NIP-98 auth
- [ ] S4 — HTTP API
- [ ] S5 — Relay subscriber
- [ ] S6 — Push sender
- [ ] S7 — Integration test
- [ ] S8 — Deploy artifacts

## Quickstart (full instructions arrive in S8)

```bash
git clone https://github.com/nostra-chat/nostr-webpush-relay
cd nostr-webpush-relay
pnpm install
cp .env.example .env  # set VAPID keys, see docs/DEPLOY.md
pnpm dev
```

## Documentation

- Protocol: `docs/PROTOCOL.md`
- Deploy: `docs/DEPLOY.md`

## Acknowledgements

API surface inspired by `damus-io/notepush` (APNS-only). NIP-98 auth standard from nostr-protocol/nips#98.
```

- [ ] **Step 9: Commit**

```bash
git add .
git commit -m "feat: initial scaffold (Node.js, TS, Fastify, SQLite, web-push)"
git push origin main
```

**Definition of done:** `pnpm dev` runs, prints the start log, exits clean. Repo has initial scaffold pushed.

---

## Task S2: SQLite storage layer

**Files:**
- Create: `src/storage.ts`
- Create: `src/config.ts` (used here for `DB_PATH`)
- Create: `tests/storage.test.ts`

- [ ] **Step 1: Write `src/config.ts`**

```typescript
// SPDX-License-Identifier: AGPL-3.0-or-later
export const config = {
  port: Number(process.env.PORT || 8787),
  dbPath: process.env.DB_PATH || './data/relay.db',
  vapidPublic: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivate: process.env.VAPID_PRIVATE_KEY || '',
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@nostra.chat',
  defaultRelays: (process.env.DEFAULT_RELAYS || 'wss://relay.damus.io,wss://nos.lol').split(',').filter(Boolean),
  maxRelaysPerSub: Number(process.env.MAX_RELAYS_PER_SUB || 5),
  nip98ClockSkewSec: Number(process.env.NIP98_CLOCK_SKEW_SEC || 60)
};
```

- [ ] **Step 2: Write `src/storage.ts`**

```typescript
// SPDX-License-Identifier: AGPL-3.0-or-later
import Database from 'better-sqlite3';
import {randomBytes} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {config} from './config.js';

export interface Subscription {
  id: string;
  pubkey: string;          // hex, 64 chars
  endpoint: string;        // browser push endpoint URL
  p256dh: string;          // base64
  auth: string;            // base64
  relays: string[];        // wss:// URLs
  created_at: number;      // unix seconds
  last_seen: number;       // unix seconds, updated on PUT
}

export class Storage {
  private db: Database.Database;

  constructor(path = config.dbPath) {
    mkdirSync(dirname(path), {recursive: true});
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        pubkey TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        relays TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        UNIQUE(pubkey, endpoint)
      );
      CREATE INDEX IF NOT EXISTS idx_subs_pubkey ON subscriptions(pubkey);
    `);
  }

  upsert(rec: Omit<Subscription, 'id' | 'created_at' | 'last_seen'>): Subscription {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.db.prepare('SELECT * FROM subscriptions WHERE pubkey = ? AND endpoint = ?')
      .get(rec.pubkey, rec.endpoint) as any;
    if(existing) {
      this.db.prepare('UPDATE subscriptions SET p256dh=?, auth=?, relays=?, last_seen=? WHERE id=?')
        .run(rec.p256dh, rec.auth, JSON.stringify(rec.relays), now, existing.id);
      return {...existing, ...rec, last_seen: now};
    }
    const id = 'sub_' + randomBytes(12).toString('hex');
    this.db.prepare(`INSERT INTO subscriptions
      (id, pubkey, endpoint, p256dh, auth, relays, created_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, rec.pubkey, rec.endpoint, rec.p256dh, rec.auth, JSON.stringify(rec.relays), now, now);
    return {id, ...rec, created_at: now, last_seen: now};
  }

  getByPubkey(pubkey: string): Subscription[] {
    const rows = this.db.prepare('SELECT * FROM subscriptions WHERE pubkey = ?').all(pubkey) as any[];
    return rows.map(this.rowToSub);
  }

  delete(pubkey: string, endpoint?: string): number {
    if(endpoint) {
      const r = this.db.prepare('DELETE FROM subscriptions WHERE pubkey = ? AND endpoint = ?').run(pubkey, endpoint);
      return r.changes;
    }
    const r = this.db.prepare('DELETE FROM subscriptions WHERE pubkey = ?').run(pubkey);
    return r.changes;
  }

  deleteByEndpoint(endpoint: string): number {
    const r = this.db.prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(endpoint);
    return r.changes;
  }

  allDistinctPubkeys(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT pubkey FROM subscriptions').all() as {pubkey: string}[];
    return rows.map((r) => r.pubkey);
  }

  allDistinctRelays(): string[] {
    const rows = this.db.prepare('SELECT relays FROM subscriptions').all() as {relays: string}[];
    const set = new Set<string>();
    for(const r of rows) {
      try { for(const url of JSON.parse(r.relays)) set.add(url); } catch{}
    }
    return [...set];
  }

  close(): void { this.db.close(); }

  private rowToSub = (row: any): Subscription => ({
    id: row.id, pubkey: row.pubkey, endpoint: row.endpoint,
    p256dh: row.p256dh, auth: row.auth,
    relays: JSON.parse(row.relays),
    created_at: row.created_at, last_seen: row.last_seen
  });
}
```

- [ ] **Step 3: Write `tests/storage.test.ts`**

```typescript
import {describe, it, expect, beforeEach} from 'vitest';
import {Storage} from '../src/storage.js';

const SAMPLE = {
  pubkey: 'a'.repeat(64),
  endpoint: 'https://fcm.googleapis.com/wp/abc',
  p256dh: 'pX',
  auth: 'aY',
  relays: ['wss://relay.damus.io', 'wss://nos.lol']
};

describe('Storage', () => {
  let s: Storage;
  beforeEach(() => { s = new Storage(':memory:'); });

  it('upsert inserts a new subscription', () => {
    const rec = s.upsert(SAMPLE);
    expect(rec.id).toMatch(/^sub_[0-9a-f]{24}$/);
    expect(rec.pubkey).toBe(SAMPLE.pubkey);
    expect(rec.relays).toEqual(SAMPLE.relays);
  });

  it('upsert replaces same (pubkey, endpoint) with new keys', () => {
    const a = s.upsert(SAMPLE);
    const b = s.upsert({...SAMPLE, p256dh: 'newP', auth: 'newA'});
    expect(b.id).toBe(a.id); // same row
    const list = s.getByPubkey(SAMPLE.pubkey);
    expect(list).toHaveLength(1);
    expect(list[0].p256dh).toBe('newP');
  });

  it('upsert allows multiple endpoints per pubkey', () => {
    s.upsert(SAMPLE);
    s.upsert({...SAMPLE, endpoint: 'https://other.invalid'});
    const list = s.getByPubkey(SAMPLE.pubkey);
    expect(list).toHaveLength(2);
  });

  it('delete by (pubkey, endpoint) removes 1 row', () => {
    s.upsert(SAMPLE);
    s.upsert({...SAMPLE, endpoint: 'https://other.invalid'});
    expect(s.delete(SAMPLE.pubkey, SAMPLE.endpoint)).toBe(1);
    expect(s.getByPubkey(SAMPLE.pubkey)).toHaveLength(1);
  });

  it('delete by pubkey removes all rows for that pubkey', () => {
    s.upsert(SAMPLE);
    s.upsert({...SAMPLE, endpoint: 'https://other.invalid'});
    expect(s.delete(SAMPLE.pubkey)).toBe(2);
    expect(s.getByPubkey(SAMPLE.pubkey)).toHaveLength(0);
  });

  it('deleteByEndpoint cleans up 410-Gone endpoints across pubkeys', () => {
    s.upsert(SAMPLE);
    s.upsert({...SAMPLE, pubkey: 'b'.repeat(64)});
    expect(s.deleteByEndpoint(SAMPLE.endpoint)).toBe(2);
  });

  it('allDistinctPubkeys returns each pubkey once', () => {
    s.upsert(SAMPLE);
    s.upsert({...SAMPLE, endpoint: 'https://other.invalid'});
    s.upsert({...SAMPLE, pubkey: 'b'.repeat(64)});
    expect(s.allDistinctPubkeys().sort()).toEqual([SAMPLE.pubkey, 'b'.repeat(64)].sort());
  });

  it('allDistinctRelays merges across rows', () => {
    s.upsert(SAMPLE);
    s.upsert({...SAMPLE, pubkey: 'b'.repeat(64), relays: ['wss://nos.lol', 'wss://relay.snort.social']});
    expect(s.allDistinctRelays().sort()).toEqual(['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.snort.social']);
  });
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm test
```
Expected: 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage.ts src/config.ts tests/storage.test.ts package.json pnpm-lock.yaml
git commit -m "feat(storage): SQLite subscriptions table + CRUD"
git push
```

**Definition of done:** Storage CRUD covered by 8 tests, all green.

---

## Task S3: NIP-98 authentication middleware

**Files:**
- Create: `src/nip98.ts`
- Create: `tests/nip98.test.ts`

NIP-98 reference: https://github.com/nostr-protocol/nips/blob/master/98.md.

The header format:
```
Authorization: Nostr <base64(JSON-of-kind-27235-event)>
```
Verification rules:
1. Decode base64 → parse JSON.
2. Event must be `kind === 27235`, valid Schnorr signature.
3. Tags must include `["url", <full request URL>]` and `["method", <uppercase HTTP method>]`.
4. `created_at` within ±60s of now.
5. The `:pubkey` URL param must equal `event.pubkey` (caller proves ownership).

- [ ] **Step 1: Write `src/nip98.ts`**

```typescript
// SPDX-License-Identifier: AGPL-3.0-or-later
import {verifyEvent, type Event} from 'nostr-tools';
import {config} from './config.js';
import {log} from './log.js';

export interface Nip98Result {
  ok: boolean;
  pubkey?: string;
  reason?: string;
}

/**
 * Verify a NIP-98 Authorization header against (method, url) tuple.
 * Caller must additionally check that `result.pubkey === route.pubkey`.
 */
export function verifyNip98(authHeader: string | undefined, method: string, url: string): Nip98Result {
  if(!authHeader) return {ok: false, reason: 'missing Authorization header'};
  if(!authHeader.startsWith('Nostr ')) return {ok: false, reason: 'scheme must be Nostr'};
  let evt: Event;
  try {
    const b64 = authHeader.slice('Nostr '.length).trim();
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    evt = JSON.parse(json);
  } catch(e) {
    return {ok: false, reason: 'cannot parse base64/JSON'};
  }
  if(evt.kind !== 27235) return {ok: false, reason: `kind must be 27235, got ${evt.kind}`};
  const now = Math.floor(Date.now() / 1000);
  if(Math.abs(now - evt.created_at) > config.nip98ClockSkewSec) {
    return {ok: false, reason: `created_at out of window (skew=${now - evt.created_at}s)`};
  }
  const tagUrl = evt.tags.find((t) => t[0] === 'url')?.[1];
  const tagMethod = evt.tags.find((t) => t[0] === 'method')?.[1];
  if(tagUrl !== url) return {ok: false, reason: `url tag mismatch (got "${tagUrl}", want "${url}")`};
  if((tagMethod || '').toUpperCase() !== method.toUpperCase()) {
    return {ok: false, reason: `method tag mismatch (got "${tagMethod}", want "${method}")`};
  }
  if(!verifyEvent(evt)) return {ok: false, reason: 'invalid signature'};
  return {ok: true, pubkey: evt.pubkey};
}

/** Build the full URL for verification. Considers reverse proxy headers. */
export function reqFullUrl(scheme: string, host: string, originalUrl: string): string {
  return `${scheme}://${host}${originalUrl}`;
}
```

- [ ] **Step 2: Write `tests/nip98.test.ts`**

```typescript
import {describe, it, expect} from 'vitest';
import {generateSecretKey, getPublicKey, finalizeEvent, type EventTemplate} from 'nostr-tools';
import {verifyNip98} from '../src/nip98.js';

function buildAuthHeader(opts: {sk: Uint8Array; method: string; url: string; createdAt?: number}): string {
  const tmpl: EventTemplate = {
    kind: 27235,
    created_at: opts.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [['url', opts.url], ['method', opts.method.toUpperCase()]],
    content: ''
  };
  const evt = finalizeEvent(tmpl, opts.sk);
  return 'Nostr ' + Buffer.from(JSON.stringify(evt)).toString('base64');
}

describe('NIP-98 verifyNip98', () => {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const url = 'https://push.nostra.chat/subscription/' + pk;

  it('accepts a valid header', () => {
    const h = buildAuthHeader({sk, method: 'PUT', url});
    const r = verifyNip98(h, 'PUT', url);
    expect(r.ok).toBe(true);
    expect(r.pubkey).toBe(pk);
  });

  it('rejects missing header', () => {
    expect(verifyNip98(undefined, 'PUT', url).ok).toBe(false);
  });

  it('rejects wrong scheme', () => {
    expect(verifyNip98('Bearer x', 'PUT', url).ok).toBe(false);
  });

  it('rejects bad base64', () => {
    expect(verifyNip98('Nostr !!!@@@', 'PUT', url).ok).toBe(false);
  });

  it('rejects wrong kind', () => {
    const tmpl: EventTemplate = {kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: ''};
    const evt = finalizeEvent(tmpl, sk);
    const h = 'Nostr ' + Buffer.from(JSON.stringify(evt)).toString('base64');
    expect(verifyNip98(h, 'PUT', url).reason).toMatch(/kind/);
  });

  it('rejects mismatched url tag', () => {
    const h = buildAuthHeader({sk, method: 'PUT', url: 'https://other.invalid'});
    expect(verifyNip98(h, 'PUT', url).reason).toMatch(/url/);
  });

  it('rejects mismatched method tag', () => {
    const h = buildAuthHeader({sk, method: 'GET', url});
    expect(verifyNip98(h, 'PUT', url).reason).toMatch(/method/);
  });

  it('rejects expired created_at', () => {
    const h = buildAuthHeader({sk, method: 'PUT', url, createdAt: Math.floor(Date.now() / 1000) - 3600});
    expect(verifyNip98(h, 'PUT', url).reason).toMatch(/created_at/);
  });

  it('rejects forged signature', () => {
    const tmpl: EventTemplate = {kind: 27235, created_at: Math.floor(Date.now() / 1000),
      tags: [['url', url], ['method', 'PUT']], content: ''};
    const evt = finalizeEvent(tmpl, sk);
    evt.sig = '0'.repeat(128); // tamper
    const h = 'Nostr ' + Buffer.from(JSON.stringify(evt)).toString('base64');
    expect(verifyNip98(h, 'PUT', url).reason).toMatch(/signature/);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm test tests/nip98.test.ts
```
Expected: 9 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/nip98.ts tests/nip98.test.ts
git commit -m "feat(auth): NIP-98 HTTP auth middleware with golden vectors"
git push
```

**Definition of done:** 9 NIP-98 tests green; correctly rejects all known-bad cases.

---

## Task S4: HTTP API

**Files:**
- Create: `src/http.ts`
- Create: `tests/http.test.ts`

- [ ] **Step 1: Write `src/http.ts`**

```typescript
// SPDX-License-Identifier: AGPL-3.0-or-later
import Fastify, {type FastifyInstance, type FastifyRequest, type FastifyReply} from 'fastify';
import {config} from './config.js';
import {Storage, type Subscription} from './storage.js';
import {verifyNip98, reqFullUrl} from './nip98.js';
import {log} from './log.js';

const PUBKEY_RE = /^[0-9a-f]{64}$/;
const VERSION = '0.1.0';

const startTime = Date.now();

export interface BuildAppDeps {storage: Storage; vapidPublic: string;}

export function buildApp(deps: BuildAppDeps): FastifyInstance {
  const app = Fastify({logger: false, trustProxy: true});

  app.get('/healthz', async() => ({status: 'ok', uptime_s: Math.floor((Date.now() - startTime) / 1000)}));

  app.get('/info', async() => ({vapid_public_key: deps.vapidPublic, version: VERSION}));

  app.put<{Params: {pubkey: string}; Body: {endpoint: string; keys: {p256dh: string; auth: string}; relays?: string[]}}>(
    '/subscription/:pubkey',
    async(req, reply) => {
      const pubkey = req.params.pubkey.toLowerCase();
      if(!PUBKEY_RE.test(pubkey)) return reply.code(400).send({error: 'invalid pubkey'});

      const url = reqFullUrl(req.protocol, req.hostname, req.url);
      const auth = verifyNip98(req.headers.authorization, req.method, url);
      if(!auth.ok) return reply.code(401).send({error: 'unauthorized', reason: auth.reason});
      if(auth.pubkey !== pubkey) return reply.code(403).send({error: 'pubkey mismatch'});

      const body = req.body;
      if(!body?.endpoint || !body?.keys?.p256dh || !body?.keys?.auth) {
        return reply.code(400).send({error: 'body must include endpoint and keys.{p256dh,auth}'});
      }
      const relays = (body.relays && body.relays.length > 0 ? body.relays : config.defaultRelays)
        .filter((r) => r.startsWith('wss://') || r.startsWith('ws://'))
        .slice(0, config.maxRelaysPerSub);
      const sub = deps.storage.upsert({pubkey, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth, relays});
      return reply.code(200).send({subscription_id: sub.id});
    }
  );

  app.delete<{Params: {pubkey: string}; Querystring: {endpoint?: string}}>(
    '/subscription/:pubkey',
    async(req, reply) => {
      const pubkey = req.params.pubkey.toLowerCase();
      if(!PUBKEY_RE.test(pubkey)) return reply.code(400).send({error: 'invalid pubkey'});
      const url = reqFullUrl(req.protocol, req.hostname, req.url);
      const auth = verifyNip98(req.headers.authorization, req.method, url);
      if(!auth.ok) return reply.code(401).send({error: 'unauthorized', reason: auth.reason});
      if(auth.pubkey !== pubkey) return reply.code(403).send({error: 'pubkey mismatch'});
      const removed = deps.storage.delete(pubkey, req.query.endpoint);
      log.info({pubkey, removed}, 'subscription deleted');
      return reply.code(204).send();
    }
  );

  return app;
}
```

- [ ] **Step 2: Write `tests/http.test.ts`**

```typescript
import {describe, it, expect, beforeEach} from 'vitest';
import {generateSecretKey, getPublicKey, finalizeEvent} from 'nostr-tools';
import {buildApp} from '../src/http.js';
import {Storage} from '../src/storage.js';

function nip98(opts: {sk: Uint8Array; method: string; url: string}): string {
  const evt = finalizeEvent({
    kind: 27235, created_at: Math.floor(Date.now() / 1000),
    tags: [['url', opts.url], ['method', opts.method.toUpperCase()]], content: ''
  }, opts.sk);
  return 'Nostr ' + Buffer.from(JSON.stringify(evt)).toString('base64');
}

describe('HTTP API', () => {
  let storage: Storage;
  let app: ReturnType<typeof buildApp>;
  beforeEach(() => {
    storage = new Storage(':memory:');
    app = buildApp({storage, vapidPublic: 'PUB_KEY_XX'});
  });

  it('GET /healthz returns ok', async() => {
    const r = await app.inject({method: 'GET', url: '/healthz'});
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload).status).toBe('ok');
  });

  it('GET /info returns vapid_public_key', async() => {
    const r = await app.inject({method: 'GET', url: '/info'});
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload).vapid_public_key).toBe('PUB_KEY_XX');
  });

  it('PUT /subscription/:pubkey rejects bad pubkey', async() => {
    const r = await app.inject({method: 'PUT', url: '/subscription/notahex', payload: {}});
    expect(r.statusCode).toBe(400);
  });

  it('PUT /subscription/:pubkey rejects missing auth', async() => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const r = await app.inject({method: 'PUT', url: `/subscription/${pk}`, payload: {endpoint: 'x', keys: {p256dh: 'a', auth: 'b'}}});
    expect(r.statusCode).toBe(401);
  });

  it('PUT /subscription/:pubkey accepts valid auth + body', async() => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const url = `http://localhost:80/subscription/${pk}`;
    const r = await app.inject({
      method: 'PUT',
      url: `/subscription/${pk}`,
      headers: {host: 'localhost', authorization: nip98({sk, method: 'PUT', url})},
      payload: {endpoint: 'https://fcm.googleapis.com/wp/abc', keys: {p256dh: 'pX', auth: 'aY'}}
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload).subscription_id).toMatch(/^sub_/);
  });

  it('PUT /subscription/:pubkey rejects pubkey mismatch', async() => {
    const sk1 = generateSecretKey();
    const sk2 = generateSecretKey();
    const pk2 = getPublicKey(sk2);
    const url = `http://localhost:80/subscription/${pk2}`;
    const r = await app.inject({
      method: 'PUT',
      url: `/subscription/${pk2}`,
      headers: {host: 'localhost', authorization: nip98({sk: sk1, method: 'PUT', url})},
      payload: {endpoint: 'x', keys: {p256dh: 'a', auth: 'b'}}
    });
    expect(r.statusCode).toBe(403);
  });

  it('DELETE /subscription/:pubkey removes the row', async() => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const putUrl = `http://localhost:80/subscription/${pk}`;
    await app.inject({
      method: 'PUT',
      url: `/subscription/${pk}`,
      headers: {host: 'localhost', authorization: nip98({sk, method: 'PUT', url: putUrl})},
      payload: {endpoint: 'x', keys: {p256dh: 'a', auth: 'b'}}
    });
    const delUrl = `http://localhost:80/subscription/${pk}`;
    const r = await app.inject({
      method: 'DELETE',
      url: `/subscription/${pk}`,
      headers: {host: 'localhost', authorization: nip98({sk, method: 'DELETE', url: delUrl})}
    });
    expect(r.statusCode).toBe(204);
    expect(storage.getByPubkey(pk)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm test tests/http.test.ts
```
Expected: 7 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/http.ts tests/http.test.ts
git commit -m "feat(http): API routes with NIP-98 auth + body validation"
git push
```

**Definition of done:** 7 HTTP route tests green covering happy + auth-failure paths.

---

## Task S5: Nostr relay subscriber

**Files:**
- Create: `src/relay-pool.ts`
- Create: `tests/relay-pool.test.ts`

- [ ] **Step 1: Write `src/relay-pool.ts`**

```typescript
// SPDX-License-Identifier: AGPL-3.0-or-later
import WebSocket from 'ws';
import {log} from './log.js';

export interface RelayEvent {
  id: string;
  pubkey: string;        // event.pubkey (ephemeral wrapper for kind 1059)
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

type EventHandler = (event: RelayEvent, recipientPubkeys: string[]) => void;

interface RelayState {
  url: string;
  ws?: WebSocket;
  desiredPubkeys: Set<string>;
  reconnectAttempts: number;
  closed: boolean;
}

export class RelayPool {
  private relays = new Map<string, RelayState>();
  private dedup = new Map<string, number>(); // event id → timestamp ms
  private dedupMaxMs = 24 * 60 * 60 * 1000;

  constructor(private onEvent: EventHandler) {}

  /**
   * Update the pool to monitor `pubkeys` on `relays`. Idempotent —
   * connects new relays, drops removed ones, refreshes filters when
   * pubkey set changes.
   */
  reconcile(plan: Map<string /*relay url*/, Set<string /*pubkey*/>>): void {
    // Add or update
    for(const [url, pubkeys] of plan) {
      let r = this.relays.get(url);
      if(!r) {
        r = {url, desiredPubkeys: new Set(pubkeys), reconnectAttempts: 0, closed: false};
        this.relays.set(url, r);
        this.connect(r);
      } else {
        const same = r.desiredPubkeys.size === pubkeys.size && [...r.desiredPubkeys].every((p) => pubkeys.has(p));
        r.desiredPubkeys = new Set(pubkeys);
        if(!same && r.ws?.readyState === WebSocket.OPEN) this.sendReq(r);
      }
    }
    // Remove
    for(const [url, r] of this.relays) {
      if(!plan.has(url)) {
        r.closed = true;
        try { r.ws?.close(); } catch{}
        this.relays.delete(url);
      }
    }
  }

  shutdown(): void {
    for(const r of this.relays.values()) {
      r.closed = true;
      try { r.ws?.close(); } catch{}
    }
    this.relays.clear();
  }

  private connect(r: RelayState): void {
    if(r.closed) return;
    log.info({url: r.url}, 'relay connect');
    const ws = new WebSocket(r.url);
    r.ws = ws;
    ws.on('open', () => {
      r.reconnectAttempts = 0;
      log.info({url: r.url}, 'relay open');
      this.sendReq(r);
    });
    ws.on('message', (data) => this.onMessage(r, data.toString()));
    ws.on('close', () => this.scheduleReconnect(r));
    ws.on('error', (err) => log.warn({url: r.url, err: err.message}, 'relay error'));
  }

  private sendReq(r: RelayState): void {
    if(r.ws?.readyState !== WebSocket.OPEN) return;
    if(r.desiredPubkeys.size === 0) return;
    const subId = 'webpush-' + Math.floor(Math.random() * 1e9).toString(36);
    const filter = {kinds: [1059], '#p': [...r.desiredPubkeys]};
    r.ws.send(JSON.stringify(['REQ', subId, filter]));
  }

  private onMessage(r: RelayState, raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if(!Array.isArray(msg) || msg[0] !== 'EVENT') return;
    const evt = msg[2] as RelayEvent;
    if(!evt || evt.kind !== 1059) return;
    if(this.dedup.has(evt.id)) return;
    this.gcDedup();
    this.dedup.set(evt.id, Date.now());

    const pTags = evt.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
    const recipients = pTags.filter((p) => r.desiredPubkeys.has(p));
    if(recipients.length === 0) return; // not for us
    try { this.onEvent(evt, recipients); } catch(e) { log.warn({err: (e as Error).message}, 'onEvent threw'); }
  }

  private gcDedup(): void {
    const cutoff = Date.now() - this.dedupMaxMs;
    if(this.dedup.size < 10000) return;
    for(const [id, ts] of this.dedup) if(ts < cutoff) this.dedup.delete(id);
  }

  private scheduleReconnect(r: RelayState): void {
    if(r.closed) return;
    r.reconnectAttempts += 1;
    const delayMs = Math.min(30000, 1000 * Math.pow(2, Math.min(r.reconnectAttempts, 5)));
    log.info({url: r.url, delayMs}, 'relay reconnect scheduled');
    setTimeout(() => { if(!r.closed) this.connect(r); }, delayMs);
  }
}
```

- [ ] **Step 2: Write `tests/relay-pool.test.ts`** — exercises reconcile/dedup logic with a mock WS server.

```typescript
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {WebSocketServer} from 'ws';
import {RelayPool, type RelayEvent} from '../src/relay-pool.js';

function startMockRelay(port: number): {wss: WebSocketServer; sentReqs: any[]} {
  const wss = new WebSocketServer({port});
  const sentReqs: any[] = [];
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if(msg[0] === 'REQ') sentReqs.push(msg);
      } catch{}
    });
    (ws as any).publish = (evt: RelayEvent) => ws.send(JSON.stringify(['EVENT', sentReqs.at(-1)?.[1] || 'sub', evt]));
  });
  return {wss, sentReqs};
}

const TEST_PUBKEY = 'a'.repeat(64);

describe('RelayPool', () => {
  let pool: RelayPool;
  let received: {evt: RelayEvent; recipients: string[]}[] = [];
  let mock: {wss: WebSocketServer; sentReqs: any[]};

  beforeEach(() => {
    received = [];
    pool = new RelayPool((evt, recipients) => received.push({evt, recipients}));
    mock = startMockRelay(28787);
  });
  afterEach(async() => {
    pool.shutdown();
    await new Promise<void>((resolve) => mock.wss.close(() => resolve()));
  });

  it('connects, sends REQ, and dispatches matching events', async() => {
    const url = 'ws://localhost:28787';
    pool.reconcile(new Map([[url, new Set([TEST_PUBKEY])]]));
    // Wait for connection + REQ
    await new Promise((r) => setTimeout(r, 250));
    expect(mock.sentReqs.length).toBe(1);
    expect(mock.sentReqs[0][2]).toEqual({kinds: [1059], '#p': [TEST_PUBKEY]});

    // Publish a matching event from the server
    const evt: RelayEvent = {
      id: 'evt1', pubkey: 'b'.repeat(64), created_at: 1, kind: 1059,
      tags: [['p', TEST_PUBKEY]], content: 'enc', sig: 'sig'
    };
    for(const c of mock.wss.clients) (c as any).publish(evt);
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(1);
    expect(received[0].recipients).toEqual([TEST_PUBKEY]);
  });

  it('dedups identical event ids', async() => {
    pool.reconcile(new Map([['ws://localhost:28787', new Set([TEST_PUBKEY])]]));
    await new Promise((r) => setTimeout(r, 250));
    const evt: RelayEvent = {id: 'dup', pubkey: 'b'.repeat(64), created_at: 1, kind: 1059, tags: [['p', TEST_PUBKEY]], content: '', sig: ''};
    for(const c of mock.wss.clients) (c as any).publish(evt);
    for(const c of mock.wss.clients) (c as any).publish(evt);
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(1);
  });

  it('ignores events with no matching #p tag', async() => {
    pool.reconcile(new Map([['ws://localhost:28787', new Set([TEST_PUBKEY])]]));
    await new Promise((r) => setTimeout(r, 250));
    const evt: RelayEvent = {id: 'nomatch', pubkey: 'b'.repeat(64), created_at: 1, kind: 1059, tags: [['p', 'c'.repeat(64)]], content: '', sig: ''};
    for(const c of mock.wss.clients) (c as any).publish(evt);
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run**

```bash
pnpm test tests/relay-pool.test.ts
```
Expected: 3 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/relay-pool.ts tests/relay-pool.test.ts
git commit -m "feat(relay): WS pool with reconcile, dedup, exp backoff"
git push
```

**Definition of done:** 3 relay-pool tests green; reconcile is idempotent; dedup works.

---

## Task S6: Web Push sender

**Files:**
- Create: `src/push-sender.ts`
- Create: `tests/push-sender.test.ts`

- [ ] **Step 1: Write `src/push-sender.ts`**

```typescript
// SPDX-License-Identifier: AGPL-3.0-or-later
import webpush from 'web-push';
import {config} from './config.js';
import type {Storage, Subscription} from './storage.js';
import {log} from './log.js';

export interface PushPayload {
  app: 'nostra-webpush-relay';
  version: 1;
  event_id: string;
  recipient_pubkey: string;
  nostra_event: string; // JSON.stringify of full kind 1059 event
}

webpush.setVapidDetails(config.vapidSubject, config.vapidPublic, config.vapidPrivate);

export interface PushResult {ok: boolean; status?: number; gone?: boolean; reason?: string;}

export async function sendPush(sub: Subscription, payload: PushPayload, opts: {ttlSec?: number} = {}): Promise<PushResult> {
  try {
    const res = await webpush.sendNotification(
      {endpoint: sub.endpoint, keys: {p256dh: sub.p256dh, auth: sub.auth}},
      JSON.stringify(payload),
      {TTL: opts.ttlSec ?? 60, contentEncoding: 'aes128gcm'}
    );
    return {ok: true, status: res.statusCode};
  } catch(e: any) {
    const status = e.statusCode || e.status || 0;
    const gone = status === 404 || status === 410;
    log.warn({status, endpoint: sub.endpoint, msg: e.body || e.message}, 'sendPush failed');
    return {ok: false, status, gone, reason: e.body || e.message};
  }
}

/** Fan-out a single event to all of a pubkey's registered subscriptions, GC 410-Gone endpoints. */
export async function fanout(storage: Storage, pubkeyHex: string, evt: any): Promise<{sent: number; pruned: number}> {
  const subs = storage.getByPubkey(pubkeyHex);
  let sent = 0;
  let pruned = 0;
  for(const sub of subs) {
    const payload: PushPayload = {
      app: 'nostra-webpush-relay', version: 1,
      event_id: evt.id, recipient_pubkey: pubkeyHex,
      nostra_event: JSON.stringify(evt)
    };
    const r = await sendPush(sub, payload);
    if(r.ok) { sent++; continue; }
    if(r.gone) { storage.delete(sub.pubkey, sub.endpoint); pruned++; }
  }
  return {sent, pruned};
}
```

- [ ] **Step 2: Write `tests/push-sender.test.ts`**

```typescript
import {describe, it, expect, beforeEach, vi} from 'vitest';
import {Storage} from '../src/storage.js';
// We mock 'web-push' so the test does not actually send.
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn()
  }
}));
import webpush from 'web-push';
import {fanout, sendPush} from '../src/push-sender.js';

const SAMPLE_SUB = {pubkey: 'a'.repeat(64), endpoint: 'https://fcm.googleapis.com/wp/x',
  p256dh: 'pX', auth: 'aY', relays: []};

describe('push-sender', () => {
  let storage: Storage;
  beforeEach(() => {
    storage = new Storage(':memory:');
    (webpush.sendNotification as any).mockReset();
  });

  it('sendPush returns ok on 201', async() => {
    (webpush.sendNotification as any).mockResolvedValue({statusCode: 201});
    const r = await sendPush({...SAMPLE_SUB, id: 'sub1', created_at: 0, last_seen: 0}, {
      app: 'nostra-webpush-relay', version: 1, event_id: 'eid', recipient_pubkey: SAMPLE_SUB.pubkey, nostra_event: '{}'
    });
    expect(r.ok).toBe(true);
  });

  it('sendPush flags gone on 410', async() => {
    (webpush.sendNotification as any).mockRejectedValue({statusCode: 410, body: 'gone'});
    const r = await sendPush({...SAMPLE_SUB, id: 'sub1', created_at: 0, last_seen: 0}, {
      app: 'nostra-webpush-relay', version: 1, event_id: 'eid', recipient_pubkey: SAMPLE_SUB.pubkey, nostra_event: '{}'
    });
    expect(r.ok).toBe(false);
    expect(r.gone).toBe(true);
  });

  it('fanout sends to all subs for a pubkey', async() => {
    storage.upsert(SAMPLE_SUB);
    storage.upsert({...SAMPLE_SUB, endpoint: 'https://other.invalid'});
    (webpush.sendNotification as any).mockResolvedValue({statusCode: 201});
    const r = await fanout(storage, SAMPLE_SUB.pubkey, {id: 'evt1', kind: 1059, tags: [], content: '', pubkey: 'b', created_at: 0, sig: ''});
    expect(r.sent).toBe(2);
    expect(r.pruned).toBe(0);
  });

  it('fanout prunes 410-Gone subscriptions', async() => {
    storage.upsert(SAMPLE_SUB);
    (webpush.sendNotification as any).mockRejectedValue({statusCode: 410, body: 'gone'});
    const r = await fanout(storage, SAMPLE_SUB.pubkey, {id: 'evt1', kind: 1059, tags: [], content: '', pubkey: 'b', created_at: 0, sig: ''});
    expect(r.sent).toBe(0);
    expect(r.pruned).toBe(1);
    expect(storage.getByPubkey(SAMPLE_SUB.pubkey)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run**

```bash
pnpm test tests/push-sender.test.ts
```
Expected: 4 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/push-sender.ts tests/push-sender.test.ts
git commit -m "feat(push): VAPID sender + fan-out + 410-Gone pruning"
git push
```

**Definition of done:** 4 push-sender tests green; 410 pruning works.

---

## Task S7: integration test + entrypoint wire-up

**Files:**
- Modify: `src/index.ts` (full wire-up)
- Create: `tests/integration.test.ts`

- [ ] **Step 1: Write `src/index.ts` (replaces stub from S1)**

```typescript
// SPDX-License-Identifier: AGPL-3.0-or-later
import {Storage} from './storage.js';
import {buildApp} from './http.js';
import {RelayPool} from './relay-pool.js';
import {fanout} from './push-sender.js';
import {config} from './config.js';
import {log} from './log.js';

if(!config.vapidPublic || !config.vapidPrivate) {
  log.error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required. Generate with: npx web-push generate-vapid-keys');
  process.exit(1);
}

const storage = new Storage();
const pool = new RelayPool(async(evt, recipients) => {
  for(const pk of recipients) {
    const r = await fanout(storage, pk, evt);
    log.info({pk, evtId: evt.id, sent: r.sent, pruned: r.pruned}, 'event fanout');
  }
});

function reconcile(): void {
  const plan = new Map<string, Set<string>>();
  // Build {relay → set of pubkeys to monitor} from current storage state.
  // For simplicity, iterate distinct pubkeys and for each, look up its relays.
  const pubkeys = storage.allDistinctPubkeys();
  for(const pk of pubkeys) {
    const subs = storage.getByPubkey(pk);
    const relays = new Set<string>();
    for(const s of subs) for(const url of s.relays) relays.add(url);
    if(relays.size === 0) for(const url of config.defaultRelays) relays.add(url);
    for(const url of relays) {
      if(!plan.has(url)) plan.set(url, new Set());
      plan.get(url)!.add(pk);
    }
  }
  pool.reconcile(plan);
}

const app = buildApp({storage, vapidPublic: config.vapidPublic});

// Re-reconcile on every successful PUT/DELETE — Fastify hook.
app.addHook('onResponse', async(req, reply) => {
  if(/^\/subscription\//.test(req.url) && [200, 204].includes(reply.statusCode)) {
    reconcile();
  }
});

reconcile(); // initial sync from existing rows

app.listen({port: config.port, host: '0.0.0.0'}).then(() => {
  log.info({port: config.port}, 'listening');
});

process.on('SIGINT', () => {
  log.info('shutdown');
  pool.shutdown();
  storage.close();
  app.close().then(() => process.exit(0));
});
```

- [ ] **Step 2: Write `tests/integration.test.ts`**

This boots the full app against a mock relay + a mock push gateway and asserts the end-to-end flow.

```typescript
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {WebSocketServer} from 'ws';
import {generateSecretKey, getPublicKey, finalizeEvent} from 'nostr-tools';
import {Storage} from '../src/storage.js';
import {buildApp} from '../src/http.js';
import {RelayPool} from '../src/relay-pool.js';
import {fanout} from '../src/push-sender.js';

vi.mock('web-push', () => {
  const sent: any[] = [];
  return {
    default: {
      setVapidDetails: vi.fn(),
      sendNotification: vi.fn(async(sub, payload) => { sent.push({sub, payload: JSON.parse(payload)}); return {statusCode: 201}; }),
      __sent: sent
    }
  };
});
import webpush from 'web-push';

function nip98(opts: {sk: Uint8Array; method: string; url: string}): string {
  const evt = finalizeEvent({kind: 27235, created_at: Math.floor(Date.now() / 1000),
    tags: [['url', opts.url], ['method', opts.method.toUpperCase()]], content: ''}, opts.sk);
  return 'Nostr ' + Buffer.from(JSON.stringify(evt)).toString('base64');
}

describe('integration: register → relay event → push fan-out', () => {
  let storage: Storage;
  let app: ReturnType<typeof buildApp>;
  let pool: RelayPool;
  let mockRelay: WebSocketServer;

  beforeEach(async() => {
    storage = new Storage(':memory:');
    pool = new RelayPool(async(evt, recipients) => {
      for(const pk of recipients) await fanout(storage, pk, evt);
    });
    app = buildApp({storage, vapidPublic: 'PUB'});
    mockRelay = new WebSocketServer({port: 28788});
    (webpush as any).__sent.length = 0;
  });
  afterEach(async() => {
    pool.shutdown();
    await new Promise<void>((r) => mockRelay.close(() => r()));
  });

  it('full pipeline: register → relay event arrives → push sent', async() => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const url = `http://localhost:80/subscription/${pk}`;

    const r = await app.inject({
      method: 'PUT',
      url: `/subscription/${pk}`,
      headers: {host: 'localhost', authorization: nip98({sk, method: 'PUT', url})},
      payload: {endpoint: 'https://fcm.googleapis.com/wp/abc', keys: {p256dh: 'pX', auth: 'aY'}, relays: ['ws://localhost:28788']}
    });
    expect(r.statusCode).toBe(200);

    pool.reconcile(new Map([['ws://localhost:28788', new Set([pk])]]));
    await new Promise((res) => setTimeout(res, 300));

    // Publish a matching event from the mock relay
    const sample = {id: 'evt-int-1', pubkey: 'wrap', created_at: 1, kind: 1059,
      tags: [['p', pk]], content: 'cipher', sig: 'sig'};
    for(const c of mockRelay.clients) c.send(JSON.stringify(['EVENT', 'sub', sample]));
    await new Promise((res) => setTimeout(res, 200));

    const sent = (webpush as any).__sent;
    expect(sent.length).toBe(1);
    expect(sent[0].payload.app).toBe('nostra-webpush-relay');
    expect(sent[0].payload.event_id).toBe('evt-int-1');
    expect(sent[0].payload.recipient_pubkey).toBe(pk);
  });
});
```

- [ ] **Step 3: Run**

```bash
pnpm test
```
Expected: All tests across all files pass (8 + 9 + 7 + 3 + 4 + 1 = 32 total).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts tests/integration.test.ts
git commit -m "feat: end-to-end pipeline + integration test"
git push
```

**Definition of done:** Full pipeline test green; entrypoint wires storage + http + relay pool + push sender.

---

## Task S8: deploy artifacts

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `systemd/nostr-webpush-relay.service`
- Create: `docs/DEPLOY.md`
- Create: `docs/PROTOCOL.md`
- Modify: `README.md`

- [ ] **Step 1: `Dockerfile`** (multi-stage)

```dockerfile
# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:20-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile && pnpm store prune
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
ENV DB_PATH=/data/relay.db
ENV PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://localhost:8787/healthz || exit 1
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: `docker-compose.yml`**

```yaml
services:
  relay:
    build: .
    image: ghcr.io/nostra-chat/nostr-webpush-relay:latest
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/data
    ports:
      - "127.0.0.1:8787:8787"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8787/healthz"]
```

- [ ] **Step 3: `.env.example`**

```
# Generate with: npx web-push generate-vapid-keys --json
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@nostra.chat

PORT=8787
DB_PATH=/data/relay.db

# Default relays used when a subscription doesn't specify any
DEFAULT_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.snort.social

MAX_RELAYS_PER_SUB=5
NIP98_CLOCK_SKEW_SEC=60

LOG_LEVEL=info
```

- [ ] **Step 4: `systemd/nostr-webpush-relay.service`**

```ini
[Unit]
Description=nostr-webpush-relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=relay
Group=relay
WorkingDirectory=/opt/nostr-webpush-relay
EnvironmentFile=/opt/nostr-webpush-relay/.env
ExecStart=/usr/bin/node /opt/nostr-webpush-relay/dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/nostr-webpush-relay/data

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 5: `docs/DEPLOY.md`** — operator guide

Sections:
1. **Prerequisites** — Node.js 20, a VPS, optionally Cloudflare account.
2. **Generate VAPID keys** — `npx web-push generate-vapid-keys --json`.
3. **Path 1: Docker Compose** — clone, `cp .env.example .env`, edit, `docker compose up -d`.
4. **Path 2: systemd** — `pnpm build`, copy to `/opt`, install service file, `systemctl enable --now`.
5. **Path 3: Cloudflare Tunnel (recommended for IP masking)** — install `cloudflared`, `cloudflared tunnel create push-relay`, configure ingress to `http://localhost:8787`, route `push.nostra.chat` to tunnel, no inbound port required on VPS.
6. **First-time test** — curl `/healthz`, register a fake subscription with NIP-98 via a small helper script, verify table populated.

- [ ] **Step 6: `docs/PROTOCOL.md`** — full HTTP API reference (route table, body schemas, NIP-98 example header construction in TS pseudocode, push payload field map).

- [ ] **Step 7: README — update Status checklist, add Docker quickstart link**

- [ ] **Step 8: Commit**

```bash
git add Dockerfile docker-compose.yml .env.example systemd/ docs/DEPLOY.md docs/PROTOCOL.md README.md
git commit -m "feat(deploy): docker + systemd + cloudflare tunnel + docs"
git push
```

**Definition of done:** A new operator following `docs/DEPLOY.md` can stand up the relay end-to-end in <30 min on a fresh VPS.

---

## Task S9: deploy to project owner's VPS

This task requires shell access to the VPS — it's an interactive operator task, not a code task.

- [ ] **Step 1: Generate VAPID keys (once)**

```bash
cd /home/raider/Repository/nostr-webpush-relay
npx web-push generate-vapid-keys --json > /tmp/vapid.json
cat /tmp/vapid.json
```

Save the output securely. The public key goes into the Nostra.chat client config (in the spec, `https://push.nostra.chat/info` returns it dynamically — but we can hardcode for the first deployment).

- [ ] **Step 2: Build a release tarball**

```bash
pnpm build
tar czf /tmp/nostr-webpush-relay.tgz dist/ package.json pnpm-lock.yaml systemd/
```

- [ ] **Step 3: SCP to VPS, install, start**

This step depends on the VPS specifics. Documented procedure:
1. `scp /tmp/nostr-webpush-relay.tgz <vps>:/tmp/`
2. SSH into VPS, extract to `/opt/nostr-webpush-relay/`, `pnpm install --prod`.
3. Drop `.env` with VAPID keys.
4. Install systemd unit, `systemctl enable --now nostr-webpush-relay`.
5. Verify `curl http://127.0.0.1:8787/healthz` returns 200.

(Alternative: `docker compose up -d` if Docker is the chosen path.)

- [ ] **Step 4: Configure Cloudflare Tunnel for `push.nostra.chat`**

```bash
# On VPS
cloudflared tunnel login                               # browser-based auth to CF
cloudflared tunnel create push-nostra-relay
# Note the tunnel UUID and credentials file path printed.
```

Edit `/etc/cloudflared/config.yml`:
```yaml
tunnel: <UUID>
credentials-file: /home/<user>/.cloudflared/<UUID>.json
ingress:
  - hostname: push.nostra.chat
    service: http://localhost:8787
  - service: http_status:404
```

```bash
cloudflared tunnel route dns push-nostra-relay push.nostra.chat
sudo systemctl enable --now cloudflared
```

Verify from outside:
```bash
curl https://push.nostra.chat/healthz
# Expected: {"status":"ok","uptime_s":...}
curl https://push.nostra.chat/info
# Expected: {"vapid_public_key":"<...>","version":"0.1.0"}
```

- [ ] **Step 5: Lock the VAPID public key + endpoint into the client plan**

The Nostra.chat client plan (`docs/superpowers/plans/2026-04-26-background-push-notifications.md`) Task 11 calls `/info` at runtime, so no hardcoding is needed — but the **default endpoint base** in `nostra-push-storage.ts:DEFAULT_ENDPOINT` must change from the original `https://notify.damus.io` to `https://push.nostra.chat`. Update the client plan and spec (or just the code, when implementing T2).

- [ ] **Step 6: Smoke test from a real browser (no client integration yet)**

Open the browser dev console at any HTTPS-served origin (e.g. `https://nostra.chat`) and run:

```javascript
const reg = await navigator.serviceWorker.register('/sw-test.js'); // any SW
const sub = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: '<the VAPID public key fetched from /info>'
});
console.log(sub.toJSON());
```

Use a NIP-98 helper to register that sub against `https://push.nostra.chat/subscription/<your_pubkey>` (NIP-98 over HTTPS works fine; you can hand-craft via nostr-tools). Then publish a test kind 1059 to `relay.damus.io` tagged `#p:<your_pubkey>`. The browser SW should receive a push event with `payload.app === 'nostra-webpush-relay'`.

If it works: ✅ proceed to client implementation (the rest of `2026-04-26-background-push-notifications.md`).
If not: debug from the relay logs (`journalctl -u nostr-webpush-relay -f` or `docker compose logs -f relay`).

**Definition of done:** `https://push.nostra.chat/healthz` is reachable from the public internet, returns 200; relay accepts NIP-98 PUT, tracks WS to a Nostr relay, sends Web Push that is received and decryptable by a real browser.

---

## After S1-S9 → switch to client plan

Once the server is deployed and the smoke test passes, switch to executing the **client** plan: `docs/superpowers/plans/2026-04-26-background-push-notifications.md`. Adjustments needed before resuming:

- Task 1 (Damus probe) is no longer relevant — supersede with this server plan.
- Task 2 `nostra-push-storage.ts:DEFAULT_ENDPOINT` should be `'https://push.nostra.chat'`.
- Task 5 `nostra-push-client.ts` `RegisterRequestBody` field names match the contract above (`endpoint`, `keys.p256dh`, `keys.auth`, optional `relays[]`). The body wraps in `{endpoint, keys, relays}` not flat `{pubkey, ...}`.
- Task 5 must additionally compute and send the **NIP-98 Authorization header** for both PUT and DELETE. Add a helper `buildNip98Header(method, url, privkey)` using `nostr-tools.finalizeEvent` (mirror of the test helper above).
- Task 7 SW handler discriminator becomes `payload.app === 'nostra-webpush-relay'`.
- Task 7 SW decryption: the full event is provided in `payload.nostra_event` (string) — no relay refetch needed, simplifies the B/C path.

These adjustments are small — apply them when executing each task, not as a separate amendment commit.

---

## Self-Review Checklist (server plan)

- ✅ Spec coverage: every component in the spec's "Architecture" section (HTTP API, NIP-98 auth, relay subscriber, push sender, storage) maps to a task.
- ✅ No placeholders. Where field names are introduced, they're terminal (the contract).
- ✅ Method-name consistency: `Storage.upsert/getByPubkey/delete/deleteByEndpoint/allDistinctPubkeys/allDistinctRelays`, `RelayPool.reconcile/shutdown`, `sendPush/fanout`, `verifyNip98/reqFullUrl`, `buildApp` — referenced consistently.
- ✅ Frequent commits — one per task plus the deploy task.
- ✅ TDD: each implementation task is followed (or accompanied) by a unit test task; integration tests at S7 verify the wiring.
