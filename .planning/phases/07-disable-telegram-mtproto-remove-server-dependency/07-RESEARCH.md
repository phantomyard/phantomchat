# Phase 7: Disable Telegram MTProto & Remove Server Dependency - Research

**Researched:** 2026-04-02
**Domain:** MTProto protocol stubbing, connection status remapping, boot path decoupling
**Confidence:** HIGH

## Summary

Phase 7 eliminates all Telegram MTProto connections from Nostra.chat. The app currently has a mature MTProto implementation (`src/lib/mtproto/`) with networkers, authorizers, transport layers, and DC configurators that establish WebSocket/HTTP connections to Telegram servers at startup. The existing `api-manager-stub.ts` already intercepts three `invokeApi()` methods for P2P routing -- this phase extends that pattern to reject ALL non-intercepted MTProto methods, stubs the transport and networker layer to prevent connection attempts, and remaps `ConnectionStatusComponent` from MTProto DC status to Nostr relay pool status.

The codebase has clear seams for stubbing: `NetworkerFactory.getNetworker()` is the single creation point for all `MTPNetworker` instances, `ApiManager.invokeApi()` is the single entry point for all MTProto API calls, and `rootScope` already carries `nostra_relay_state` events from Phase 3. The boot path (`apiManagerProxy.loadAllStates()`/`sendAllStates()`) already works with IndexedDB via `loadStateForAllAccountsOnce()` -- the `sendAllStates()` sends state to the SharedWorker via `MTProtoMessagePort`, which must continue but without triggering MTProto connections on the worker side.

**Primary recommendation:** Stub at the `NetworkerFactory` level (prevent `MTPNetworker` creation) + extend `api-manager-stub.ts` to reject all non-intercepted methods + swap `ConnectionStatusComponent` data source to `nostra_relay_state` events.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** Replace `src/lib/mtproto/` internals (networker, authorizer, transports) with minimal no-op stubs that maintain the same interfaces but never open network connections. The 55+ AppManagers that depend on these interfaces continue to compile without changes.
- **D-02:** `invokeApi()` stub rejects with a clear error (`MTProto disabled`) for any non-intercepted method. Methods already routed through `api-manager-stub.ts` (messages, users) continue working via Nostra.chat bridge.
- **D-03:** Do NOT delete `src/lib/mtproto/` files or remove dead code in this phase. Stub-out only. Full cleanup is a separate future effort.
- **D-04:** Repurpose `ConnectionStatusComponent` to show Nostr relay pool connection status instead of MTProto DC status. Reuse the existing component, change the data source from `networkerFactory` to relay pool state.
- **D-05:** Auto-reconnect is silent -- status bar shows "Reconnecting..." only when ALL relays are down. Individual relay disconnect/reconnect is handled silently in background, consistent with Phase 3 behavior.
- **D-06:** `apiManagerProxy` keeps its interface but `loadAllStates`/`sendAllStates` work only with local IndexedDB (already used for Nostr identity/keys). SharedWorker continues to function for UI coordination but makes no MTProto calls.
- **D-07:** The boot path in `index.ts` remains structurally the same -- `apiManagerProxy.sendEnvironment()`, `loadAllStates()`, etc. -- but these now resolve immediately or work against local storage.
- **D-08:** Scope is strictly "zero Telegram connections" -- stub MTProto, remap ConnectionStatus, stub apiManagerProxy. No dead code removal, no type migration.
- **D-09:** `layer.d.ts` (664KB MTProto types) is kept. Hundreds of components import `Message`, `Chat`, `User`, `InputPeer` from `@layer`. Replacing these types is a massive effort deferred to future cleanup.

### Claude's Discretion
- Exact stub implementation details for `networkerFactory`, `apiManager`, and transport layer
- How to wire relay pool status events into `ConnectionStatusComponent` (likely via existing `rootScope` relay events from Phase 3)
- Whether to stub at the `NetworkerFactory` level or deeper in individual networker/transport classes

### Deferred Ideas (OUT OF SCOPE)
- Full MTProto code removal -- delete `src/lib/mtproto/`, remove dead manager methods, tree-shake unused code
- Native Nostra.chat types -- replace `@layer` imports (Message, Chat, User, etc.) with Nostra.chat-native type definitions
- SharedWorker simplification -- remove MTProto worker threads, simplify to UI-only worker
- Bundle size optimization -- removing `schema.ts` (505KB) and `layer.d.ts` (664KB) from the build
</user_constraints>

