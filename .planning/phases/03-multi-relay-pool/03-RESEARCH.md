# Phase 3: Multi-Relay Pool - Research

**Researched:** 2026-04-01
**Domain:** Nostr multi-relay messaging, Tor privacy transport, relay failover
**Confidence:** HIGH

## Summary

Phase 3 extends the existing relay pool (3 relays, basic add/remove) to a resilient 4+ relay pool with NIP-65 publishing, integrates the existing WebtorClient as a shared Tor transport for all relays, and adds user-facing UX for Tor status and relay management. The codebase already has strong foundations: `NostrRelayPool` with dedup/backfill/recovery, `WebtorClient` with full HTTP-via-Tor, and `OfflineQueue` for message queuing during connectivity gaps.

The key architectural challenge is that webtor-rs provides HTTP fetch only (no WebSocket tunneling) -- confirmed by the WASM type declarations. This means relay communication via Tor MUST use HTTP polling, while direct fallback uses native WebSocket. The PrivacyTransport currently wraps a single NostrRelay; it must be refactored to wrap the entire NostrRelayPool, sharing a single WebtorClient instance.

**Primary recommendation:** Refactor PrivacyTransport to wrap NostrRelayPool (not individual NostrRelay), introduce a dual-mode transport layer (HTTP polling via Tor OR WebSocket direct), add NIP-65 kind 10002 event publishing using nostr-tools finalizeEvent, and build the Tor status UX (shield icon + banners) using rootScope events.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Tor bootstrap UX: shield icon in topbar (grey=bootstrap, green=Tor active, orange=direct), bootstrap banner "Avvio di Tor..." under topbar, orange persistent banner in fallback mode with "Riprova Tor" button, green confirmation banner when Tor reconnects (fades after 3s), tap shield for detailed popup (Tor state, connected relays, per-relay latency)
- Tor fallback behavior: explicit user confirmation popup before switching to direct ("Tor non disponibile. Continuare con connessione diretta? Il tuo IP sara' visibile." with Riprova/Continua buttons), NO automatic fallback, messages queued in IndexedDB during bootstrap (no temp direct sending), per-message queue status icon (clock -> check)
- Relay defaults and management: 4+ hardcoded defaults + NIP-65 discovery from contacts, full CRUD UI (add/remove/enable-disable read-write per relay, "usa solo i miei relay" toggle), per-relay status indicator (green/red/yellow dot + latency ms + read/write toggle, real-time update), NIP-65 kind 10002 published at identity init + on relay list changes
- Pool + Tor integration: single shared WebtorClient for all relays, if Tor fails whole pool switches to direct (after user confirmation), WebSocket tunneling via Tor preferred but HTTP polling fallback if not supported, per-message queue status icons

