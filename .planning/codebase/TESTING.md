# Testing Patterns

**Analysis Date:** 2026-03-31

## Test Framework

**Runner:**
- Vitest 0.34.6
- Config: `vite.config.ts` (test section, lines 128-161)
- Environment: jsdom (browser-like environment)
- Threads: disabled (`threads: false`)
- Globals enabled: `globals: true` (describe, test, expect available without imports)
- Setup file: `src/tests/setup.ts`

**Assertion Library:**
- Vitest built-in expect (compatible with Jest)
- No additional assertion library required

**Run Commands:**
```bash
pnpm test              # Run all tests (excludes E2E tests via config)
pnpm test src/tests/   # Run specific directory
pnpm test foo.test.ts  # Run specific file
pnpm test --run        # Run once (not watch)
```

## Test File Organization

**Location:**
- Tests co-located with source in `src/tests/` directory
- Monorepo pattern: separate namespace per feature
  - `src/tests/cards.test.ts` - card validation helpers
  - `src/tests/slicedArray.test.ts` - array utilities
  - `src/tests/srp.test.ts` - crypto utilities
  - `src/tests/fixSdp.test.ts` - WebRTC utilities
  - `src/tests/nostra/*.test.ts` - Nostra.chat-specific (transport, relays, chat, etc.)

**Naming:**
- Pattern: `[module].test.ts` or `[module].spec.ts` (both supported)
- E2E tests: `e2e-*.test.ts` (excluded from default run via vite.config.ts config)

**Test Exclusions (from vitest config):**
```
**/src/tests/nostra/e2e-chat.test.ts
**/src/tests/nostra/e2e-fallback.test.ts
**/src/tests/nostra/e2e-onboarding-integration.test.ts
**/src/tests/nostra/e2e-tor-messaging.test.ts
**/src/tests/nostra/e2e-ui-flow.test.ts
```
Run E2E tests explicitly: `pnpm test e2e-chat.test.ts`

## Test Structure

**Suite Organization:**
```typescript
describe('OfflineQueue', () => {
  let mockRelayPool: MockRelayPool;
  let queue: OfflineQueue;

  beforeEach(() => {
    mockRelayPool = new MockRelayPool();
    queue = new OfflineQueue(mockRelayPool as any);
  });

  afterEach(() => {
    queue.destroy();
  });

  describe('queue()', () => {
    test('stores a message locally and returns a message ID', async() => {
      const peerId = 'BBBBBB.CCCCCC.DDDDDD';
      const payload = 'Hello, World!';

      const messageId = await queue.queue(peerId, payload);

      expect(messageId).toBeDefined();
      expect(typeof messageId).toBe('string');
    });
  });
});
```

**Patterns:**
- `describe()` blocks for feature/module grouping (can nest)
- `test()` for individual test cases (not `it()`)
- `beforeEach()` / `afterEach()` for setup/teardown
- Nested `describe()` for sub-feature organization
- Assertion-based (expect style, not assertion statements)

**Setup File (`src/tests/setup.ts`):**
- Polyfills crypto API for jsdom: `globalScope.crypto = {subtle, getRandomValues}`
- Mock WebRTC APIs:
  - `RTCPeerConnection` - mock with signalingState, listeners, createOffer/Answer/etc.
  - `RTCDataChannel` - mock with label, readyState, event dispatching
  - `RTCSessionDescription` - mock with type/sdp properties
  - `RTCIceCandidate` - mock with candidate, sdpMid, sdpMLineIndex
- Enables WebRTC-dependent tests to run in jsdom without real browser APIs

## Mocking

**Framework:**
- Manual mocking with class factories (see setup.ts pattern)
- No mocking library used (vitest can use `vi.*` but not heavily used in codebase)
- Type-cast mocks: `mockRelayPool as any` to bypass strict typing

**Patterns:**
```typescript
class MockRelayPool {
  private _connected = false;
  publishCalls: Array<{recipientPubkey: string; plaintext: string}> = [];
  publishShouldFail = false;

  async publish(recipientPubkey: string, plaintext: string): Promise<PublishResult> {
    this.publishCalls.push({recipientPubkey, plaintext});
    if(this.publishShouldFail) {
      return {successes: [], failures: [{url: 'wss://relay.test', error: 'mock failure'}]};
    }
    return {successes: [`event-${Date.now()}`], failures: []};
  }

  simulateConnect(): void {
    this._connected = true;
  }
}
```

**What to Mock:**
- External services: NostrRelayPool, RTCPeerConnection
- I/O operations: database calls, network requests
- Time-dependent behavior: provide test helpers to simulate state changes
- Global objects: crypto, WebRTC APIs (done in setup.ts)

**What NOT to Mock:**
- Pure utility functions: test with real implementations
- Validation logic: test actual validation, not mocked validators
- Data transformations: test real transforms
- Application business logic: test real app code unless it depends on mocks