## Architecture Patterns

### Stubbing Strategy: NetworkerFactory Level (Recommended)

**What:** Stub `NetworkerFactory.getNetworker()` to return a no-op networker that never opens connections. This is the highest-leverage intervention point because ALL `MTPNetworker` instances are created through this single factory method (line 44-71 of `networkerFactory.ts`).

**Why not deeper:** Stubbing individual transports (websocket.ts, tcpObfuscated.ts, http.ts) requires modifying 11 files. Stubbing at factory level requires modifying 1 file plus the `invokeApi()` rejection logic.

**Pattern:**
```typescript
// In networkerFactory.ts - replace getNetworker
public getNetworker(options: any): MTPNetworker {
  // Return a minimal no-op networker that:
  // 1. Never opens a transport connection
  // 2. Has all expected methods as no-ops
  // 3. Reports ConnectionStatus.Closed immediately
  throw new Error('MTProto disabled - NetworkerFactory.getNetworker() stubbed');
}
```

However, since `ApiManager.invokeApi()` calls `this.getNetworker()` internally to get a networker before sending, the cleaner approach is:

### Pattern 1: invokeApi() Full Rejection

**What:** Modify `api-manager-stub.ts` to intercept ALL `invokeApi()` calls, not just the three P2P methods. Non-intercepted methods reject with `MTProto disabled` error.

**Current state of api-manager-stub.ts:**
- Already monkey-patches `apiManager.invokeApi()` at module load time (line 211)
- Routes `messages.getHistory`, `users.getFullUser` to Nostra.chat bridge
- Falls through to original `invokeApi()` for everything else (line 178)

**Change needed:** Replace the fall-through (line 178) with an explicit rejection:
```typescript
// Instead of: return stub._original!(method, ...args);
// Use:
console.warn(`[Nostra.chat] MTProto disabled: ${method} rejected`);
return Promise.reject(makeError('MTPROTO_DISABLED', `Method ${method} is not available - MTProto disabled`));
```

**When to use:** This is the primary gate. Every MTProto call goes through `invokeApi()`.

### Pattern 2: NetworkerFactory No-Op Stub

**What:** Make `NetworkerFactory.getNetworker()` a no-op that never creates `MTPNetworker` instances. This prevents any accidental network connections even if `invokeApi()` stub is somehow bypassed.

**Defense in depth:** Even though `invokeApi()` rejection should catch everything, managers call `networkerFactory.forceReconnect()`, `startAll()`, `stopAll()` -- these must also be no-ops.

```typescript
// networkerFactory.ts modifications
public getNetworker(options: any) {
  // No-op: do not create MTPNetworker
  return null as any; // Never called if invokeApi rejects first
}

public startAll() { /* no-op */ }
public stopAll() { /* no-op */ }
public forceReconnect() { /* no-op */ }
public forceReconnectTimeout() { /* no-op */ }
```

### Pattern 3: ConnectionStatus Remapping

**What:** Replace `ConnectionStatusComponent`'s data source from MTProto DC status to Nostr relay pool status.

**Current flow:**
1. `networkerFactory.onConnectionStatus` dispatches `connection_status_change` on `rootScope` (networkerFactory.ts:61)
2. `rootScope` stores it in `this.connectionStatus[status.name]` (rootScope.ts:303-305)
3. `ConnectionStatusComponent` reads via `rootScope.managers.rootScope.getConnectionStatus()` (connectionStatus.ts:107)
4. It looks up `connectionStatus['NET-' + baseDcId]` for the current DC (connectionStatus.ts:117)

**New flow:**
1. `NostrRelayPool` already dispatches `nostra_relay_state` events on `rootScope` (nostr-relay-pool.ts:574)
2. `ConnectionStatusComponent` listens to `nostra_relay_state` instead of `connection_status_change`
3. Aggregate relay states: connected = at least 1 relay connected; reconnecting = all relays disconnected

**Key mapping:**
| MTProto Status | Nostr Relay Equivalent |
|----------------|------------------------|
| `ConnectionStatus.Connected` | At least 1 relay connected |
| `ConnectionStatus.Connecting` | All relays disconnected, attempting reconnect |
| `ConnectionStatus.Closed` | All relays disconnected |
| `ConnectionStatus.TimedOut` | All relays failed after timeout |