### Claude's Discretion
- Choice of 4+ default relays (based on uptime, geo-distribution, NIP compatibility)
- Architecture for WebSocket tunneling via Tor (evaluate if webtor-rs supports it)
- HTTP polling interval as fallback if WebSocket via Tor not possible
- Relay discovery logic via NIP-65 of contacts
- Format and style of detailed Tor popup (content: state, relays, latency)
- Tor reconnection and circuit rotation strategy

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INF-03 | Multi-relay messaging with SimplePool across 4+ public Nostr relays | Existing NostrRelayPool supports 3 relays; add 4th default, pool already handles multi-relay publish/subscribe/dedup |
| INF-04 | Relay failover -- if primary relay is down, messaging continues via alternates | Pool recovery (60s interval) + reconnection backoff already exist; need to verify with manual block test |
| INF-06 | User's relay list published via NIP-65 (kind 10002) | NIP-65 is simple: kind 10002 event with "r" tags; use finalizeEvent from nostr-tools to sign+publish |
| PRIV-01 | Tor privacy via webtor-rs for relay HTTP polling (IP hidden from relays) | WebtorClient already implements Tor HTTP fetch; needs integration with pool instead of single relay |
| PRIV-02 | Tor bootstrap is progressive -- app interactive within 3s, Tor upgrades in background | WebtorClient.bootstrap() is async; app renders immediately, starts Tor in background with state callbacks |
| PRIV-03 | Fallback to direct WebSocket if Tor fails (with user notification) | User decision: explicit confirmation popup before fallback, never silent |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| nostr-tools | 2.23.3 | Event creation, signing (finalizeEvent), NIP-19 encoding | Already in project, used for event signing throughout |
| webtor-rs (WASM) | bundled | Tor HTTP fetch in browser via Snowflake WebRTC bridge | Already bundled in public/webtor/, project standard for Tor |
| @noble/secp256k1 | (bundled) | Key derivation, signing | Already used in nostr-relay.ts |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| solid-js (vendor fork) | custom | Reactive UI for Tor status, relay settings | All UI components |
| IndexedDB (native) | browser | Relay config persistence, offline queue | Already used in NostrRelayPool and OfflineQueue |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom relay pool | nostr-tools SimplePool | SimplePool is more feature-complete but project already has custom pool with dedup/backfill integrated; extending existing pool is lower risk |
| NDK (nostr-dev-kit) | N/A | Heavyweight SDK, pulls in many deps; project pattern is minimal custom code with nostr-tools for signing |

**Installation:**
No new packages needed. All dependencies already installed.

## Architecture Patterns

### Recommended Project Structure
```
src/lib/nostra/
  nostr-relay-pool.ts        # [MODIFY] Add 4th relay, relay enable/disable, latency tracking
  nostr-relay.ts             # [MODIFY] Add HTTP polling mode (for Tor), latency measurement
  privacy-transport.ts       # [REWRITE] Wrap NostrRelayPool (not single relay), shared WebtorClient
  webtor-fallback.ts         # [KEEP] Already complete
  offline-queue.ts           # [KEEP] Reuse for Tor bootstrap queue
  nip65.ts                   # [NEW] NIP-65 kind 10002 publish/parse logic
  relay-discovery.ts         # [NEW] Discover relays from contacts' NIP-65

src/components/
  torShield.tsx              # [NEW] Shield icon component with state colors
  torBanner.tsx              # [NEW] Bootstrap/fallback banner component
  popups/torStatus.tsx       # [NEW] Detailed Tor status popup
  sidebarLeft/tabs/
    nostraRelaySettings.ts # [MODIFY] Add CRUD, latency, read/write toggles, status dots
```

### Pattern 1: Dual-Mode Relay Transport
**What:** Each relay connection supports two modes: WebSocket (direct) or HTTP polling (via Tor). The pool manages which mode is active based on Tor availability.
**When to use:** Always -- this is the core transport architecture.
**Example:**
```typescript
// NostrRelay gains a mode parameter
class NostrRelay {
  private mode: 'websocket' | 'http-polling' = 'websocket';
  private torFetchFn?: (url: string, opts?: RequestInit) => Promise<string>;

  setTorMode(fetchFn: (url: string) => Promise<string>): void {
    this.mode = 'http-polling';
    this.torFetchFn = fetchFn;
    // Close existing WebSocket if open
    if(this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  setDirectMode(): void {
    this.mode = 'websocket';
    this.torFetchFn = undefined;
    this.connect(); // Re-establish WebSocket
  }
}
```

### Pattern 2: Shared WebtorClient via PrivacyTransport
**What:** Single WebtorClient instance bootstrapped once, passed to all relay entries via fetchFn injection.
**When to use:** Tor transport initialization.
**Example:**
```typescript
class PrivacyTransport {
  private webtorClient: WebtorClient;
  private relayPool: NostrRelayPool;

  async bootstrap(): Promise<void> {
    // App is interactive immediately (PRIV-02)
    this.setState('bootstrapping');

    try {
      await this.webtorClient.bootstrap(60000);
      // Switch all relays to HTTP polling via Tor
      const fetchFn = (url: string) => this.webtorClient.fetch(url);
      this.relayPool.setTorMode(fetchFn);
      this.setState('tor-active');
    } catch {
      // Show confirmation popup -- do NOT auto-fallback
      this.setState('tor-failed');
      // User must explicitly confirm direct mode
    }
  }
}
```

