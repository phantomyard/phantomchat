# Tor-disabled UI states & Nostr relay settings restyle — Design

**Date:** 2026-04-15
**Status:** Draft
**Scope:** Frontend only. No new managers, no protocol changes.

## Problem

Today, when the user disables Tor (Settings → Privacy & Security → "Route traffic through Tor" off), the UI keeps treating Tor as if it had *failed*:

- The onion icon in the sidebar search bar shows the red "error" color.
- The `TorStatus` popup reports `failed / Errore`.
- The `AppNostraStatusTab` reports `🔴 Tor bootstrap failed`.
- The "View Tor Circuit" entry stays clickable and leads to a dashboard that shows nothing useful.

There is no visible distinction between *"Tor is off on purpose"* and *"Tor broke"*. Users get a scary red indicator for a state they chose.

Separately, the `AppNostraRelaySettingsTab` ("Nostr Relays" edit page) is built from raw `<div>`/`<input>` elements with ad-hoc classes and does not match the rest of the app — it looks out of place.

## Goals

1. Represent the `disabled` Tor state everywhere as a distinct, neutral UI (grey, not red), without pretending Tor is bootstrapping or failing.
2. Make toggling Tor in Privacy & Security reflect immediately in the search bar icon + status popup + status tab, without a reload.
3. From the Status tab, give the user two always-visible shortcuts: one to the Privacy & Security settings (where Tor lives) and one to the Nostr Relays settings.
4. Rebuild `AppNostraRelaySettingsTab` using the shared `SettingSection` / `Row` / `CheckboxField` primitives so it matches the rest of the sidebar.

Non-goals:

- No new Tor settings tab; Tor enable/disable stays in Privacy & Security.
- No changes to `PrivacyTransport` bootstrap logic, relay pool logic, or Nostr protocol.
- No refactor of `TorStatus` popup layout beyond adding the new state.

## UI states

A new logical value `'disabled'` is added to the *UI-side* Tor state union. It is **not** added to the transport itself — `PrivacyTransport` keeps its existing states (`bootstrapping | active | direct | failed`). The UI computes the effective state as:

```ts
type TorUiState = 'active' | 'bootstrap' | 'direct' | 'error' | 'disabled';

function computeTorUiState(): TorUiState {
  if(!PrivacyTransport.isTorEnabled()) return 'disabled';
  const raw = (window as any).__nostraPrivacyTransport?.getState?.();
  return normalizeTorState(raw);
}
```

`disabled` always wins over whatever the transport currently reports, because the user's intent (the toggle) is the authoritative signal.

### Colors / labels

| State | Color | Label (IT) |
|---|---|---|
| `active` | `#4caf50` green | Attivo |
| `bootstrap` | `#f44336` red | Bootstrap... |
| `direct` | `#ff9800` orange | Diretto |
| `error` | `#f44336` red | Errore |
| `disabled` | `#9e9e9e` grey | Disabilitato |

The grey icon also gets `opacity: 0.55` in the search bar so it reads as "inactive by choice".

## New event: `nostra_tor_enabled_changed`

Problem: toggling the Tor checkbox in Privacy & Security only writes `localStorage` and calls `PrivacyTransport.setTorEnabled()`. Nothing dispatches a rootScope event, so mounted UI (search bar icons, Status tab) stays stale until a reload.

Solution: add a new entry to `BroadcastEvents` in `src/lib/rootScope.ts`:

```ts
nostra_tor_enabled_changed: boolean;
```

`PrivacyTransport.setTorEnabled(enabled)` dispatches it (via `rootScope.dispatchEvent('nostra_tor_enabled_changed', enabled)`) after persisting to localStorage. All three UI surfaces listen and re-compute.

## Component changes

### 1. `SearchBarStatusIcons.tsx`