### Pattern 4: Boot Path Stubbing

**What:** `apiManagerProxy.sendAllStates()` sends state to SharedWorker via `this.invoke('state', ...)`. The worker side uses this to initialize managers, which may trigger MTProto connections (e.g., `apiUpdatesManager` starts polling).

**Current flow:**
1. `loadAllStates()` calls `loadStateForAllAccountsOnce()` -- reads IndexedDB, no MTProto (safe as-is)
2. `sendAllStates()` calls `this.invoke('state', ...)` -- sends to SharedWorker
3. Worker receives state, initializes managers, some managers call `invokeApi()` to sync

**With stubs:** Step 3 is safe because `invokeApi()` now rejects. But managers may error or retry. The `apiUpdatesManager.forceGetDifference()` call in `ConnectionStatusComponent` (line 121) must be no-op'd or guarded.

### Anti-Patterns to Avoid
- **Deleting MTProto files:** D-03 explicitly forbids this. Stub only.
- **Modifying 55+ manager files:** Managers should continue to compile and call `invokeApi()` -- the stub rejects at runtime, not compile time.
- **Breaking the SharedWorker:** The worker must still boot and handle UI coordination tasks. Only MTProto network calls are disabled.
- **Suppressing all errors:** The `MTProto disabled` rejection should be logged clearly so developers know what is being blocked.

## Recommended Project Structure

No new directories needed. Changes are localized to existing files:

```
src/
├── lib/
│   ├── nostra/
│   │   └── api-manager-stub.ts    # MODIFY: reject all non-intercepted methods
│   ├── appManagers/
│   │   ├── networkerFactory.ts    # MODIFY: no-op all methods
│   │   └── apiManager.ts          # MODIFY: guard invokeApi to never create networkers
│   └── mtproto/
│       └── (untouched per D-03)
├── components/
│   └── connectionStatus.ts        # MODIFY: swap data source to relay pool
└── tests/
    └── nostra/
        └── mtproto-stub.test.ts   # NEW: verify no connections, rejection behavior
```

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Connection status aggregation | Custom relay polling logic | Existing `nostra_relay_state` rootScope events | Already dispatched by Phase 3 NostrRelayPool |
| API method interception | New proxy/middleware layer | Extend existing `api-manager-stub.ts` monkey-patch | Established pattern, already tested |
| Boot state loading | New IndexedDB abstraction | Existing `loadStateForAllAccountsOnce()` | Already works with IndexedDB, no MTProto dependency |

## Common Pitfalls

### Pitfall 1: Managers Calling invokeApi() During Initialization
**What goes wrong:** Many AppManagers call `invokeApi()` in their `after()` method (post-state-load initialization). With the stub rejecting, these will throw unhandled promise rejections.
**Why it happens:** Managers like `apiUpdatesManager`, `appLangPackManager`, `appStickersManager` poll Telegram on startup.
**How to avoid:** Ensure rejection errors are caught gracefully. The existing `api-manager-stub.ts` pattern returns `Promise.reject()` which managers should already handle (they have `.catch()` handlers for network errors). Monitor console for uncaught rejections during testing.
**Warning signs:** Console flooded with "Unhandled promise rejection" errors on app start.

### Pitfall 2: forceGetDifference() in ConnectionStatusComponent
**What goes wrong:** `ConnectionStatusComponent.setConnectionStatus()` calls `this.managers.apiUpdatesManager.forceGetDifference()` when transitioning from disconnected to connected (line 121). This triggers an `invokeApi('updates.getDifference')` call.
**Why it happens:** Original code syncs MTProto state on reconnect.
**How to avoid:** Remove or guard this call. When relay connects, there's no MTProto difference to fetch.
**Warning signs:** Error on relay reconnect: "MTProto disabled: updates.getDifference rejected".

### Pitfall 3: sendEnvironment() Sending to Dead Worker
**What goes wrong:** `apiManagerProxy.sendEnvironment()` calls `this.invoke('environment', ENVIRONMENT)` which sends to the SharedWorker. If the worker-side handler tries to pass environment to MTProto networkers, it errors.
**Why it happens:** The worker-side code uses environment info to configure DC connections.
**How to avoid:** The worker still boots -- the `invoke('environment')` is fine as long as the worker-side doesn't trigger connections. With `NetworkerFactory` stubbed, no connections will be attempted.
**Warning signs:** Errors in SharedWorker console about missing networker methods.