### Pattern 3: rootScope Events for Tor/Relay State
**What:** Add nostra-specific events to BroadcastEvents for UI reactivity.
**When to use:** All Tor status changes, relay connection changes.
**Example:**
```typescript
// Add to BroadcastEvents in rootScope.ts:
'nostra_tor_state': {state: 'bootstrapping' | 'active' | 'direct' | 'failed', error?: string},
'nostra_relay_state': {url: string, connected: boolean, latencyMs: number},
'nostra_relay_list_changed': RelayConfig[],
'nostra_message_queued': {messageId: string, status: 'queued' | 'sent'},
```

### Pattern 4: NIP-65 Relay List Publishing
**What:** Publish kind 10002 replaceable event with relay list whenever user modifies relays or at identity init.
**When to use:** Identity initialization, relay list CRUD operations.
**Example:**
```typescript
// Source: NIP-65 spec (https://github.com/nostr-protocol/nips/blob/master/65.md)
import {finalizeEvent} from 'nostr-tools/pure';

function createNip65Event(relays: RelayConfig[], privateKey: Uint8Array) {
  const tags = relays.map(r => {
    if(r.read && r.write) return ['r', r.url];
    if(r.read) return ['r', r.url, 'read'];
    return ['r', r.url, 'write'];
  });

  return finalizeEvent({
    kind: 10002,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: ''
  }, privateKey);
}
```

### Anti-Patterns to Avoid
- **Multiple WebtorClient instances:** Each instance creates a separate Tor circuit via Snowflake. One shared client for the entire pool.
- **Auto-fallback to direct without consent:** User explicitly decided this is forbidden. Always show confirmation popup.
- **WebSocket via Tor:** webtor-rs has NO WebSocket support (confirmed from WASM types). Do not attempt to tunnel WebSocket through Tor; use HTTP polling exclusively.
- **Blocking app startup on Tor:** App must be interactive within 3s. Tor bootstrap (60s+) runs in background.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Event signing | Custom secp256k1 signing | `finalizeEvent` from nostr-tools/pure | Handles id computation, signing, serialization correctly |
| Nostr event verification | Custom sig verification | nostr-tools verifyEvent | Edge cases in signature normalization |
| Dedup cache | Custom Set with manual eviction | Existing LRU in NostrRelayPool | Already built and tested (seenIds + seenOrder) |
| Offline message queue | New queue system | Existing OfflineQueue class | Already has IndexedDB persistence, per-peer queuing, flush logic |
| Tor HTTP transport | Custom fetch wrapper | Existing WebtorClient.fetch() | Already handles circuit management, Snowflake bridge |

**Key insight:** Most infrastructure already exists. This phase is primarily about wiring existing pieces together (pool + Tor + queue) and adding UI/UX.

## Common Pitfalls

### Pitfall 1: HTTP Polling Rate vs Relay Rate Limits
**What goes wrong:** Polling too aggressively (e.g., every 1s) per relay causes rate limiting or bans from public relays.
**Why it happens:** With 4+ relays each being polled, total request volume is 4x the per-relay rate.
**How to avoid:** Use 3-5 second polling interval per relay (existing WebtorClient uses 2s, increase to 3s). Stagger polls across relays to avoid burst. Track 429 responses and back off.
**Warning signs:** Relay returns HTTP 429, connection refused, or empty responses.

### Pitfall 2: Tor Bootstrap Blocking User Interaction
**What goes wrong:** If Tor bootstrap is awaited before showing UI, app appears frozen for 30-60+ seconds.
**Why it happens:** Snowflake WebRTC bridge negotiation and circuit establishment are slow.
**How to avoid:** Fire-and-forget bootstrap. App renders immediately. Queue messages during bootstrap. Show progress banner.
**Warning signs:** First meaningful paint > 3 seconds.

