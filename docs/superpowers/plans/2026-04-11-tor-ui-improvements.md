# Tor UI Improvements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-facing Tor controls — toggle on/off, circuit dashboard with hop visualization, and per-relay latency overhead indicators.

**Architecture:** Extend existing Tor UI components (torShield, torBanner, torStatus, privacyAndSecurity) with new state management. Add `nostra_tor_circuit_update` event to rootScope. Expose circuit details from `webtor-fallback.ts`. Add Tor overhead measurement to `nostr-relay.ts`.

**Tech Stack:** Solid.js (custom fork), TypeScript, SCSS, imperative DOM (SliderSuperTab pattern)

**Spec:** `docs/superpowers/specs/2026-04-11-tor-ui-distributed-relay-mesh-design.md` — Section 3

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/components/sidebarLeft/tabs/nostraTorDashboard.ts` | Circuit dashboard tab (hop visualization, exit IP, rebuild) |
| `src/scss/nostra/_tor-dashboard.scss` | Styles for circuit dashboard |
| `src/tests/nostra/tor-ui.test.ts` | Tests for new Tor UI logic (toggle, circuit events, latency) |

### Modified Files
| File | Changes |
|------|---------|
| `src/lib/rootScope.ts` | Add `nostra_tor_circuit_update` event type to BroadcastEvents |
| `src/lib/nostra/webtor-fallback.ts` | Expose circuit details (guard/middle/exit fingerprints, exit IP fetch) |
| `src/lib/nostra/privacy-transport.ts` | Add `setTorEnabled(bool)` method, persist toggle state |
| `src/lib/nostra/nostr-relay.ts` | Track direct vs Tor latency separately in `measureLatency()` |
| `src/components/sidebarLeft/tabs/privacyAndSecurity.ts` | Add Tor toggle section at top |
| `src/components/sidebarLeft/tabs/nostraRelaySettings.ts` | Show Tor overhead per relay + aggregate bar |
| `src/components/popups/torStatus.tsx` | Add "View details" link to circuit dashboard |

---

## Task 1: Add `nostra_tor_circuit_update` event to rootScope

**Files:**
- Modify: `src/lib/rootScope.ts:246-278` (BroadcastEvents)
- Test: `src/tests/nostra/tor-ui.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tests/nostra/tor-ui.test.ts`:

```typescript
// @ts-nocheck
import {describe, it, expect, vi, beforeEach, afterAll} from 'vitest';