## Fixtures and Factories

**Test Data:**
```typescript
interface TestIdentity {
  id: string;
  ownId: string;
  seed: string;
  publicKey: string;
  privateKey: string;
  encryptionKey: string;
  createdAt: number;
}

function generateTestIdentity(): TestIdentity {
  const seedWords = Array.from({length: 12}, () => {
    const idx = Math.floor(Math.random() * 2048);
    return idx;
  });
  const pubKeyHex = randomHex(32);
  // ... construct and return identity
}
```

**Location:**
- Test data factories defined inline in test file (not separate fixtures directory)
- Example: `src/tests/nostra/e2e-chat.test.ts` defines `generateTestIdentity()`, `deriveOwnIdFromPubKey()`, etc.
- Shared mocks/factories: co-located with tests that use them

## Coverage

**Requirements:**
- No coverage requirements enforced in config (coverage config commented out in vite.config.ts)
- Test all public APIs and critical paths
- E2E tests verify full integration paths

**View Coverage:**
```bash
# Not configured, but could enable with:
# pnpm test --coverage
```

## Test Types

**Unit Tests:**
- Scope: Individual functions/classes in isolation
- Approach: Mock dependencies, test single unit behavior
- Examples:
  - `src/tests/cards.test.ts` - card validation with real formatters
  - `src/tests/slicedArray.test.ts` - array insertion/slicing
  - `src/tests/srp.test.ts` - SRP crypto functions
  - `src/tests/fixSdp.test.ts` - SDP fixing utility

**Integration Tests:**
- Scope: Multiple modules working together
- Approach: Mock external I/O, test module interaction
- Examples:
  - `src/tests/nostra/offline-queue.test.ts` - OfflineQueue with MockRelayPool
  - `src/tests/nostra/chat-api.test.ts` - ChatAPI with mock relay
  - `src/tests/nostra/transport.test.ts` - PeerTransport with mock RTCPeerConnection
  - `src/tests/nostra/nostr-relay-pool.test.ts` - relay pool connection/subscription

**E2E Tests:**
- Framework: Playwright 1.58.2 (from @playwright/test)
- Scope: Full app flow with browser automation
- Approach: Launch real browsers, inject test data, verify UI rendering
- Examples:
  - `src/tests/nostra/e2e-chat.test.ts` - two users exchange messages via Nostr relay
  - `src/tests/nostra/e2e-onboarding-integration.test.ts` - identity generation flow
  - `src/tests/nostra/e2e-fallback.test.ts` - fallback routing behavior
  - `src/tests/nostra/e2e-ui-flow.test.ts` - UI state transitions
  - `src/tests/nostra/e2e-tor-messaging.test.ts` - Tor transport layer

**E2E Test Pattern:**
```typescript
import {test, expect, chromium, BrowserContext, Page} from '@playwright/test';

test.describe('Nostra.chat E2E', () => {
  test('app-router-renders-onboarding-when-no-identity', async() => {
    const browser = await chromium.launch({headless: true});
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();

      const logs: string[] = [];
      page.on('console', (msg) => {
        if(msg.text().includes('[NostraApp]')) logs.push(msg.text());
      });

      await page.goto('http://localhost:8080/nostra', {waitUntil: 'domcontentloaded'});
      // Assert page state, elements visible, etc.
    } finally {
      await browser.close();
    }
  });
});
```

## Common Patterns

**Async Testing:**
```typescript
test('stores a message locally and returns a message ID', async() => {
  const messageId = await queue.queue(peerId, payload);
  expect(messageId).toBeDefined();
});

// With callbacks returning promises
await new Promise((resolve, reject) => {
  ws.onopen = () => {
    ws.send(JSON.stringify(['EVENT', event]));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if(msg[0] === 'OK') {
      resolve();
    }
  };
  ws.onerror = () => reject(new Error('WebSocket error'));
});
```

**Error Testing:**
```typescript
test('returns error on invalid card number', () => {
  const result = validateCardNumber('4242424242424241');
  expect(result.code).toEqual('invalid');
});

test('returns incomplete for partial card', () => {
  const result = validateCardNumber('424242424242424');
  expect(result).toEqual({type: 'invalid', code: 'incomplete'});
});
```

**Mocking State Changes:**
```typescript
// In mock object
simulateConnect(): void {
  this._connected = true;
}

// In test
mockRelayPool.simulateConnect();
expect(queue.isConnected()).toBe(true);
```

**Testing with Fixtures:**
```typescript
beforeEach(() => {
  mockRelayPool = new MockRelayPool();
  queue = new OfflineQueue(mockRelayPool as any);
});

afterEach(() => {
  queue.destroy();  // Cleanup
});
```

---

*Testing analysis: 2026-03-31*