### Pitfall 4: baseDcId Dependency in ConnectionStatus
**What goes wrong:** `ConnectionStatusComponent` calls `rootScope.managers.apiManager.getBaseDcId()` and looks up `connectionStatus['NET-' + baseDcId]`. With no MTProto, `baseDcId` may be undefined and `connectionStatus` empty.
**Why it happens:** The old flow depends on MTProto DC concepts.
**How to avoid:** When remapping to relay status, remove the `baseDcId` dependency entirely. Use a fixed key like `'RELAY-POOL'` or aggregate directly from relay state events.

### Pitfall 5: apiManagerProxy extends MTProtoMessagePort
**What goes wrong:** `ApiManagerProxy` extends `MTProtoMessagePort` (line 124 of apiManagerProxy.ts). The class name suggests deep MTProto coupling.
**Why it happens:** The SharedWorker communication channel is named MTProtoMessagePort but is really a generic message port.
**How to avoid:** Don't rename or restructure -- per D-03, no refactoring. The class continues to work for generic message passing. Just ensure the worker-side handlers for 'state' and 'environment' messages don't trigger MTProto connections.

### Pitfall 6: randomlyChooseVersionFromSearch() in index.ts
**What goes wrong:** This function (line 83-99) redirects to `web.telegram.org/a/` for some search engine visitors.
**Why it happens:** Legacy Telegram web client behavior.
**How to avoid:** This should be removed or disabled as part of this phase since Nostra.chat is not Telegram. But per D-08, scope is strictly connection disabling. Flag for the planner but don't block on it.

## Code Examples

### Example 1: api-manager-stub.ts Rejection for All Non-Intercepted Methods

```typescript
// Source: existing api-manager-stub.ts pattern, extended
(apiManager as any).invokeApi = async function<T extends InvokeApiMethod>(
  method: T,
  ...args: [MethodDeclMap[T]['req']?, InvokeApiOptions?]
): Promise<any> {
  const [req] = args as [any, InvokeApiOptions?];

  // --- P2P intercepted methods (existing) ---
  if(method === 'messages.getHistory') {
    // ... existing Nostra.chat bridge routing ...
  }

  if(method === 'users.getFullUser') {
    // ... existing Nostra.chat bridge routing ...
  }

  // --- ALL other methods: reject ---
  console.warn(`[Nostra.chat] MTProto disabled: ${method} rejected`);
  return Promise.reject({
    type: 'MTPROTO_DISABLED',
    code: 503,
    description: `Method ${method} is not available - MTProto connections disabled`
  });
};
```

### Example 2: NetworkerFactory No-Op Stub

```typescript
// Source: networkerFactory.ts, modified
export class NetworkerFactory extends AppManager {
  private networkers: MTPNetworker[] = [];
  public language = navigator.language || App.langPackCode;
  public updatesProcessor: (obj: any) => void = null;
  public akStopped = false;

  constructor() {
    super();
    this.name = 'NET-FACTORY';
  }

  public removeNetworker(_networker: MTPNetworker) { /* no-op */ }
  public setUpdatesProcessor(callback: (obj: any) => void) {
    this.updatesProcessor = callback;
  }

  public getNetworker(_options: any): MTPNetworker {
    throw new Error('[Nostra.chat] MTProto disabled: cannot create networker');
  }

  public startAll() { /* no-op */ }
  public stopAll() { /* no-op */ }
  public forceReconnect() { /* no-op */ }
  public forceReconnectTimeout() { /* no-op */ }
}
```

### Example 3: ConnectionStatusComponent Relay Remapping