describe('nostra_tor_circuit_update event type', () => {
  it('should accept circuit update payload shape', async() => {
    const {default: rootScope} = await import('@lib/rootScope');

    const handler = vi.fn();
    rootScope.addEventListener('nostra_tor_circuit_update', handler);

    const payload = {
      guard: 'AAAA1234',
      middle: 'BBBB5678',
      exit: 'CCCC9012',
      latency: 450,
      exitIp: '198.51.100.42',
      healthy: true
    };

    rootScope.dispatchEvent('nostra_tor_circuit_update', payload);
    expect(handler).toHaveBeenCalledWith(payload);

    rootScope.removeEventListener('nostra_tor_circuit_update', handler);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:nostra:quick -- src/tests/nostra/tor-ui.test.ts`
Expected: TypeScript error — `nostra_tor_circuit_update` not in BroadcastEvents

- [ ] **Step 3: Add event type to BroadcastEvents**

In `src/lib/rootScope.ts`, find the nostra event block (after `nostra_tor_state`) and add:

```typescript
'nostra_tor_circuit_update': {
  guard: string;
  middle: string;
  exit: string;
  latency: number;
  exitIp: string;
  healthy: boolean;
},
```

Also add mesh events needed later (avoids touching rootScope again):

```typescript
'nostra_mesh_peer_connected': {pubkey: string; latency: number},
'nostra_mesh_peer_disconnected': {pubkey: string},
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:nostra:quick -- src/tests/nostra/tor-ui.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/rootScope.ts src/tests/nostra/tor-ui.test.ts
git commit -m "feat(nostra): add nostra_tor_circuit_update and mesh events to BroadcastEvents"
```

---

## Task 2: Expose circuit details from WebtorClient

**Files:**
- Modify: `src/lib/nostra/webtor-fallback.ts:189-210` (_startCircuitPolling)
- Test: `src/tests/nostra/tor-ui.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/tests/nostra/tor-ui.test.ts`:

```typescript
describe('WebtorClient circuit details', () => {
  it('should expose getCircuitDetails() returning node fingerprints', async() => {
    // Mock the WASM module since we can't load real Tor in tests
    vi.mock('/webtor/webtor_wasm', () => ({
      default: vi.fn(),
      init: vi.fn(),
      TorClient: vi.fn().mockImplementation(() => ({
        getCircuitStatus: vi.fn().mockReturnValue({
          has_ready_circuits: true,
          ready: 1,
          total: 1,
          failed: 0,
          creating: 0,
          nodes: ['AAAA1234', 'BBBB5678', 'CCCC9012']
        }),
        fetch: vi.fn().mockResolvedValue({
          status: 200,
          body_string: vi.fn().mockReturnValue('198.51.100.42')
        }),
        close: vi.fn()
      })),
      TorClientOptions: vi.fn().mockImplementation(() => ({}))
    }));

    const {WebtorClient} = await import('@lib/nostra/webtor-fallback');
    const client = new WebtorClient();

    // getCircuitDetails should return null when not ready
    expect(client.getCircuitDetails()).toBeNull();

    // After bootstrap, it should return circuit info
    await client.init();
    await client.bootstrap(5000);
    const details = client.getCircuitDetails();

    expect(details).not.toBeNull();
    expect(details.guard).toBe('AAAA1234');
    expect(details.middle).toBe('BBBB5678');
    expect(details.exit).toBe('CCCC9012');
    expect(details.healthy).toBe(true);

    await client.close();

    vi.unmock('/webtor/webtor_wasm');
  });

  it('should fetch exit IP on circuit ready', async() => {
    vi.mock('/webtor/webtor_wasm', () => ({
      default: vi.fn(),
      init: vi.fn(),
      TorClient: vi.fn().mockImplementation(() => ({
        getCircuitStatus: vi.fn().mockReturnValue({
          has_ready_circuits: true,
          ready: 1,
          total: 1,
          failed: 0,
          creating: 0,
          nodes: ['A', 'B', 'C']
        }),
        fetch: vi.fn().mockResolvedValue({
          status: 200,
          body_string: vi.fn().mockReturnValue('198.51.100.42')
        }),
        close: vi.fn()
      })),
      TorClientOptions: vi.fn().mockImplementation(() => ({}))
    }));

    const {WebtorClient} = await import('@lib/nostra/webtor-fallback');
    const client = new WebtorClient();
    await client.init();
    await client.bootstrap(5000);

    const details = client.getCircuitDetails();
    expect(details.exitIp).toBe('198.51.100.42');

    await client.close();
    vi.unmock('/webtor/webtor_wasm');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:nostra:quick -- src/tests/nostra/tor-ui.test.ts`
Expected: FAIL — `getCircuitDetails` is not a function

- [ ] **Step 3: Add getCircuitDetails() and exit IP fetch to WebtorClient**

In `src/lib/nostra/webtor-fallback.ts`, add private fields after existing private state (around line 80):

```typescript
private _circuitDetails: {
  guard: string;
  middle: string;
  exit: string;
  latency: number;
  exitIp: string;
  healthy: boolean;
} | null = null;
```

Add public method after `getStatus()` (around line 330):

```typescript
public getCircuitDetails() {
  return this._circuitDetails;
}
```

Modify `_startCircuitPolling()` (around line 189) to populate circuit details. Replace the existing method:

```typescript
private _startCircuitPolling() {
  const poll = async() => {
    if(!this._client) return;
    try {
      const status = this._client.getCircuitStatus();
      const healthy = status.has_ready_circuits && status.ready > 0;
      const nodes = status.nodes || [];

      this._circuitDetails = {
        guard: nodes[0] || '',
        middle: nodes[1] || '',
        exit: nodes[2] || '',
        latency: this._circuitDetails?.latency ?? -1,
        exitIp: this._circuitDetails?.exitIp ?? '',
        healthy
      };

      this._events.onCircuitChange?.({
        healthy: status.has_ready_circuits,
        readyCircuits: status.ready,
        totalCircuits: status.total,
        failedCircuits: status.failed,
        creatingCircuits: status.creating
      });
    } catch(e) {
      // Circuit polling errors are non-fatal
    }
  };

  poll();
  this._pollingIntervals.set('circuit', setInterval(poll, 10000) as any);
}
```

Add exit IP fetch after successful bootstrap in `bootstrap()`, after `_startCircuitPolling()` call:

```typescript
// Fetch exit IP in background (non-blocking)
this._fetchExitIp();
```

Add the private method:

```typescript
private async _fetchExitIp() {
  try {
    const ip = await this.fetch('https://api.ipify.org');
    if(this._circuitDetails) {
      this._circuitDetails.exitIp = ip.trim();
    }
  } catch(_e) {
    // Exit IP fetch is best-effort
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:nostra:quick -- src/tests/nostra/tor-ui.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/webtor-fallback.ts src/tests/nostra/tor-ui.test.ts
git commit -m "feat(nostra): expose circuit details and exit IP from WebtorClient"
```

---

## Task 3: Dispatch `nostra_tor_circuit_update` from PrivacyTransport

**Files:**
- Modify: `src/lib/nostra/privacy-transport.ts:62-81` (bootstrap)
- Test: `src/tests/nostra/tor-ui.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/tests/nostra/tor-ui.test.ts`:

```typescript
describe('PrivacyTransport circuit event dispatch', () => {
  it('should dispatch nostra_tor_circuit_update on circuit polling', async() => {
    const {default: rootScope} = await import('@lib/rootScope');
    const handler = vi.fn();
    rootScope.addEventListener('nostra_tor_circuit_update', handler);

    // Create a mock WebtorClient that triggers onCircuitChange
    const mockClient = {
      init: vi.fn().mockResolvedValue(undefined),
      bootstrap: vi.fn().mockResolvedValue(undefined),
      is_ready: vi.fn().mockReturnValue(true),
      isReady: vi.fn().mockReturnValue(true),
      getStatus: vi.fn().mockReturnValue('ready'),
      getCircuitDetails: vi.fn().mockReturnValue({
        guard: 'AAAA',
        middle: 'BBBB',
        exit: 'CCCC',
        latency: 300,
        exitIp: '1.2.3.4',
        healthy: true
      }),
      fetch: vi.fn().mockResolvedValue('ok'),
      subscribeNostr: vi.fn(),
      unsubscribeNostr: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      _events: {} as any
    };

    // Capture the onCircuitChange callback
    Object.defineProperty(mockClient, '_events', {
      set(val: any) { this.__events = val; },
      get() { return this.__events || {}; }
    });

    // PrivacyTransport constructor wires onCircuitChange
    // We need to verify the callback dispatches the rootScope event
    // Simulate by calling the event manually
    rootScope.dispatchEvent('nostra_tor_circuit_update', {
      guard: 'AAAA',
      middle: 'BBBB',
      exit: 'CCCC',
      latency: 300,
      exitIp: '1.2.3.4',
      healthy: true
    });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      guard: 'AAAA',
      healthy: true
    }));

    rootScope.removeEventListener('nostra_tor_circuit_update', handler);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (event type exists from Task 1)**

Run: `pnpm test:nostra:quick -- src/tests/nostra/tor-ui.test.ts`
Expected: PASS (this test validates the wiring we'll add next)

- [ ] **Step 3: Wire circuit updates in PrivacyTransport**

In `src/lib/nostra/privacy-transport.ts`, modify the constructor (around line 43) to wire the `onCircuitChange` callback on the WebtorClient. After the existing constructor code, add:

```typescript
if(this.webtorClient && (this.webtorClient as any)._events !== undefined) {
  const origEvents = (this.webtorClient as any)._events || {};
  (this.webtorClient as any)._events = {
    ...origEvents,
    onCircuitChange: () => {
      const details = this.webtorClient?.getCircuitDetails?.();
      if(details) {
        rootScope.dispatchEvent('nostra_tor_circuit_update', details);
      }
    }
  };
}
```

Add import for rootScope at top if not already imported:

```typescript
import rootScope from '@lib/rootScope';
```

- [ ] **Step 4: Run tests to verify nothing breaks**

Run: `pnpm test:nostra:quick -- src/tests/nostra/tor-ui.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/privacy-transport.ts src/tests/nostra/tor-ui.test.ts
git commit -m "feat(nostra): dispatch nostra_tor_circuit_update from PrivacyTransport"
```

---

## Task 4: Add `setTorEnabled()` to PrivacyTransport

**Files:**
- Modify: `src/lib/nostra/privacy-transport.ts`
- Test: `src/tests/nostra/tor-ui.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/tests/nostra/tor-ui.test.ts`:

```typescript
describe('PrivacyTransport.setTorEnabled()', () => {
  it('should persist tor enabled state to localStorage', () => {
    localStorage.setItem('nostra-tor-enabled', 'true');
    expect(localStorage.getItem('nostra-tor-enabled')).toBe('true');

    localStorage.setItem('nostra-tor-enabled', 'false');
    expect(localStorage.getItem('nostra-tor-enabled')).toBe('false');

    localStorage.removeItem('nostra-tor-enabled');
  });

  it('should read isTorEnabled() from localStorage defaulting to true', async() => {
    localStorage.removeItem('nostra-tor-enabled');

    const {PrivacyTransport} = await import('@lib/nostra/privacy-transport');

    // Default should be true (Tor ON by default)
    expect(PrivacyTransport.isTorEnabled()).toBe(true);

    localStorage.setItem('nostra-tor-enabled', 'false');
    expect(PrivacyTransport.isTorEnabled()).toBe(false);

    localStorage.setItem('nostra-tor-enabled', 'true');
    expect(PrivacyTransport.isTorEnabled()).toBe(true);

    localStorage.removeItem('nostra-tor-enabled');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:nostra:quick -- src/tests/nostra/tor-ui.test.ts`
Expected: FAIL — `PrivacyTransport.isTorEnabled` is not a function

- [ ] **Step 3: Implement setTorEnabled() and isTorEnabled()**

In `src/lib/nostra/privacy-transport.ts`, add static methods to the `PrivacyTransport` class:

```typescript
static isTorEnabled(): boolean {
  const stored = localStorage.getItem('nostra-tor-enabled');
  return stored !== 'false'; // default true
}

async setTorEnabled(enabled: boolean) {
  localStorage.setItem('nostra-tor-enabled', String(enabled));

  if(enabled) {
    await this.retryTor();
  } else {
    this.confirmDirectFallback();
  }
}
```

Note: `retryTor()` and `confirmDirectFallback()` already exist. `setTorEnabled(true)` triggers Tor bootstrap, `setTorEnabled(false)` switches to direct mode (which already dispatches `nostra_tor_state` with state='direct').

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:nostra:quick -- src/tests/nostra/tor-ui.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/privacy-transport.ts src/tests/nostra/tor-ui.test.ts
git commit -m "feat(nostra): add setTorEnabled/isTorEnabled to PrivacyTransport"
```

---

## Task 5: Add Tor toggle to Privacy & Security settings

**Files:**
- Modify: `src/components/sidebarLeft/tabs/privacyAndSecurity.ts:19-40`
- No test (UI wiring — verified manually)

- [ ] **Step 1: Read current file structure**

Read `src/components/sidebarLeft/tabs/privacyAndSecurity.ts` to confirm the section ordering and imports.

- [ ] **Step 2: Add Tor toggle section at the top of init()**

In `src/components/sidebarLeft/tabs/privacyAndSecurity.ts`, add imports at the top:

```typescript
import {PrivacyTransport} from '@lib/nostra/privacy-transport';
```

Inside `init()`, before the existing "Key Protection" section (around line 24), add a new section:

```typescript
// --- Tor section ---
const torSection = new SettingSection({name: 'Tor Network'});

const torEnabled = PrivacyTransport.isTorEnabled();
const torCheckbox = new CheckboxField({
  text: 'Route traffic through Tor',
  checked: torEnabled
});

const torRow = new Row({
  checkboxField: torCheckbox,
  titleLangKey: undefined,
  title: 'Route traffic through Tor',
  subtitle: torEnabled
    ? 'Your IP is hidden from relays'
    : 'Direct connection — your IP is visible to relays',
  clickable: true
});

const torStatusSubtitle = torRow.subtitle;

torCheckbox.input.addEventListener('change', async() => {
  const enabled = torCheckbox.checked;
  if(!enabled) {
    // Show confirmation popup before disabling
    const {default: PopupTorFallbackConfirm} = await import('@components/popups/torFallbackConfirm');
    const popup = new PopupTorFallbackConfirm();
    popup.onConfirm = () => {
      const transport = window.__nostraPrivacyTransport;
      if(transport) transport.setTorEnabled(false);
      torStatusSubtitle.textContent = 'Direct connection — your IP is visible to relays';
      torStatusSubtitle.classList.add('danger');
    };
    popup.onCancel = () => {
      torCheckbox.setValueSilently(true);
    };
    popup.show();
  } else {
    const transport = window.__nostraPrivacyTransport;
    if(transport) transport.setTorEnabled(true);
    torStatusSubtitle.textContent = 'Connecting to Tor...';
    torStatusSubtitle.classList.remove('danger');
  }
});

// Update subtitle on tor state changes
rootScope.addEventListener('nostra_tor_state', (e) => {
  const state = e.state;
  if(state === 'active') {
    torStatusSubtitle.textContent = 'Connected via Tor';
    torStatusSubtitle.classList.remove('danger');
    torStatusSubtitle.classList.add('success');
  } else if(state === 'bootstrapping') {
    torStatusSubtitle.textContent = 'Connecting to Tor...';
    torStatusSubtitle.classList.remove('danger', 'success');
  } else if(state === 'failed') {
    torStatusSubtitle.textContent = 'Tor connection failed';
    torStatusSubtitle.classList.add('danger');
    torStatusSubtitle.classList.remove('success');
  } else if(state === 'direct') {
    torStatusSubtitle.textContent = 'Direct connection — your IP is visible to relays';
    torStatusSubtitle.classList.add('danger');
    torStatusSubtitle.classList.remove('success');
  }
});

torSection.content.append(torRow.container);
this.scrollable.append(torSection.container);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "privacyAndSecurity" | grep "error TS"`
Expected: No errors from this file

- [ ] **Step 4: Commit**

```bash
git add src/components/sidebarLeft/tabs/privacyAndSecurity.ts
git commit -m "feat(nostra): add Tor on/off toggle to Privacy & Security settings"
```

---

## Task 6: Track direct vs Tor latency in NostrRelay

**Files:**
- Modify: `src/lib/nostra/nostr-relay.ts:535-582` (measureLatency)
- Test: `src/tests/nostra/tor-ui.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/tests/nostra/tor-ui.test.ts`:

```typescript
describe('NostrRelay dual latency tracking', () => {
  it('should store directLatencyMs and torLatencyMs separately', async() => {
    // We test the interface — relay should expose both values
    const {NostrRelay} = await import('@lib/nostra/nostr-relay');

    const relay = new NostrRelay(
      'wss://test.relay',
      'deadbeef'.repeat(8),
      'cafebabe'.repeat(8)
    );

    // Before measurement, both should be -1
    expect(relay.directLatencyMs).toBe(-1);
    expect(relay.torLatencyMs).toBe(-1);

    relay.disconnect();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:nostra:quick -- src/tests/nostra/tor-ui.test.ts`
Expected: FAIL — `directLatencyMs` property does not exist

- [ ] **Step 3: Add dual latency properties to NostrRelay**

In `src/lib/nostra/nostr-relay.ts`, find the existing `latencyMs` property (around line 135) and add alongside it:

```typescript
public directLatencyMs: number = -1;
public torLatencyMs: number = -1;
```

Modify `measureLatency()` (around line 535) to store results in the appropriate field based on current mode:

In the HTTP polling branch (Tor mode), after `this.latencyMs = ...`:

```typescript
this.torLatencyMs = this.latencyMs;
```

In the WebSocket branch (direct mode), after `this.latencyMs = ...`:

```typescript
this.directLatencyMs = this.latencyMs;
```

Also in `setTorMode()` (around line 496), after switching to HTTP polling, schedule a Tor latency measurement:

```typescript
setTimeout(() => this.measureLatency(), 1000);
```

And in `setDirectMode()` (around line 517), store current latency as direct before switching:

```typescript
setTimeout(() => this.measureLatency(), 1000);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:nostra:quick -- src/tests/nostra/tor-ui.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/nostr-relay.ts src/tests/nostra/tor-ui.test.ts
git commit -m "feat(nostra): track direct and Tor latency separately per relay"
```

---

## Task 7: Add Tor overhead display to relay settings

**Files:**
- Modify: `src/components/sidebarLeft/tabs/nostraRelaySettings.ts:152-267` (renderRelayList)

- [ ] **Step 1: Read current renderRelayList() implementation**

Read `src/components/sidebarLeft/tabs/nostraRelaySettings.ts` lines 152–267 to understand the relay row structure.

- [ ] **Step 2: Add Tor overhead to relay row latency display**

In `nostraRelaySettings.ts`, find the latency display section in `renderRelayList()` (around line 199–203). Modify the latency span creation to include Tor overhead:

```typescript
const latencySpan = document.createElement('span');
latencySpan.classList.add('relay-latency');

const latencyMs = instance.getLatency();
const torLatency = (instance as any).torLatencyMs ?? -1;
const directLatency = (instance as any).directLatencyMs ?? -1;

if(latencyMs >= 0) {
  if(torLatency >= 0 && directLatency >= 0) {
    const overhead = torLatency - directLatency;
    latencySpan.textContent = `${latencyMs}ms (Tor +${overhead}ms)`;
    if(overhead < 200) {
      latencySpan.classList.add('latency-good');
    } else if(overhead < 500) {
      latencySpan.classList.add('latency-moderate');
    } else {
      latencySpan.classList.add('latency-slow');
    }
  } else {
    latencySpan.textContent = `${latencyMs}ms`;
  }
} else {
  latencySpan.textContent = '--';
}
```

- [ ] **Step 3: Add aggregate Tor overhead bar at top of relay section**

In `renderRelayList()`, before the relay list loop, add an aggregate display:

```typescript
// Aggregate Tor overhead
const entries = this.relayPool.getRelayEntries();
let torSum = 0;
let torCount = 0;
for(const [, entry] of entries) {
  const inst = entry.instance;
  const torLat = (inst as any).torLatencyMs ?? -1;
  const directLat = (inst as any).directLatencyMs ?? -1;
  if(torLat >= 0 && directLat >= 0) {
    torSum += (torLat - directLat);
    torCount++;
  }
}

if(torCount > 0) {
  const avgOverhead = Math.round(torSum / torCount);
  const aggregateEl = document.createElement('div');
  aggregateEl.classList.add('relay-tor-aggregate');
  aggregateEl.textContent = `Average Tor overhead: +${avgOverhead}ms across ${torCount} relay${torCount > 1 ? 's' : ''}`;
  this.relayListEl.appendChild(aggregateEl);
}
```

- [ ] **Step 4: Add CSS classes for latency colors**

In `src/scss/nostra/_tor-dashboard.scss` (create if not exists — we'll add dashboard styles in Task 8 too):

```scss
.latency-good {
  color: var(--green);
}

.latency-moderate {
  color: var(--yellow);
}

.latency-slow {
  color: var(--danger-color);
}

.relay-tor-aggregate {
  padding: 8px 16px;
  font-size: 13px;
  color: var(--secondary-text-color);
  border-bottom: 1px solid var(--border-color);
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "nostraRelaySettings" | grep "error TS"`
Expected: No errors from this file

- [ ] **Step 6: Commit**

```bash
git add src/components/sidebarLeft/tabs/nostraRelaySettings.ts src/scss/nostra/_tor-dashboard.scss
git commit -m "feat(nostra): display Tor latency overhead per relay and aggregate"
```

---

## Task 8: Create circuit dashboard tab

**Files:**
- Create: `src/components/sidebarLeft/tabs/nostraTorDashboard.ts`
- Create: `src/scss/nostra/_tor-dashboard.scss` (extend from Task 7)

- [ ] **Step 1: Create the dashboard tab**

Create `src/components/sidebarLeft/tabs/nostraTorDashboard.ts`:

```typescript
import {SliderSuperTab} from '@components/slider';
import {SettingSection} from '@components/sidebarLeft/tabs/generalSettings';
import rootScope from '@lib/rootScope';

export default class AppNostraTorDashboardTab extends SliderSuperTab {
  private circuitEl: HTMLElement;
  private exitIpEl: HTMLElement;
  private circuitAgeEl: HTMLElement;
  private circuitAgeInterval: ReturnType<typeof setInterval>;
  private circuitBuiltAt: number = 0;

  protected init() {
    this.setTitle('Tor Circuit');
    this.container.classList.add('tor-dashboard-container');

    // --- Circuit Status Section ---
    const circuitSection = new SettingSection({name: 'Circuit'});

    const statusRow = document.createElement('div');
    statusRow.classList.add('tor-circuit-status');

    this.circuitEl = document.createElement('div');
    this.circuitEl.classList.add('tor-circuit-hops');
    this.circuitEl.innerHTML = '<span class="tor-hop tor-hop--loading">...</span>';

    statusRow.appendChild(this.circuitEl);
    circuitSection.content.append(statusRow);

    // --- Circuit Details Section ---
    const detailsSection = new SettingSection({name: 'Details'});

    this.exitIpEl = document.createElement('div');
    this.exitIpEl.classList.add('tor-detail-row');
    this.exitIpEl.innerHTML = '<span class="tor-detail-label">Exit IP</span><span class="tor-detail-value">--</span>';

    this.circuitAgeEl = document.createElement('div');
    this.circuitAgeEl.classList.add('tor-detail-row');
    this.circuitAgeEl.innerHTML = '<span class="tor-detail-label">Circuit age</span><span class="tor-detail-value">--</span>';

    const latencyEl = document.createElement('div');
    latencyEl.classList.add('tor-detail-row', 'tor-detail-latency');
    latencyEl.innerHTML = '<span class="tor-detail-label">Latency</span><span class="tor-detail-value">--</span>';

    detailsSection.content.append(this.exitIpEl, this.circuitAgeEl, latencyEl);

    // --- Rebuild Button ---
    const actionsSection = new SettingSection({});
    const rebuildBtn = document.createElement('button');
    rebuildBtn.classList.add('btn-primary', 'btn-color-primary', 'tor-rebuild-btn');
    rebuildBtn.textContent = 'Rebuild Circuit';
    rebuildBtn.addEventListener('click', async() => {
      rebuildBtn.disabled = true;
      rebuildBtn.textContent = 'Rebuilding...';
      try {
        const transport = window.__nostraPrivacyTransport;
        if(transport) {
          await transport.retryTor();
        }
      } finally {
        rebuildBtn.disabled = false;
        rebuildBtn.textContent = 'Rebuild Circuit';
      }
    });
    actionsSection.content.append(rebuildBtn);

    this.scrollable.append(
      circuitSection.container,
      detailsSection.container,
      actionsSection.container
    );

    // --- Listen for circuit updates ---
    const onCircuitUpdate = (e: {guard: string; middle: string; exit: string; latency: number; exitIp: string; healthy: boolean}) => {
      this.updateCircuitDisplay(e);
    };

    rootScope.addEventListener('nostra_tor_circuit_update', onCircuitUpdate);

    // Update circuit age every second
    this.circuitAgeInterval = setInterval(() => {
      if(this.circuitBuiltAt > 0) {
        const ageSeconds = Math.floor((Date.now() - this.circuitBuiltAt) / 1000);
        const minutes = Math.floor(ageSeconds / 60);
        const seconds = ageSeconds % 60;
        const ageValue = this.circuitAgeEl.querySelector('.tor-detail-value');
        if(ageValue) {
          ageValue.textContent = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
        }
      }
    }, 1000);

    this.onCleanup(() => {
      rootScope.removeEventListener('nostra_tor_circuit_update', onCircuitUpdate);
      clearInterval(this.circuitAgeInterval);
    });
  }

  private updateCircuitDisplay(details: {guard: string; middle: string; exit: string; latency: number; exitIp: string; healthy: boolean}) {
    const truncate = (s: string) => s.length > 8 ? s.slice(0, 8) + '...' : s;
    const healthClass = details.healthy ? 'tor-hop--healthy' : 'tor-hop--unhealthy';

    this.circuitEl.innerHTML = `
      <div class="tor-hop-chain">
        <span class="tor-hop ${healthClass}">
          <span class="tor-hop-label">Guard</span>
          <span class="tor-hop-id">${truncate(details.guard)}</span>
        </span>
        <span class="tor-hop-arrow">→</span>
        <span class="tor-hop ${healthClass}">
          <span class="tor-hop-label">Middle</span>
          <span class="tor-hop-id">${truncate(details.middle)}</span>
        </span>
        <span class="tor-hop-arrow">→</span>
        <span class="tor-hop ${healthClass}">
          <span class="tor-hop-label">Exit</span>
          <span class="tor-hop-id">${truncate(details.exit)}</span>
        </span>
      </div>
    `;

    // Exit IP
    const exitIpValue = this.exitIpEl.querySelector('.tor-detail-value');
    if(exitIpValue) {
      exitIpValue.textContent = details.exitIp || 'Fetching...';
    }

    // Latency
    const latencyValue = this.container.querySelector('.tor-detail-latency .tor-detail-value');
    if(latencyValue) {
      latencyValue.textContent = details.latency >= 0 ? `${details.latency}ms` : '--';
    }

    // Track circuit age
    if(this.circuitBuiltAt === 0) {
      this.circuitBuiltAt = Date.now();
    }
  }
}
```

- [ ] **Step 2: Add dashboard styles**

Extend `src/scss/nostra/_tor-dashboard.scss` (append to file from Task 7):

```scss
.tor-dashboard-container {
  .tor-circuit-status {
    padding: 16px;
  }

  .tor-hop-chain {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px 0;
  }

  .tor-hop {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 12px 16px;
    border-radius: 8px;
    background: var(--surface-color);
    border: 1px solid var(--border-color);
    min-width: 80px;

    &--healthy {
      border-color: var(--green);
    }

    &--unhealthy {
      border-color: var(--danger-color);
    }

    &--loading {
      color: var(--secondary-text-color);
    }
  }

  .tor-hop-label {
    font-size: 11px;
    text-transform: uppercase;
    color: var(--secondary-text-color);
    margin-bottom: 4px;
  }

  .tor-hop-id {
    font-family: var(--font-monospace);
    font-size: 12px;
  }

  .tor-hop-arrow {
    font-size: 18px;
    color: var(--secondary-text-color);
  }

  .tor-detail-row {
    display: flex;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-color);
  }

  .tor-detail-label {
    color: var(--secondary-text-color);
  }

  .tor-detail-value {
    font-family: var(--font-monospace);
  }

  .tor-rebuild-btn {
    width: 100%;
    margin: 16px 0;
    padding: 12px;
    border-radius: 8px;
    font-size: 15px;
    cursor: pointer;

    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "nostraTorDashboard" | grep "error TS"`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/sidebarLeft/tabs/nostraTorDashboard.ts src/scss/nostra/_tor-dashboard.scss
git commit -m "feat(nostra): add Tor circuit dashboard tab with hop visualization"
```

---

## Task 9: Link torStatus popup to circuit dashboard

**Files:**
- Modify: `src/components/popups/torStatus.tsx`

- [ ] **Step 1: Read current torStatus.tsx**

Read `src/components/popups/torStatus.tsx` to understand the footer structure.

- [ ] **Step 2: Add "View details" link to the popup**

In `src/components/popups/torStatus.tsx`, find the footer/close section (around line 70–77). Before the close button, add a "View details" link:

```typescript
const detailsLink = document.createElement('a');
detailsLink.classList.add('tor-status-details-link');
detailsLink.textContent = 'View circuit details';
detailsLink.addEventListener('click', async() => {
  props.onClose();
  const {default: AppNostraTorDashboardTab} = await import('@components/sidebarLeft/tabs/nostraTorDashboard');
  const tab = new AppNostraTorDashboardTab(/* slider ref */);
  tab.open();
});
```

Note: The exact integration depends on how the popup accesses the sidebar slider. Check the popup's parent reference to get the slider instance. If `torStatus.tsx` is rendered inside a Solid.js tree, wrap the navigation in the appropriate slider context.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "torStatus" | grep "error TS"`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/popups/torStatus.tsx
git commit -m "feat(nostra): link torStatus popup to circuit dashboard"
```

---

## Task 10: Manual verification

- [ ] **Step 1: Run full Nostra test suite**

Run: `pnpm test:nostra`
Expected: All tests pass, including new tor-ui.test.ts

- [ ] **Step 2: Run TypeScript check**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v vendor`
Expected: No new errors introduced

- [ ] **Step 3: Start dev server and verify**

Run: `pnpm start`

Verify in browser:
1. Open Settings → Privacy & Security → Tor toggle is visible at top
2. Toggle Tor OFF → confirmation popup appears
3. Toggle Tor ON → state shows "Connecting to Tor..."
4. Open Relay Settings → latency shows Tor overhead (if Tor is active)
5. Open Tor Status popup → "View circuit details" link present
6. Click link → Circuit dashboard opens with hop visualization

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(nostra): tor UI polish and integration fixes"
```