### Pitfall 3: NIP-65 Event Replaced by Old Version
**What goes wrong:** Kind 10002 is a replaceable event (NIP-01: kinds 10000-19999). If an older signed event has a newer created_at, it replaces the user's current relay list.
**Why it happens:** Clock skew, or publishing from multiple clients.
**How to avoid:** Always use Math.floor(Date.now() / 1000) for created_at. Before publishing, query existing kind 10002 and ensure new event has strictly newer timestamp.
**Warning signs:** Relay list reverts after being updated.

### Pitfall 4: Direct Fallback Without User Consent
**What goes wrong:** If the fallback logic triggers automatically, user's IP is exposed to relay operators without their knowledge.
**Why it happens:** Developer convenience -- easier to auto-fallback than show a popup.
**How to avoid:** User decision is explicit: popup with Riprova/Continua. Never auto-switch. During bootstrap, messages queue locally (OfflineQueue).
**Warning signs:** Messages being sent while Tor is bootstrapping.

### Pitfall 5: Relay Discovery Infinite Loop
**What goes wrong:** Discovering relays from contacts' NIP-65, then connecting to those relays, discovering more contacts, connecting to more relays...
**Why it happens:** No bound on discovery depth.
**How to avoid:** Cap discovered relays (e.g., max 8 total). Only discover from direct contacts, not contacts-of-contacts. User has "use only my relays" toggle.
**Warning signs:** Connection count growing unbounded, memory usage increasing.

### Pitfall 6: Pool Recovery Reconnects During Tor Bootstrap
**What goes wrong:** The 60-second pool recovery timer tries to reconnect failed relays via WebSocket while Tor is still bootstrapping.
**Why it happens:** Recovery logic doesn't know about Tor state.
**How to avoid:** Pool recovery must respect current transport mode. If in Tor mode but Tor is not ready, don't attempt reconnection. If in direct mode (user confirmed), reconnect via WebSocket.
**Warning signs:** WebSocket connections appearing during Tor bootstrap phase.

## Code Examples

### NIP-65 Kind 10002 Event Publishing
```typescript
// Source: NIP-65 spec https://github.com/nostr-protocol/nips/blob/master/65.md
import {finalizeEvent} from 'nostr-tools/pure';
import {RelayConfig} from './nostr-relay-pool';

export const NOSTR_KIND_RELAY_LIST = 10002;

export function buildNip65Event(
  relays: RelayConfig[],
  privateKey: Uint8Array
): any {
  const tags: string[][] = [];

  for(const relay of relays) {
    if(relay.read && relay.write) {
      tags.push(['r', relay.url]);
    } else if(relay.read) {
      tags.push(['r', relay.url, 'read']);
    } else if(relay.write) {
      tags.push(['r', relay.url, 'write']);
    }
  }

  const event = finalizeEvent({
    kind: NOSTR_KIND_RELAY_LIST,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: ''
  }, privateKey);

  return event;
}

export function parseNip65Event(event: {tags: string[][]}): RelayConfig[] {
  const relays: RelayConfig[] = [];

  for(const tag of event.tags) {
    if(tag[0] !== 'r' || !tag[1]) continue;

    const url = tag[1];
    const marker = tag[2];

    if(marker === 'read') {
      relays.push({url, read: true, write: false});
    } else if(marker === 'write') {
      relays.push({url, read: false, write: true});
    } else {
      relays.push({url, read: true, write: true});
    }
  }

  return relays;
}
```

