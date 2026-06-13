# Tor Modes — Three-way user choice with silent opportunistic upgrade

Date: 2026-04-23
Status: Approved for implementation
Author: @nostra-chat

## Problem

Today Tor is a single boolean (`localStorage['nostra-tor-enabled']`). The UX
this boolean produces is a lose-lose:

1. **Tor on** (default) — every session starts with a ~30–40s bootstrap during
   which messaging is offline. On Tor failure the user gets a modal
   ("Continue without Tor?") that blocks them until they answer.
2. **Tor off** — no privacy at all.

Power users who want maximum privacy have no "Tor or nothing" escape hatch —
the modal always offers direct fallback. Regular users who want to chat
*now* and get privacy *when possible* have no option that skips the bootstrap
blocker.

## Goals

Three user-facing modes, chosen from settings, persisted per-device:

| Mode | User intent |
|---|---|
| **Tor only** | Hide my IP at all costs. If Tor isn't available, my messages wait. |
| **Tor when available** | Let me chat now. Silently upgrade me to Tor when it boots. Downgrade silently if Tor dies. Never block me. |
| **Tor off** | Don't use Tor. |

**Default on fresh install:** `Tor when available`.

**Non-goals:**

- No UI surface for "currently on Tor vs. currently direct" in *when-available*
  mode. The dashboard already shows this for users who open it. If we learn
  users want a visible indicator, a follow-up adds one.
- No change to circuit dashboard, relay list, WASM/arti handling, webtor fallback URLs.
- No feature flag. The mode is itself the kill switch (flip to `off`).

## Design decisions

### 1. Data model

**New key:** `localStorage['nostra-tor-mode']` ∈ `{'only' | 'when-available' | 'off'}`.

**Types** (exported from `privacy-transport.ts`):

```ts
export type TorMode = 'only' | 'when-available' | 'off';
export type RuntimeState = 'booting' | 'tor-active' | 'direct-active' | 'offline';
```

*Mode* is **what the user asked for**. *RuntimeState* is **what the pool is
doing right now**. Orthogonal: mode `when-available` can legitimately be in
either `direct-active` or `tor-active`, and can flip between them multiple
times in a session. Mode `only` is stuck in `booting` until Tor succeeds.

### 2. Migration (UX-preserving — Option B)

A lazy read on every mode access; no explicit migration step at boot:

```ts
static readMode(): TorMode {
  const stored = localStorage.getItem('nostra-tor-mode');
  if(stored === 'only' || stored === 'when-available' || stored === 'off') {
    return stored;
  }
  const legacy = localStorage.getItem('nostra-tor-enabled');
  if(legacy === 'false') return 'off';
  return 'when-available';  // covers legacy 'true' AND fresh installs
}
```

`setMode(m)` writes the new key and deletes the legacy key so no drift remains.

**Impact on existing users:** anyone who had Tor enabled (the default, so most
users) lands on **Tor when available** — they stop seeing the bootstrap
offline window, but Tor still kicks in transparently. Anyone who explicitly
turned Tor off keeps their preference. We accept that users who deliberately
chose "always Tor" lose the stricter semantics; they can restore them by
flipping to *Tor only* in settings. This trade was chosen deliberately over
A (privacy-preserving migration) to maximize the UX win.

### 3. Event surface

In `BroadcastEvents` (rootScope.ts):

```ts
'nostra_tor_mode_changed': TorMode,          // renamed from nostra_tor_enabled_changed
'nostra_tor_state': {                         // unchanged shape, keyed on RuntimeState
  state: RuntimeState;
  error?: string;
},
'nostra_tor_circuit_update': {...}           // unchanged
```

The old `nostra_tor_enabled_changed` event has no in-tree listeners outside
`privacy-transport.ts` itself, so the rename is internal.

### 4. State machine

```
              setMode('only')                   setMode('when-available')            setMode('off')
   ┌─────────────────────────┐       ┌──────────────────────────────────────┐    ┌─────────────┐
   ▼                         │       ▼                                      │    ▼             │
[booting]────tor ok────▶[tor-active]                                   [direct-active]─tor ok─▶[tor-active]
   │                         ▲                                              ▲         │
   │                         │                                              │         │
   └──tor fail, retry────────┘                                              │         │
                                                                            └─tor fail┘
```

Invariants:

- Mode `only`: `RuntimeState ∈ {booting, tor-active}`. Never `direct-active`.
- Mode `when-available`: `RuntimeState ∈ {direct-active, tor-active}`. Never
  `booting` — the pool goes direct immediately at construction, and the Tor
  retry loop runs purely in the background.
- Mode `off`: `RuntimeState = direct-active`. Always.

**Construction:** `PrivacyTransport.bootstrap()` dispatches on mode:

- `only` → set `booting`, start retry loop. Do NOT open direct WebSockets.
- `when-available` → call `relayPool.setDirectMode()` immediately, set
  `direct-active`, start retry loop in background. No `booting` state is
  ever observable externally in this mode.
- `off` → call `relayPool.setDirectMode()`, set `direct-active`. No loop.

### 5. Retry loop (`TorBootstrapLoop`)

