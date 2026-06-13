# Phase 7: Disable Telegram MTProto & Remove Server Dependency - Context

**Gathered:** 2026-04-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Eliminate all Telegram MTProto connections so Nostra.chat operates entirely on Nostr relays. The app must not attempt any connection to Telegram servers at startup or runtime. This is a **disable + stub** phase — not a full code removal. Dead code cleanup is deferred to a future phase.

</domain>

<decisions>
## Implementation Decisions

### MTProto Removal Strategy
- **D-01:** Replace `src/lib/mtproto/` internals (networker, authorizer, transports) with minimal no-op stubs that maintain the same interfaces but never open network connections. The 55+ AppManagers that depend on these interfaces continue to compile without changes.
- **D-02:** `invokeApi()` stub rejects with a clear error (`MTProto disabled`) for any non-intercepted method. Methods already routed through `api-manager-stub.ts` (messages, users) continue working via Nostra.chat bridge.
- **D-03:** Do NOT delete `src/lib/mtproto/` files or remove dead code in this phase. Stub-out only. Full cleanup is a separate future effort.

### Connection Status & Startup UX
- **D-04:** Repurpose `ConnectionStatusComponent` to show Nostr relay pool connection status instead of MTProto DC status. Reuse the existing component, change the data source from `networkerFactory` to relay pool state.
- **D-05:** Auto-reconnect is silent — status bar shows "Reconnecting..." only when ALL relays are down. Individual relay disconnect/reconnect is handled silently in background, consistent with Phase 3 behavior.

### apiManagerProxy & State Management
- **D-06:** `apiManagerProxy` keeps its interface but `loadAllStates`/`sendAllStates` work only with local IndexedDB (already used for Nostr identity/keys). SharedWorker continues to function for UI coordination but makes no MTProto calls.
- **D-07:** The boot path in `index.ts` remains structurally the same — `apiManagerProxy.sendEnvironment()`, `loadAllStates()`, etc. — but these now resolve immediately or work against local storage.

### Scope & Types
- **D-08:** Scope is strictly "zero Telegram connections" — stub MTProto, remap ConnectionStatus, stub apiManagerProxy. No dead code removal, no type migration.
- **D-09:** `layer.d.ts` (664KB MTProto types) is kept. Hundreds of components import `Message`, `Chat`, `User`, `InputPeer` from `@layer`. Replacing these types is a massive effort deferred to future cleanup.

### Claude's Discretion
- Exact stub implementation details for `networkerFactory`, `apiManager`, and transport layer
- How to wire relay pool status events into `ConnectionStatusComponent` (likely via existing `rootScope` relay events from Phase 3)
- Whether to stub at the `NetworkerFactory` level or deeper in individual networker/transport classes

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### MTProto Layer (stub targets)
- `src/lib/mtproto/networker.ts` — Main networker (61KB, primary connection logic to stub)
- `src/lib/mtproto/authorizer.ts` — Auth handshake with Telegram DCs (20KB, must be no-op'd)
- `src/lib/mtproto/schema.ts` — TL schema (505KB, keep but unused by stubs)
- `src/lib/mtproto/transports/` — WebSocket/TCP transports (4 files, must not open connections)
- `src/lib/mtproto/connectionStatus.ts` — ConnectionStatus enum (reuse for relay status)

### Manager Layer (integration points)
- `src/lib/appManagers/networkerFactory.ts` — Creates networkers, force reconnect API
- `src/lib/appManagers/apiManager.ts` — `invokeApi()` entry point
- `src/lib/appManagers/createManagers.ts` — Where all managers are instantiated (line 100-106)
- `src/lib/apiManagerProxy.ts` — Proxy used by index.ts for state loading

### Existing Nostra.chat Integration
- `src/lib/nostra/api-manager-stub.ts` — Already intercepts invokeApi() for P2P routing
- `src/components/connectionStatus.ts` — UI component showing connection status
- `src/lib/rootScope.ts` — Event bus with relay/tor events from Phase 3

### Boot Path
- `src/index.ts` — App entry, uses apiManagerProxy extensively

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `api-manager-stub.ts`: Already patches `invokeApi()` for P2P methods — extend this pattern for the full stub
- `ConnectionStatusComponent`: Existing UI component, just needs data source swap from MTProto DC to Nostr relay pool
- Phase 3 relay events on `rootScope`: `tor_status`, relay connection events already exist

### Established Patterns
- Monkey-patching via `api-manager-stub.ts` — established pattern for intercepting MTProto calls
- `rootScope` event-driven state updates — how all components get connection status
- IndexedDB for local state (identity store, key store, message requests store)

### Integration Points
- `createManagers.ts` line 100-106: Where `ApiManager` and `NetworkerFactory` are instantiated — stub these
- `index.ts`: Boot path calls `apiManagerProxy.sendEnvironment()`, `loadAllStates()`, `sendAllStates()`
- `connectionStatus.ts`: Reads from `rootScope.managers.rootScope.getConnectionStatus()` — remap to relay pool

</code_context>

<specifics>
## Specific Ideas

No specific requirements — standard approach of stubbing + remapping. The key constraint is that the existing 55+ manager architecture must continue to work without modification.

</specifics>

<deferred>
## Deferred Ideas

- **Full MTProto code removal** — delete `src/lib/mtproto/`, remove dead manager methods, tree-shake unused code
- **Native Nostra.chat types** — replace `@layer` imports (Message, Chat, User, etc.) with Nostra.chat-native type definitions
- **SharedWorker simplification** — remove MTProto worker threads, simplify to UI-only worker
- **Bundle size optimization** — removing `schema.ts` (505KB) and `layer.d.ts` (664KB) from the build

</deferred>

---

*Phase: 07-disable-telegram-mtproto-remove-server-dependency*
*Context gathered: 2026-04-02*