### Latency Measurement for Relay
```typescript
// Ping relay by sending a short-lived REQ and timing EOSE response
async measureLatency(): Promise<number> {
  if(this.mode === 'http-polling' && this.torFetchFn) {
    const start = performance.now();
    try {
      const httpsUrl = this.relayUrl.replace('wss://', 'https://');
      await this.torFetchFn(`${httpsUrl}/`);
      return Math.round(performance.now() - start);
    } catch {
      return -1; // unreachable
    }
  }

  if(this.connectionState !== 'connected' || !this.ws) return -1;

  const start = performance.now();
  const pingId = `ping-${Date.now()}`;

  return new Promise<number>((resolve) => {
    const timeout = setTimeout(() => resolve(-1), 5000);

    const origHandler = this.ws!.onmessage;
    this.ws!.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if(msg[0] === 'EOSE' && msg[1] === pingId) {
          clearTimeout(timeout);
          this.ws!.onmessage = origHandler;
          resolve(Math.round(performance.now() - start));
          return;
        }
      } catch {}
      origHandler?.call(this.ws, event);
    };

    this.ws!.send(JSON.stringify(['REQ', pingId, {kinds: [0], limit: 0}]));
  });
}
```

### Tor State rootScope Events
```typescript
// Add to BroadcastEvents type:
'nostra_tor_state': {
  state: 'bootstrapping' | 'active' | 'direct' | 'failed';
  error?: string;
};
'nostra_relay_state': {
  url: string;
  connected: boolean;
  latencyMs: number;
  read: boolean;
  write: boolean;
};

// Dispatch from PrivacyTransport:
rootScope.dispatchEvent('nostra_tor_state', {
  state: 'active'
});
```

## Recommended Default Relays

Based on ecosystem analysis for uptime, geo-distribution, and NIP compatibility:

| Relay | Region | Why |
|-------|--------|-----|
| wss://relay.damus.io | US (West) | Already in project, high uptime, widely used |
| wss://nos.lol | US (East) | Already in project, popular, reliable |
| wss://relay.snort.social | EU | Already in project, good NIP support |
| wss://relay.nostr.band | EU | High uptime, NIP-65 support, search capabilities |

**Confidence:** MEDIUM -- relay uptime varies; recommend users add their preferred relays.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| NIP-04 (AES-CBC) | NIP-44 (ChaCha20-Poly1305) | 2024 | Already migrated in Phase 2 |
| Single relay | Multi-relay pool | NIP-65 (2022) | Standard for resilient messaging |
| Kind 4 DMs | NIP-17 gift-wrap (kind 14) | 2024 | Phase 4 scope, not Phase 3 |

**Deprecated/outdated:**
- NIP-04 encryption: Fully removed in Phase 2, all crypto uses NIP-44
- SimplePool from nostr-tools: Not needed since project has custom pool with dedup; SimplePool lacks Tor integration hooks

## WebSocket via Tor: NOT POSSIBLE

**Finding (HIGH confidence):** webtor-rs WASM exposes only HTTP methods: `fetch(url)`, `post(url, body)`, `postJson(url, json)`, `request(method, url, headers, body, timeout)`. There is no WebSocket API. The WASM type declarations (`public/webtor/webtor_wasm.d.ts`) confirm this definitively.

**Recommendation:** Use HTTP polling via Tor exclusively. Polling interval of 3 seconds (current WebtorClient default is 2s, slightly increase to reduce relay load across 4+ relays). When user confirms direct fallback, switch to native WebSocket for real-time messaging.

## Open Questions

1. **HTTP API support across relays**
   - What we know: NIP-01 defines WebSocket as the standard protocol. Some relays expose HTTP endpoints, but not all.
   - What's unclear: Whether relay.damus.io, nos.lol, relay.snort.social, and relay.nostr.band all support HTTP GET queries for events.
   - Recommendation: Test each relay's HTTP endpoint. If a relay doesn't support HTTP, it can only be used in direct (WebSocket) mode. Document which relays work with Tor polling. As a fallback, use the relay's WebSocket URL with query parameters (some relay implementations support this).