Extracted helper owned by `PrivacyTransport`. Keeps the schedule
unit-testable with fake timers and keeps the parent class under ~300 lines.

**API:**
```ts
class TorBootstrapLoop {
  constructor(opts: {
    schedule: number[];        // in seconds
    attempt: () => Promise<boolean>;   // true = success, false = failure
    onSuccess: () => void;
    onFailure: (err: unknown, attemptNum: number) => void;
  });
  start(): void;
  stop(): void;
  isRunning(): boolean;
}
```

**Schedules:**

| Mode | Schedule (s) | Steady-state |
|---|---|---|
| `only` | 5, 10, 20, 40 | 40s (loop forever) |
| `when-available` | 5, 10, 20, 40, 80, 160, 300 | 300s (loop forever) |
| `off` | loop not started | — |

Rationale: *only*-mode users are blocked on Tor, so recover aggressively
(40s cap). *when-available* users are productive on direct, so don't burn
CPU/battery on WASM bootstraps more than every 5 min once it's clear Tor
isn't coming.

**Each attempt** (implemented as the `attempt` closure PrivacyTransport hands
the loop): single `webtorClient.bootstrap(60_000 /* ms */)`. On failure:
`await webtorClient.close()` + (unless the client was injected for tests)
replace `this.webtorClient` with a fresh `WebtorClient` so the next attempt
has a clean tunnel. Then the loop sleeps for the next slot in the ladder.
The loop stops only when: mode changes (transport calls `loop.stop()`) or
`PrivacyTransport.disconnect()`.

### 6. Hot-swap

New on `PrivacyTransport`:

```ts
private upgradeToTor(fetchFn: (url: string) => Promise<Response>): void {
  this.relayPool.setTorMode(fetchFn);   // primitive already exists
  this.setState('tor-active');
  this.flushQueue();                     // no-op for when-available (queue already empty)
}

private downgradeToDirect(): void {
  if(this.mode !== 'when-available') return;  // never downgrade in only-mode
  this.relayPool.setDirectMode();
  this.setState('direct-active');
  // Loop continues in the background; no manual restart needed.
}
```

**Live-upgrade trigger** (when-available): retry loop's `onSuccess` callback
calls `upgradeToTor`.

**Live-downgrade trigger** (when-available): webtor-rs does not expose a
reliable "tunnel died" event, so we use a proactive liveness probe. While
`mode === 'when-available' && state === 'tor-active'`, a 30s-interval timer
calls `webtorClient.isReady()`. On two consecutive negatives (60s total —
avoids flapping on momentary consensus refreshes), call `downgradeToDirect`
and restart the retry loop. The probe is torn down on mode change or
runtime-state change away from `tor-active`.

The pool's existing `setTorMode` / `setDirectMode` primitives handle the
WS/HTTP-polling swap per relay. Re-subscriptions on the new transport are
the relay's responsibility (`NostrRelay.reconnect`), so no changes there.

### 7. Send path

| Mode × State | Behavior |
|---|---|
| `only` × `booting` | Queue (unchanged — existing offline-queue code) |
| `only` × `tor-active` | Publish via Tor (unchanged) |
| `when-available` × `direct-active` | Publish directly (**new** — today would queue during bootstrap) |
| `when-available` × `tor-active` | Publish via Tor |
| `off` × `direct-active` | Publish directly |