```typescript
// Source: connectionStatus.ts, modified construct()
rootScope.addEventListener('nostra_relay_state', (relayState) => {
  this.setRelayConnectionStatus();
});

// Replace setConnectionStatus with relay-aware version
private setRelayConnectionStatus = () => {
  // Aggregate: connected if ANY relay is connected
  // Per D-05: show reconnecting only when ALL relays down
  const relayStates = rootScope.managers?.nostraRelayPool?.getRelayStates?.() ?? [];
  const anyConnected = relayStates.some(r => r.connected);
  const allDown = relayStates.length > 0 && relayStates.every(r => !r.connected);

  if(this.setFirstConnectionTimeout) {
    clearTimeout(this.setFirstConnectionTimeout);
    this.setFirstConnectionTimeout = 0;
  }

  if(anyConnected && !this.hadConnect) {
    this.hadConnect = true;
  }

  this.connecting = !anyConnected;
  this.timedOut = false;
  this.setState();
};
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| MTProto DC connection status | Nostr relay pool status | Phase 7 | ConnectionStatusComponent data source swap |
| `invokeApi()` falls through to MTProto | `invokeApi()` rejects non-intercepted methods | Phase 7 | No silent network connections |
| `NetworkerFactory` creates real networkers | `NetworkerFactory` is no-op | Phase 7 | Zero transport connections |

## Open Questions

1. **SharedWorker-side state initialization**
   - What we know: `sendAllStates()` sends state to worker, worker initializes managers
   - What's unclear: Which worker-side manager initializations trigger `invokeApi()` calls? Do they all handle rejection gracefully?
   - Recommendation: Test boot path end-to-end, catch and suppress expected rejections

2. **apiUpdatesManager subscription polling**
   - What we know: This manager polls for updates via `invokeApi('updates.getState')` and `invokeApi('updates.getDifference')`
   - What's unclear: Does it retry indefinitely on failure, potentially causing a rejection loop?
   - Recommendation: Either stub `apiUpdatesManager.forceGetDifference()` to no-op, or ensure the retry logic backs off after N failures

3. **singleInstance tab coordination**
   - What we know: `singleInstance` uses SharedWorker for multi-tab coordination
   - What's unclear: Does tab activation/deactivation trigger MTProto reconnection?
   - Recommendation: With `NetworkerFactory` stubbed, any reconnection attempts are no-ops. Monitor for errors.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (latest, configured in vite.config.ts) |
| Config file | vite.config.ts (test section) |
| Quick run command | `pnpm test src/tests/nostra/mtproto-stub.test.ts` |
| Full suite command | `pnpm test` |

### Phase Requirements -> Test Map

Phase 7 has no formal requirement IDs (infrastructure cleanup). Success criteria serve as requirements:

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SC-01 | App starts without MTProto connections | unit | `pnpm test src/tests/nostra/mtproto-stub.test.ts` | No - Wave 0 |
| SC-02 | ConnectionStatus shows relay pool status | unit | `pnpm test src/tests/nostra/mtproto-stub.test.ts` | No - Wave 0 |
| SC-03 | invokeApi() rejects non-intercepted methods | unit | `pnpm test src/tests/nostra/mtproto-stub.test.ts` | No - Wave 0 |
| SC-04 | apiManagerProxy works with local IndexedDB | unit | `pnpm test src/tests/nostra/mtproto-stub.test.ts` | No - Wave 0 |
| SC-05 | All existing tests pass | regression | `pnpm test` | Yes |

### Sampling Rate
- **Per task commit:** `pnpm test src/tests/nostra/mtproto-stub.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/tests/nostra/mtproto-stub.test.ts` -- covers SC-01 through SC-04 (new file)
- [ ] Verify existing test suite does not depend on real MTProto initialization

## Sources

### Primary (HIGH confidence)
- Direct source code inspection of: `networkerFactory.ts`, `apiManager.ts`, `connectionStatus.ts`, `api-manager-stub.ts`, `apiManagerProxy.ts`, `rootScope.ts`, `createManagers.ts`, `index.ts`, `nostr-relay-pool.ts`
- `connectionStatus.ts` (MTProto enum) -- 24 lines, fully inspected
- `api-manager-stub.ts` -- 212 lines, fully inspected, established monkey-patch pattern

### Secondary (MEDIUM confidence)
- Boot path flow inferred from `index.ts` -> `apiManagerProxy.loadAllStates()` -> `sendAllStates()` chain
- SharedWorker-side behavior inferred from `apiManagerProxy extends MTProtoMessagePort` pattern

### Tertiary (LOW confidence)
- Worker-side state initialization behavior -- not directly inspected, inferred from message port pattern
- `apiUpdatesManager` retry behavior on rejection -- needs runtime verification

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all target files directly inspected, clear interfaces
- Architecture: HIGH - stubbing points clearly identified, existing pattern (api-manager-stub.ts) proven
- Pitfalls: MEDIUM - worker-side behavior and manager initialization flows not fully traced
- ConnectionStatus remapping: HIGH - existing `nostra_relay_state` events verified in source

**Research date:** 2026-04-02
**Valid until:** 2026-05-02 (stable codebase, no external dependencies changing)