2. **Tor circuit rotation strategy**
   - What we know: webtor-rs has `updateCircuit(deadline_ms)` method.
   - What's unclear: Optimal rotation interval for privacy vs performance.
   - Recommendation: Rotate every 10 minutes (standard Tor recommendation). Use circuit health polling (already in WebtorClient, 10s interval) to detect degraded circuits and rotate early.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (latest, via pnpm) |
| Config file | vitest implicit in vite.config.ts |
| Quick run command | `pnpm test src/tests/nostra/` |
| Full suite command | `pnpm test` |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INF-03 | Pool connects to 4+ relays, publishes to all write relays | unit | `pnpm test src/tests/nostra/nostr-relay-pool.test.ts -x` | Exists (extend) |
| INF-04 | With one relay blocked, messages still deliver via alternates | unit | `pnpm test src/tests/nostra/relay-failover.test.ts -x` | Wave 0 |
| INF-06 | NIP-65 kind 10002 event published at init + on relay change | unit | `pnpm test src/tests/nostra/nip65.test.ts -x` | Wave 0 |
| PRIV-01 | HTTP polling via Tor for all relays in pool | unit | `pnpm test src/tests/nostra/privacy-transport.test.ts -x` | Wave 0 |
| PRIV-02 | App interactive within 3s, Tor bootstraps in background | unit | `pnpm test src/tests/nostra/tor-bootstrap.test.ts -x` | Wave 0 |
| PRIV-03 | Fallback to direct only after user confirmation | unit | `pnpm test src/tests/nostra/tor-fallback-confirm.test.ts -x` | Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test src/tests/nostra/ -x`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/tests/nostra/nip65.test.ts` -- covers INF-06 (kind 10002 build/parse/publish)
- [ ] `src/tests/nostra/relay-failover.test.ts` -- covers INF-04 (one relay down, messages still deliver)
- [ ] `src/tests/nostra/privacy-transport.test.ts` -- covers PRIV-01 (pool-level Tor HTTP polling)
- [ ] `src/tests/nostra/tor-bootstrap.test.ts` -- covers PRIV-02 (progressive bootstrap, app interactive)
- [ ] `src/tests/nostra/tor-fallback-confirm.test.ts` -- covers PRIV-03 (no auto-fallback, user confirmation)
- [ ] Extend `src/tests/nostra/nostr-relay-pool.test.ts` -- covers INF-03 (4+ relays, enable/disable)

## Sources

### Primary (HIGH confidence)
- webtor-rs WASM type declarations (`public/webtor/webtor_wasm.d.ts`) -- confirmed HTTP-only, no WebSocket tunneling
- NIP-65 spec via Context7 `/nostr-protocol/nips` -- kind 10002 event structure with r tags
- nostr-tools 2.23.3 type declarations (`node_modules/nostr-tools/lib/types/`) -- SimplePool API, finalizeEvent
- Existing codebase: nostr-relay-pool.ts, nostr-relay.ts, privacy-transport.ts, webtor-fallback.ts, offline-queue.ts

### Secondary (MEDIUM confidence)
- Default relay selection (relay.damus.io, nos.lol, relay.snort.social, relay.nostr.band) -- based on ecosystem usage patterns; [nostr.watch](https://nostr.co.uk/relays/) for uptime monitoring

### Tertiary (LOW confidence)
- HTTP API availability per relay -- needs runtime verification; not all Nostr relays expose HTTP endpoints

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- all libraries already in project, versions confirmed from package.json/node_modules
- Architecture: HIGH -- existing code thoroughly reviewed, integration points clear
- Pitfalls: HIGH -- derived from codebase analysis and webtor-rs API constraints
- Relay defaults: MEDIUM -- uptime data is dynamic; relay.nostr.band is recommended but needs verification
- HTTP polling feasibility: MEDIUM -- depends on per-relay HTTP endpoint support

**Research date:** 2026-04-01
**Valid until:** 2026-05-01 (30 days -- stable domain, relay ecosystem changes slowly)