- Extend `TorState` union to include `'disabled'`.
- Extend `TOR_COLORS` with `disabled: '#9e9e9e'`.
- Render onion icon with `opacity: 0.55` when `torState() === 'disabled'` (inline style conditional).
- Seed initial state via the new `computeTorUiState()` helper (not just `normalizeTorState(transport.state)`).
- Add `rootScope.addEventListener('nostra_tor_enabled_changed', ...)` that re-runs `computeTorUiState()`; cleanup in `onCleanup`.
- Click behavior unchanged: the icon still calls `onTorClick`, which opens the `TorStatus` popup. The popup (not the icon) is responsible for rendering the disabled state.

### 2. `TorStatus` popup (`src/components/popups/torStatus.tsx`)

- Extend the popup's local `TorState` type to include `'disabled'`.
- Extend `STATE_LABELS` with `disabled: {text: 'Disabilitato', color: 'gray'}`.
- The "View circuit details" button:
  - When `torState === 'disabled'`: add `tor-popup__btn--disabled` class, set `disabled` attribute, `onClick` becomes a no-op.
  - Otherwise: current behavior.
- Caller (`sidebarLeft/index.ts:1179 openTorStatusPopup`) computes `torState` via `computeTorUiState()` instead of reading `transport.getState()` directly, so when Tor is disabled the popup receives `'disabled'`.

### 3. `_tor-startup.scss`

- Add `.tor-status-dot--gray { background: #9e9e9e; }`.
- Add `.tor-popup__btn--disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }`.

### 4. `AppNostraStatusTab` (`nostraStatus.ts`)

- Extend `TorState` union and `TOR_STATE_LABELS` with:
  `disabled: '⚪ Disabilitato — connessione diretta'`.
- `updateTorState` accepts `'disabled'`; transport row shows `🌐 Direct WebSocket (Tor disabilitato)`; error row hidden.
- On boot, call `computeTorUiState()` for the initial value (not just `transport.getState()`).
- Subscribe to `nostra_tor_enabled_changed` and re-invoke `updateTorState(computeTorUiState())`.
- `torCircuitRow`: when `disabled`, add CSS class `row-disabled` (opacity 0.5, pointer-events: none) and short-circuit the `clickable` callback.
- **New bottom section** `shortcutsSection` — a `SettingSection` with no name, containing two `Row`s:
  - `Row({title: 'Impostazioni privacy e Tor', subtitle: 'Abilita o disabilita Tor, gestisci privacy', icon: 'lock', clickable: () => this.slider.createTab(AppPrivacyAndSecurityTab).open()})`
  - `Row({title: 'Gestisci Nostr relays', subtitle: 'Aggiungi, rimuovi e ordina i relay', icon: 'link', clickable: () => this.slider.createTab(AppNostraRelaySettingsTab).open()})`
- `scrollable.append` order: `torSection`, `relaySection`, `shortcutsSection`.

### 5. `AppNostraRelaySettingsTab` (`nostraRelaySettings.ts`)

Full rewrite of the markup while preserving behavior. Functionality kept 1:1: status dot + latency + R/W toggles + enable/disable + delete + add + reset to defaults + "solo i miei relay" flag + avg Tor overhead banner.

**Structural changes:**