Queue flushed on every transition into an active state (`flushQueue()` call
already exists in `confirmDirectFallback` and bootstrap success — new
`upgradeToTor` also calls it so the first direct-active → tor-active
transition in `when-available` doesn't leave residual queued entries).

### 8. Banner & popup lifecycle

| Mode × State | TorStartupBanner | TorStartupSkipConfirm | TorBanner (in-chat) |
|---|---|---|---|
| `only` × `booting` | **Show** — text "Connecting via Tor — messages queued". No Skip button. No Retry button. No Continue-without-Tor button. | Never | Never |
| `only` × `tor-active` | Hidden (transient "Connected via Tor" fades) | — | — |
| `when-available` × any | **Never mounted** | **Never** | **Never** |
| `off` × any | Never mounted | Never | Never |

**Consequences:**

- `TorStartupBanner.tsx`: remove Skip/Retry/Continue buttons. Component becomes
  near-trivial: spinner + text + transient "Connected" confirmation. Props
  collapse to `{}`.
- `torStartupSkipConfirm.tsx`: **delete** (unreachable).
- `torBanner.tsx` (in-chat "direct mode" banner with "Riprova Tor" button): **delete**
  (unreachable — in *when-available* we swap silently; in *only* we never go
  direct; in *off* the user chose this).
- `nostra-bridge.ts:151–165` banner mount gate changes from `if(!torEnabled)`
  to `if(mode !== 'only')`. The branch that called `pool.initialize()`
  immediately for the legacy Tor-disabled path becomes the *only* and *off*
  construction paths depicted in §4 (handled inside `PrivacyTransport.bootstrap`).
- `confirmDirectFallback()` is deleted — no longer part of the public API.

### 9. Settings UI

Replace the single Tor on/off toggle in
`src/components/sidebarLeft/tabs/privacyAndSecurity.ts:28–73` with a
three-option radio group inside its own `SettingSection`.

**Lang keys** (added to `src/lang.ts` — English only; Italian follows via
normal translation flow):

```ts
'Tor.Mode.SectionTitle': 'Tor Privacy',
'Tor.Mode.SectionCaption': 'Route your Nostr relay traffic through the Tor network to hide your IP address.',

'Tor.Mode.Only.Label': 'Tor only',
'Tor.Mode.Only.Desc': 'Always route traffic through Tor to hide your IP from relays. If Tor isn’t available, your messages stay queued until it is.',

'Tor.Mode.WhenAvailable.Label': 'Tor when available',
'Tor.Mode.WhenAvailable.Desc': 'Connect immediately for fast messaging, and upgrade to Tor in the background when it’s ready. Privacy when possible, never at the cost of usability. (Recommended)',

'Tor.Mode.Off.Label': 'Tor off',
'Tor.Mode.Off.Desc': 'Never use Tor. Your IP address is visible to the relays you connect to.'
```

**UI primitive:** a stacked list of `Row` components, each with a radio-style
check and an inline `subtitle` slot for the description. The codebase
already uses this pattern for mutually-exclusive picks — cf. the Theme and
Auto-Night-Mode selectors in `generalSettings.ts`. Exact primitive is
locked in the implementation plan.

**Bump required:** `src/config/langPackLocalVersion.example.ts` (per
CLAUDE.md feedback rule — cached pack invalidation).

### 10. Testing

**Vitest changes:**

- Delete `tor-fallback-confirm.test.ts` (popup removed).
- Rewrite `tor-ui.test.ts` — all `nostra-tor-enabled` read/writes become
  `nostra-tor-mode`. Add a dedicated `readMode()` migration test that
  asserts the five legacy states (`'true'`, `'false'`, missing, plus
  corrupted values like `'yes'` and `''`).
- `tor-bootstrap.test.ts` — add a `when-available` live-upgrade test:
  inject a `WebtorClient` mock that fails twice then succeeds; assert
  `RuntimeState` transitions `direct-active → … → tor-active` without
  any banner mount being triggered, and that send-path publishes directly
  during the `direct-active` window.
- New `tor-retry-loop.test.ts` — unit test `TorBootstrapLoop` with fake
  timers: ladder order, steady-state cap per mode, stop on mode change.

**E2E changes:**

- `e2e-tor-privacy-flow.ts` — banner assertions gated on mode-only. Skip
  button assertions removed. Mode sequence: default (`when-available`, no
  banner) → switch to `only` (banner appears on reload) → switch to `off`
  (banner never appears).
- `e2e-tor-wasm.ts:291–299` — setter becomes `nostra-tor-mode=off`.
- `helpers/local-relay.ts:133` — same setter update.

**Regression coverage for the new live-swap** lives in
`tor-bootstrap.test.ts`. No new E2E for it — hot-swap is internal to
`PrivacyTransport` and the unit test with a mocked pool exercises the exact
rewire path.

### 11. Migration footprint (code)

Grep'd paths that read `nostra-tor-enabled` or call `isTorEnabled()`:

| File | Treatment |
|---|---|
| `src/lib/nostra/privacy-transport.ts` | Owner of new model |
| `src/lib/nostra/nostra-bridge.ts:151` | Replace with `const mode = PrivacyTransport.readMode(); if(mode === 'off' \|\| mode === 'when-available') ...` |
| `src/pages/nostra-onboarding-integration.ts:191` | Replace `torEnabled` derivation with `PrivacyTransport.readMode() !== 'off'` |
| `src/components/sidebarLeft/tabs/privacyAndSecurity.ts:28–73` | Full rewrite — new 3-row radio |
| `src/components/sidebarLeft/tabs/nostraStatus.ts:92,128` | Replace `isTorEnabled()` with `readMode() !== 'off'` |
| `src/components/nostra/tor-ui-state.ts:16` | Same — derive `disabled` from mode |
| E2E + test helpers (5 files) | Update setter/getter keys per §10 |

**Deprecated shim:** `isTorEnabled(): boolean` stays, documented as deprecated:
`return PrivacyTransport.readMode() !== 'off';`. Removed in a follow-up PR
once no call sites remain (one grep sweep after this ships).

## Open questions

None at time of spec approval. Implementation may surface minor UI-primitive
choices (exact radio component in §9) — plan will lock.

## Out of scope

- Per-relay Tor routing (all-or-nothing today, kept that way).
- "Tor health" indicator in the chat topbar for when-available mode.
- Auto-detection of Tor Browser / system Tor proxy.
- i18n translations of the new lang keys (follows normal flow).
- Fuzzer integration for the new mode surface (Phase 2b scope, not here).

## Rollout

Single PR, single Conventional commit title:
`feat(tor): three-mode Tor setting with silent opportunistic upgrade`.

No feature flag. The `Tor off` option *is* the escape hatch; anyone seeing
a regression can flip it from settings and keep working.

Release channel: standard `pnpm version minor` after merge (breaking change to
the banner UX justifies minor, not patch).