- **"Usa solo i miei relay"** → a `Row` with a `CheckboxField`, inside a `SettingSection({name: 'Preferenze' as any, caption: 'Ignora i relay di default e usa solo quelli che hai aggiunto tu'})`.
- **Current Relays** → `SettingSection({name: 'I tuoi relay', caption: liveCaption})` where `liveCaption` is `N/M connessi · Tor avg +Xms` (or plain `N/M connessi`).
- **Relay card** (replaces the current `.relay-row` div):
  - Rendered as a standalone element with class `relay-card` inside a container with class `relay-card-list` (no `Row`, because Row doesn't fit this layout — but the outer `SettingSection` does).
  - Line 1: status dot (10px) + URL (monospace) + latency badge aligned right.
  - Line 2: three pill-style toggle chips: `R` / `W` / `On`. Each chip is a `<button type="button">`:
    - `relay-chip`, `relay-chip--active` when on, `relay-chip--off` otherwise.
    - `On` chip toggles enable/disable via the pool; R/W chips call `updateRelayRW`.
  - Trailing icon button: `btn-icon tgico-delete` in the card's top-right, danger color on hover.
  - Card style: `border: 1px solid var(--border-color)`, `border-radius: 12px`, `padding: 12px 14px`, `background: var(--surface-color)`, hover slight lift.
  - Disabled card: `opacity: 0.55`, status dot stays red/grey.
- **Aggregate Tor overhead banner**: stays as a small `.relay-tor-aggregate` pill above the card list; shape restyled to match the existing `toast`-like look (rounded, soft border).
- **Add Relay** → `SettingSection({name: 'Aggiungi relay'})` containing:
  - `InputField` for the URL (imported from `@components/inputField`), label "wss://relay.example.com".
  - Full-width `Button('btn-primary btn-color-primary')` "Aggiungi".
- **Reset** → `SettingSection({caption: 'Ripristina la lista ai 5 relay di default di Nostra.chat'})` with a `Button('btn-primary btn-color-primary btn-transparent danger')` "Ripristina predefiniti".
- All strings in Italian for coherence with the existing "Usa solo i miei relay".

**SCSS:** new file `src/scss/nostra/_nostra-relay-settings.scss` (imported from `src/scss/nostra/_nostra.scss` or the appropriate aggregator). Contains:

```scss
.nostra-relay-settings {
  .relay-card-list { display: flex; flex-direction: column; gap: 8px; padding: 8px 16px; }

  .relay-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border: 1px solid var(--border-color);
    border-radius: 12px;
    background: var(--surface-color, var(--background-color));
    transition: box-shadow .15s ease, transform .15s ease;

    &:hover { box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    &--disabled { opacity: .55; }

    .relay-card__header {
      display: flex; align-items: center; gap: 10px;
      .relay-status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
      .relay-status-dot--green { background: #4caf50; }
      .relay-status-dot--yellow { background: #ffeb3b; }
      .relay-status-dot--red { background: #f44336; }
      .relay-url { font-family: var(--font-monospace, monospace); font-size: 13px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .relay-latency { font-size: 12px; color: var(--secondary-text-color); }
      .relay-latency.latency-good { color: #4caf50; }
      .relay-latency.latency-moderate { color: #ff9800; }
      .relay-latency.latency-slow { color: #f44336; }
    }

    .relay-card__chips { display: flex; gap: 6px; }
    .relay-chip {
      min-width: 36px; padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid var(--border-color);
      background: transparent;
      font-size: 12px; font-weight: 500;
      color: var(--secondary-text-color);
      cursor: pointer;
      transition: background .12s ease, color .12s ease, border-color .12s ease;
      &--active {
        background: var(--primary-color);
        color: #fff;
        border-color: var(--primary-color);
      }
    }

    .relay-card__delete {
      position: absolute; top: 8px; right: 8px;
      opacity: 0; transition: opacity .12s ease;
      color: var(--secondary-text-color);
      &:hover { color: var(--danger-color, #e53935); }
    }
    &:hover .relay-card__delete { opacity: 1; }
  }

  .relay-tor-aggregate {
    margin: 8px 16px 0;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px dashed var(--border-color);
    font-size: 12px; color: var(--secondary-text-color);
  }
}
```

(Exact variable names will be resolved against the existing theme tokens; the rule is "reuse existing variables, don't hardcode colors except where semantic.")

## Data flow

```
Privacy & Security toggle flipped
  → PrivacyTransport.setTorEnabled(enabled)
    → localStorage.setItem('nostra-tor-enabled', String(enabled))
    → rootScope.dispatchEvent('nostra_tor_enabled_changed', enabled)   ← NEW

SearchBarStatusIcons listener
  → setTorState(computeTorUiState())
  → onion icon repaints (grey or colored)

AppNostraStatusTab listener
  → updateTorState(computeTorUiState())
  → row text + subtitle update, circuit row toggles disabled class

TorStatus popup
  (only checked at open time via sidebarLeft.openTorStatusPopup)
  → popup receives 'disabled' → renders "Disabilitato" + grey dot + disabled "View circuit"
```

## Files touched

| File | Change |
|---|---|
| `src/lib/rootScope.ts` | Add `nostra_tor_enabled_changed: boolean` to `BroadcastEvents`. |
| `src/lib/nostra/privacy-transport.ts` | `setTorEnabled` dispatches `nostra_tor_enabled_changed` after persisting. |
| `src/components/nostra/tor-ui-state.ts` (new) | Export `TorUiState`, `normalizeTorState`, `computeTorUiState`. Shared by icons + popup caller + status tab. |
| `src/components/nostra/SearchBarStatusIcons.tsx` | `disabled` state, grey color, opacity, listen to new event, use shared helper. |
| `src/components/popups/torStatus.tsx` | `disabled` state + label, disabled-button styling on "View circuit details". |
| `src/scss/nostra/_tor-startup.scss` | `.tor-status-dot--gray`, `.tor-popup__btn--disabled`. |
| `src/components/sidebarLeft/index.ts` | `openTorStatusPopup` uses `computeTorUiState()`. |
| `src/components/sidebarLeft/tabs/nostraStatus.ts` | `disabled` state handling; disabled circuit row; bottom shortcuts section (Privacy & Tor / Nostr relays); listen to new event. |
| `src/components/sidebarLeft/tabs/nostraRelaySettings.ts` | Rewrite markup to use `SettingSection` + `InputField` + `Button` + `CheckboxField`; replace `.relay-row` with `.relay-card` layout; chips instead of checkboxes; IT labels. |
| `src/scss/nostra/_nostra-relay-settings.scss` (new) | Card + chip styles. Imported from the nostra SCSS aggregator. |

## Testing plan

- **Manual:** toggle Tor on/off in Privacy & Security; confirm onion icon grey-ifies immediately (no reload), popup reports "Disabilitato", View circuit is disabled, Status tab row reports Disabilitato and the circuit row cannot be clicked.
- **Manual:** open Status tab, tap each new shortcut — verify Privacy & Security tab opens and Nostr Relay Settings tab opens.
- **Manual:** open Nostr Relay Settings, confirm all existing actions still work: toggle R/W, enable/disable, delete, add new relay, reset to defaults, "solo i miei relay" toggle persists.
- **Unit (optional):** `tor-ui-state.test.ts` — verify `computeTorUiState()` returns `'disabled'` when `nostra-tor-enabled === 'false'`, regardless of `transport.getState()`.
- **E2E (optional):** extend `e2e-tor-ui.ts` to assert icon color swaps to grey after disabling Tor.
- **No backend / P2P tests needed** — this is pure presentation.

## Risks

- **Stale state after reload:** if any other code path ever calls `localStorage.setItem('nostra-tor-enabled', …)` directly without going through `PrivacyTransport.setTorEnabled`, the event won't fire. Mitigation: grep confirmed only `privacy-transport.ts` writes this key in production code (test code is fine). Still, we only read the flag via `isTorEnabled()` / `computeTorUiState()`, which always returns correctly on next read.
- **Relay card layout regression:** the rewrite touches every relay row. Mitigation: keep the rewrite confined to markup + SCSS; business logic (`addRelay`, `removeRelay`, `enableRelay`, `disableRelay`, `updateRelayRW`) is not touched.
- **SCSS variable drift:** some of the variables referenced in the new SCSS (`--surface-color`, `--border-color`) may not exist under those names. Resolution happens during implementation — fall back to existing variables used elsewhere in the tor/relay SCSS (`_tor-startup.scss`, `_nostra.scss`).
