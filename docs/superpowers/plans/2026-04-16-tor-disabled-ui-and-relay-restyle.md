# Tor-disabled UI states & Relay settings restyle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distinguish "Tor disabled on purpose" from "Tor broken" across all UI surfaces; add shortcut links to the Status tab; restyle the Nostr relay settings page.

**Architecture:** A new `nostra_tor_enabled_changed` event from `PrivacyTransport` drives live reactivity. A shared helper (`tor-ui-state.ts`) computes the effective UI state by checking the enabled flag before the transport state. The relay settings page is rebuilt with standard SettingSection/Row primitives and a new card-based SCSS layout.

**Tech Stack:** TypeScript, Solid.js, SCSS, existing UI primitives (`Row`, `SettingSection`, `CheckboxField`, `InputField`, `Button`).

**Spec:** `docs/superpowers/specs/2026-04-15-tor-disabled-ui-and-relay-restyle-design.md`

---

### Task 1: Add `nostra_tor_enabled_changed` event and shared helper

**Files:**
- Modify: `src/lib/rootScope.ts` (~line 251, inside `BroadcastEvents`)
- Modify: `src/lib/nostra/privacy-transport.ts:79-87` (`setTorEnabled` method)
- Create: `src/components/nostra/tor-ui-state.ts`

- [ ] **Step 1: Add event to BroadcastEvents**

In `src/lib/rootScope.ts`, find the line:

```ts
  'nostra_tor_state': {
```

Add immediately before it:

```ts
  'nostra_tor_enabled_changed': boolean,
```

- [ ] **Step 2: Dispatch event from `setTorEnabled`**

In `src/lib/nostra/privacy-transport.ts`, replace the `setTorEnabled` method (lines 79-87):

```ts
  async setTorEnabled(enabled: boolean) {
    localStorage.setItem('nostra-tor-enabled', String(enabled));

    if(enabled) {
      await this.retryTor();
    } else {
      this.confirmDirectFallback();
    }
  }
```

with:

```ts
  async setTorEnabled(enabled: boolean) {
    localStorage.setItem('nostra-tor-enabled', String(enabled));

    try {
      const rootScope = (await import('@lib/rootScope')).default;
      rootScope.dispatchEvent('nostra_tor_enabled_changed', enabled);
    } catch {}

    if(enabled) {
      await this.retryTor();
    } else {
      this.confirmDirectFallback();
    }
  }
```

- [ ] **Step 3: Create shared helper `tor-ui-state.ts`**

Create `src/components/nostra/tor-ui-state.ts`:

```ts
import {PrivacyTransport} from '@lib/nostra/privacy-transport';

export type TorUiState = 'active' | 'bootstrap' | 'direct' | 'error' | 'disabled';

export function normalizeTorState(raw: string | undefined): TorUiState {
  switch(raw) {
    case 'active': return 'active';
    case 'direct': return 'direct';
    case 'bootstrap':
    case 'bootstrapping': return 'bootstrap';
    default: return 'error';
  }
}

export function computeTorUiState(): TorUiState {
  if(!PrivacyTransport.isTorEnabled()) return 'disabled';
  const transport = (typeof window !== 'undefined') ?
    (window as any).__nostraPrivacyTransport : undefined;
  const raw = transport?.state ?? transport?.getState?.();
  return normalizeTorState(raw);
}

export const TOR_UI_COLORS: Record<TorUiState, string> = {
  active: '#4caf50',
  bootstrap: '#f44336',
  direct: '#ff9800',
  error: '#f44336',
  disabled: '#9e9e9e'
};
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v vendor | head -20`

Expected: no NEW errors (pre-existing vendor errors are fine).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rootScope.ts src/lib/nostra/privacy-transport.ts src/components/nostra/tor-ui-state.ts
git commit -m "feat(tor-ui): add nostra_tor_enabled_changed event and shared TorUiState helper"
```

---

### Task 2: Update `SearchBarStatusIcons.tsx` for disabled state

**Files:**
- Modify: `src/components/nostra/SearchBarStatusIcons.tsx`

- [ ] **Step 1: Replace local types/colors with shared imports**

In `src/components/nostra/SearchBarStatusIcons.tsx`, replace lines 1-41 (the imports + types + `TOR_COLORS` + `normalizeTorState`) with:

```ts
/**
 * SearchBarStatusIcons — Tor onion + Nostrich relay status indicators
 */

import {createSignal, onCleanup, JSX} from 'solid-js';
import rootScope from '@lib/rootScope';
import {TorUiState, TOR_UI_COLORS, computeTorUiState} from '@components/nostra/tor-ui-state';

type RelayState = 'all' | 'partial' | 'none';

const RELAY_COLORS: Record<RelayState, string> = {
  all: '#4caf50',
  partial: '#ffeb3b',
  none: '#f44336'
};
```

- [ ] **Step 2: Update `TorOnionIcon` to accept opacity prop**

Replace the existing `TorOnionIcon` function (lines ~45-61) with:

```ts
function TorOnionIcon(props: {color: string; opacity?: number; onClick?: () => void}): JSX.Element {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke={props.color} stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round"
      style={{'cursor': 'pointer', 'margin-left': '4px', 'opacity': String(props.opacity ?? 1)}}
      onClick={props.onClick}
    >
      <ellipse cx="12" cy="14" rx="4" ry="6" />
      <ellipse cx="12" cy="14" rx="7" ry="9" />
      <ellipse cx="12" cy="14" rx="10" ry="10" />
      <line x1="12" y1="4" x2="12" y2="2" />
      <line x1="10" y1="3" x2="14" y2="3" />
    </svg>
  );
}
```

- [ ] **Step 3: Update signal type and seeding in main component**

In the main `SearchBarStatusIcons` function body, change the `torState` signal from:

```ts
  const [torState, setTorState] = createSignal<TorState>('error');
```

to:

```ts
  const [torState, setTorState] = createSignal<TorUiState>(computeTorUiState());
```

Replace the `torHandler`:

```ts
  const torHandler = (state: any) => {
    const raw = typeof state === 'string' ? state : state?.state;
    setTorState(normalizeTorState(raw));
  };
```

with:

```ts
  const torHandler = () => {
    setTorState(computeTorUiState());
  };

  const torEnabledHandler = () => {
    setTorState(computeTorUiState());
  };
```

- [ ] **Step 4: Add listener for the new event + cleanup**

After the existing `rootScope.addEventListener('nostra_relay_state', relayHandler);` line, add:

```ts
  rootScope.addEventListener('nostra_tor_enabled_changed', torEnabledHandler);
```

Update the existing `onCleanup` to also remove the new listener:

```ts
  onCleanup(() => {
    rootScope.removeEventListener('nostra_tor_state', torHandler);
    rootScope.removeEventListener('nostra_relay_state', relayHandler);
    rootScope.removeEventListener('nostra_tor_enabled_changed', torEnabledHandler);
  });
```

- [ ] **Step 5: Remove the old Tor seeding block**

Delete the block that seeds from `__nostraPrivacyTransport` (lines ~151-155) since `computeTorUiState()` already handles it in the initial signal value:

```ts
  // DELETE THIS BLOCK:
  // Seed Tor state from the live privacy transport if present.
  try {
    const transport = (window as any).__nostraPrivacyTransport;
    const s = transport?.state ?? transport?.getState?.();
    if(s) setTorState(normalizeTorState(s));
  } catch{}
```

- [ ] **Step 6: Update `TorOnionIcon` render to pass opacity**

In the JSX return, replace:

```ts
      <TorOnionIcon
        color={TOR_COLORS[torState()]}
        onClick={props.onTorClick}
      />
```

with:

```ts
      <TorOnionIcon
        color={TOR_UI_COLORS[torState()]}
        opacity={torState() === 'disabled' ? 0.55 : 1}
        onClick={props.onTorClick}
      />
```

- [ ] **Step 7: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v vendor | head -20`

Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/nostra/SearchBarStatusIcons.tsx
git commit -m "feat(tor-ui): show grey disabled onion icon when Tor is off"
```

---

### Task 3: Update `TorStatus` popup for disabled state

**Files:**
- Modify: `src/components/popups/torStatus.tsx`
- Modify: `src/scss/nostra/_tor-ui.scss`
- Modify: `src/components/sidebarLeft/index.ts`

- [ ] **Step 1: Extend `TorState` type and labels in popup**

In `src/components/popups/torStatus.tsx`, replace the `TorState` type and `STATE_LABELS` (lines 14-21):

```ts
type TorState = 'bootstrapping' | 'active' | 'direct' | 'failed';

const STATE_LABELS: Record<TorState, {text: string; color: string}> = {
  active: {text: 'Attivo', color: 'green'},
  bootstrapping: {text: 'Bootstrap...', color: 'yellow'},
  direct: {text: 'Diretto', color: 'yellow'},
  failed: {text: 'Errore', color: 'red'}
};
```

with:

```ts
type TorState = 'bootstrapping' | 'active' | 'direct' | 'failed' | 'disabled';

const STATE_LABELS: Record<TorState, {text: string; color: string}> = {
  active: {text: 'Attivo', color: 'green'},
  bootstrapping: {text: 'Bootstrap...', color: 'yellow'},
  direct: {text: 'Diretto', color: 'yellow'},
  failed: {text: 'Errore', color: 'red'},
  disabled: {text: 'Disabilitato', color: 'gray'}
};
```

- [ ] **Step 2: Disable "View circuit details" button when disabled**

Replace the "View circuit details" button JSX (the second `<button>` inside `.tor-popup__actions`, lines ~112-126):

```ts
          <button
            class="tor-popup__btn tor-popup__btn--link"
            onClick={() => {
              props.onClose();
              import('@components/sidebarLeft/tabs/nostraTorDashboard').then(({default: AppNostraTorDashboardTab}) => {
                appSidebarLeft.createTab(AppNostraTorDashboardTab).open();
              });
            }}
          >
            View circuit details
          </button>
```

with:

```ts
          <button
            class={classNames(
              'tor-popup__btn',
              'tor-popup__btn--link',
              props.torState === 'disabled' && 'tor-popup__btn--disabled'
            )}
            disabled={props.torState === 'disabled'}
            onClick={() => {
              if(props.torState === 'disabled') return;
              props.onClose();
              import('@components/sidebarLeft/tabs/nostraTorDashboard').then(({default: AppNostraTorDashboardTab}) => {
                appSidebarLeft.createTab(AppNostraTorDashboardTab).open();
              });
            }}
          >
            View circuit details
          </button>
```

- [ ] **Step 3: Add SCSS for gray dot and disabled button**

In `src/scss/nostra/_tor-ui.scss`, after the `.tor-status-dot--yellow` block (after line 218), add:

```scss
  &--gray {
    background: #9e9e9e;
  }
```

At the end of the `.tor-popup__btn` block (after the `&--link` block, before the closing `}` of `.tor-popup` around line 178), add:

```scss
    &--disabled {
      opacity: 0.5;
      cursor: not-allowed;
      pointer-events: none;
    }
```

- [ ] **Step 4: Update popup caller in `sidebarLeft/index.ts`**

In `src/components/sidebarLeft/index.ts`, in the `openTorStatusPopup` method (~line 1179), replace how `torState` is computed. Change these lines:

```ts
      // Get Tor state
      const transport = (window as any).__nostraPrivacyTransport;
      const torState = transport?.getState?.() ?? 'direct';
      const torStateMap: Record<string, string> = {
        active: 'active',
        bootstrapping: 'bootstrapping',
        direct: 'direct',
        failed: 'failed',
        offline: 'failed'
      };
```

to:

```ts
      // Get Tor state (disabled check first)
      const {computeTorUiState} = await import('@components/nostra/tor-ui-state');
      const torUiState = computeTorUiState();
      const torStateForPopup: Record<string, string> = {
        active: 'active',
        bootstrap: 'bootstrapping',
        direct: 'direct',
        error: 'failed',
        disabled: 'disabled'
      };
```

And update the `torState` usage in the `render()` call from:

```ts
        torState: (torStateMap[torState] || 'direct') as any,
```

to:

```ts
        torState: (torStateForPopup[torUiState] || 'direct') as any,
```

Note: Since the method body is inside a `.then()` callback, change it to an `async` callback to use `await import`:

The `Promise.all([...]).then(([{default: TorStatus}, {render}]) => {` should become:

```ts
    Promise.all([
      import('@components/popups/torStatus'),
      import('solid-js/web'),
      import('@components/nostra/tor-ui-state')
    ]).then(([{default: TorStatus}, {render}, {computeTorUiState}]) => {
```

Then use `computeTorUiState()` directly without a separate `await import`.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v vendor | head -20`

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/popups/torStatus.tsx src/scss/nostra/_tor-ui.scss src/components/sidebarLeft/index.ts
git commit -m "feat(tor-ui): show 'Disabilitato' in TorStatus popup when Tor is off"
```

---

### Task 4: Update `AppNostraStatusTab` — disabled state + shortcut links

**Files:**
- Modify: `src/components/sidebarLeft/tabs/nostraStatus.ts`
- Modify: `src/scss/nostra/_tor-ui.scss`

- [ ] **Step 1: Add imports for privacy transport**

At the top of `src/components/sidebarLeft/tabs/nostraStatus.ts`, after the existing imports (lines 1-13), add:

```ts
import {PrivacyTransport} from '@lib/nostra/privacy-transport';
```

- [ ] **Step 2: Extend `TorState` and labels**

Replace the `TorState` type and `TOR_STATE_LABELS` (lines 14-21):

```ts
type TorState = 'bootstrapping' | 'active' | 'direct' | 'failed';

const TOR_STATE_LABELS: Record<TorState, string> = {
  active: '🟢 Active — traffic routed through Tor',
  bootstrapping: '⏳ Bootstrapping Tor circuit...',
  direct: '🟠 Direct connection (IP visible to relays)',
  failed: '🔴 Tor bootstrap failed'
};
```

with:

```ts
type TorState = 'bootstrapping' | 'active' | 'direct' | 'failed' | 'disabled';

const TOR_STATE_LABELS: Record<TorState, string> = {
  active: '🟢 Active — traffic routed through Tor',
  bootstrapping: '⏳ Bootstrapping Tor circuit...',
  direct: '🟠 Direct connection (IP visible to relays)',
  failed: '🔴 Tor bootstrap failed',
  disabled: '⚪ Disabilitato — connessione diretta'
};
```

- [ ] **Step 3: Declare `torCircuitRow` before `updateTorState`, then handle disabled state**

In the `init()` method, move the `torCircuitRow` declaration to BEFORE the `updateTorState` closure. After the `torErrorRow` setup (~line 83), declare:

```ts
    const torCircuitRow = new Row({
      title: 'View Tor Circuit',
      subtitle: 'Guard → Middle → Exit, rebuild, exit IP',
      icon: 'forward',
      clickable: () => {
        if(!PrivacyTransport.isTorEnabled()) return;
        import('@components/sidebarLeft/tabs/nostraTorDashboard').then(
          ({default: AppNostraTorDashboardTab}) => {
            this.slider.createTab(AppNostraTorDashboardTab).open();
          }
        );
      }
    });
```

Then in `updateTorState`, replace the body:

```ts
    const updateTorState = (state: TorState, error?: string) => {
      torStatusRow.subtitle.textContent = TOR_STATE_LABELS[state] || state;

      const transport = state === 'active' ?
        '🧅 Tor SOCKS (WebSocket over Tor)' :
        state === 'bootstrapping' ?
          '⏳ Waiting for Tor bootstrap...' :
          '🌐 Direct WebSocket (no Tor)';
      torTransportRow.subtitle.textContent = transport;

      if(state === 'failed' && error) {
        torErrorRow.subtitle.textContent = error;
        torErrorRow.container.style.display = '';
      } else {
        torErrorRow.container.style.display = 'none';
      }
    };
```

with:

```ts
    const updateTorState = (state: TorState, error?: string) => {
      torStatusRow.subtitle.textContent = TOR_STATE_LABELS[state] || state;

      const transport = state === 'active' ?
        '🧅 Tor SOCKS (WebSocket over Tor)' :
        state === 'bootstrapping' ?
          '⏳ Waiting for Tor bootstrap...' :
          state === 'disabled' ?
            '🌐 Direct WebSocket (Tor disabilitato)' :
            '🌐 Direct WebSocket (no Tor)';
      torTransportRow.subtitle.textContent = transport;

      if(state === 'failed' && error) {
        torErrorRow.subtitle.textContent = error;
        torErrorRow.container.style.display = '';
      } else {
        torErrorRow.container.style.display = 'none';
      }

      if(state === 'disabled') {
        torCircuitRow.container.classList.add('row-disabled');
      } else {
        torCircuitRow.container.classList.remove('row-disabled');
      }
    };
```

Remove the OLD `torCircuitRow` declaration that used to be after `updateTorState` (lines ~115-126), since we moved it above.

- [ ] **Step 4: Update initial state seeding and add new event listener**

Replace the initial seeding:

```ts
    // Seed from the live transport if available, else assume direct
    const initialTor = (window as any).__nostraPrivacyTransport?.getState?.() as TorState | undefined;
    updateTorState(initialTor || 'direct');
```

with:

```ts
    const computeInitialTor = (): TorState => {
      if(!PrivacyTransport.isTorEnabled()) return 'disabled';
      const raw = (window as any).__nostraPrivacyTransport?.getState?.();
      const map: Record<string, TorState> = {
        active: 'active',
        bootstrapping: 'bootstrapping',
        direct: 'direct',
        failed: 'failed'
      };
      return map[raw] || 'direct';
    };
    updateTorState(computeInitialTor());
```

After the existing `rootScope.addEventListener('nostra_tor_state', ...)` block, add:

```ts
    rootScope.addEventListener('nostra_tor_enabled_changed', () => {
      updateTorState(computeInitialTor());
    });
```

- [ ] **Step 5: Add shortcut links section at bottom**

Before the final `this.scrollable.append(...)` block, add:

```ts
    // ─── Section: Quick links ───────────────────────────────

    const linksSection = new SettingSection({});

    const privacyLink = new Row({
      title: 'Impostazioni privacy e Tor',
      subtitle: 'Abilita o disabilita Tor, gestisci privacy',
      icon: 'lock',
      clickable: () => {
        import('@components/sidebarLeft/tabs/privacyAndSecurity').then(
          ({default: AppPrivacyAndSecurityTab}) => {
            this.slider.createTab(AppPrivacyAndSecurityTab).open();
          }
        );
      }
    });

    const relaysLink = new Row({
      title: 'Gestisci Nostr relays',
      subtitle: 'Aggiungi, rimuovi e configura i relay',
      icon: 'link',
      clickable: () => {
        import('@components/sidebarLeft/tabs/nostraRelaySettings').then(
          ({default: AppNostraRelaySettingsTab}) => {
            this.slider.createTab(AppNostraRelaySettingsTab).open();
          }
        );
      }
    });

    linksSection.content.append(
      privacyLink.container,
      relaysLink.container
    );
```

Then update the `this.scrollable.append(...)` call:

```ts
    this.scrollable.append(
      torSection.container,
      relaySection.container,
      linksSection.container
    );
```

- [ ] **Step 6: Add `.row-disabled` style**

In `src/scss/nostra/_tor-ui.scss`, at the end of the file, add:

```scss
.row-disabled {
  opacity: 0.5;
  pointer-events: none;
}
```

- [ ] **Step 7: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v vendor | head -20`

Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/sidebarLeft/tabs/nostraStatus.ts src/scss/nostra/_tor-ui.scss
git commit -m "feat(tor-ui): disabled state on Status tab + shortcut links to Privacy and Relays"
```

---

### Task 5: Restyle `AppNostraRelaySettingsTab` — SCSS

**Files:**
- Create: `src/scss/nostra/_nostra-relay-settings.scss`
- Modify: `src/scss/style.scss` (~line 528, after the last nostra import)

- [ ] **Step 1: Create the new SCSS file**

Create `src/scss/nostra/_nostra-relay-settings.scss`:

```scss
.nostra-relay-settings {
  .relay-card-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 16px;
  }

  .relay-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 14px;
    border: 1px solid var(--border-color);
    border-radius: 12px;
    background: var(--surface-color);
    transition: box-shadow .15s ease;

    &:hover {
      box-shadow: 0 2px 8px rgba(0, 0, 0, .06);
    }

    &--disabled {
      opacity: .55;
    }
  }

  .relay-card__header {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .relay-card__dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;

    &--green { background: #4caf50; }
    &--yellow { background: #ffeb3b; }
    &--red { background: #f44336; }
  }

  .relay-card__url {
    font-family: var(--font-monospace, monospace);
    font-size: 13px;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .relay-card__latency {
    font-size: 12px;
    color: var(--secondary-text-color);
    flex-shrink: 0;

    &.latency-good { color: #4caf50; }
    &.latency-moderate { color: #ff9800; }
    &.latency-slow { color: #f44336; }
  }

  .relay-card__footer {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .relay-chip {
    min-width: 36px;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--border-color);
    background: transparent;
    font-size: 12px;
    font-weight: 500;
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
    position: absolute;
    top: 8px;
    right: 8px;
    opacity: 0;
    transition: opacity .12s ease;
    color: var(--secondary-text-color);
    background: none;
    border: none;
    cursor: pointer;
    font-size: 18px;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;

    &:hover {
      color: var(--danger-color, #e53935);
      background: rgba(0, 0, 0, .04);
    }
  }

  .relay-card:hover .relay-card__delete {
    opacity: 1;
  }

  .relay-tor-aggregate {
    margin: 8px 16px 0;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px dashed var(--border-color);
    font-size: 12px;
    color: var(--secondary-text-color);
  }

  .relay-list-empty {
    padding: 16px;
    text-align: center;
    color: var(--secondary-text-color);
    font-size: 14px;
  }
}
```

- [ ] **Step 2: Import the new SCSS in the aggregator**

In `src/scss/style.scss`, after line 528 (`@import "nostra/seed-phrase";`), add:

```scss
@import "nostra/nostra-relay-settings";
```

- [ ] **Step 3: Commit**

```bash
git add src/scss/nostra/_nostra-relay-settings.scss src/scss/style.scss
git commit -m "feat(relay-ui): add card-based SCSS for relay settings restyle"
```

---

### Task 6: Rewrite `AppNostraRelaySettingsTab` markup

**Files:**
- Modify: `src/components/sidebarLeft/tabs/nostraRelaySettings.ts`

- [ ] **Step 1: Full rewrite of `nostraRelaySettings.ts`**

Replace the entire contents of `src/components/sidebarLeft/tabs/nostraRelaySettings.ts` with:

```ts
import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import CheckboxField from '@components/checkboxField';
import InputField from '@components/inputField';
import Button from '@components/button';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import rootScope from '@lib/rootScope';
import {NostrRelayPool, RelayConfig, DEFAULT_RELAYS} from '@lib/nostra/nostr-relay-pool';

const LS_ONLY_MY_RELAYS = 'nostra-only-my-relays';

export default class AppNostraRelaySettingsTab extends SliderSuperTab {
  private relayPool: NostrRelayPool | null = null;
  private cardListEl: HTMLElement | null = null;
  private captionEl: HTMLElement | null = null;
  private stateCleanup: (() => void) | null = null;
  private listCleanup: (() => void) | null = null;

  public init(relayPool?: NostrRelayPool) {
    this.container.classList.add('nostra-relay-settings');
    this.setTitle('Nostr Relays' as any);

    this.relayPool = relayPool ?? (window as any).__nostraPool ?? null;

    // ─── Preferences ────────────────────────────────────────
    const prefSection = new SettingSection({
      name: 'Preferenze' as any,
      caption: 'Ignora i relay di default e usa solo quelli che hai aggiunto tu' as any
    });

    const onlyMineCheckbox = new CheckboxField({
      text: 'Usa solo i miei relay',
      toggle: true,
      checked: localStorage.getItem(LS_ONLY_MY_RELAYS) === '1'
    });
    onlyMineCheckbox.input.addEventListener('change', () => {
      localStorage.setItem(LS_ONLY_MY_RELAYS, onlyMineCheckbox.checked ? '1' : '0');
    });

    const onlyMineRow = new Row({
      title: 'Usa solo i miei relay',
      checkboxField: onlyMineCheckbox,
      clickable: true
    });
    prefSection.content.append(onlyMineRow.container);

    // ─── Current Relays ─────────────────────────────────────
    const relaysSection = new SettingSection({
      name: 'I tuoi relay' as any
    });
    this.captionEl = relaysSection.caption;

    const cardList = document.createElement('div');
    cardList.classList.add('relay-card-list');
    this.cardListEl = cardList;
    relaysSection.content.append(cardList);

    this.renderCards();

    const stateHandler = () => this.renderCards();
    rootScope.addEventListener('nostra_relay_state', stateHandler);
    this.stateCleanup = () => rootScope.removeEventListener('nostra_relay_state', stateHandler);

    const listHandler = () => this.renderCards();
    rootScope.addEventListener('nostra_relay_list_changed', listHandler);
    this.listCleanup = () => rootScope.removeEventListener('nostra_relay_list_changed', listHandler);

    // ─── Add Relay ──────────────────────────────────────────
    const addSection = new SettingSection({
      name: 'Aggiungi relay' as any
    });

    const urlInput = new InputField({
      label: 'wss://relay.example.com',
      name: 'relay-url'
    });

    const addBtn = Button('btn-primary btn-color-primary');
    addBtn.textContent = 'Aggiungi';
    addBtn.style.width = '100%';
    addBtn.style.marginTop = '8px';
    attachClickEvent(addBtn, () => {
      const url = urlInput.value.trim();
      if(!url || !url.startsWith('wss://')) {
        urlInput.setState('error', 'URL non valido — usa wss://');
        return;
      }
      if(this.relayPool) {
        this.relayPool.addRelay({url, read: true, write: true});
        urlInput.value = '';
        this.renderCards();
      }
    }, {listenerSetter: this.listenerSetter});

    addSection.content.append(urlInput.container, addBtn);

    // ─── Reset ──────────────────────────────────────────────
    const resetSection = new SettingSection({
      caption: 'Ripristina la lista ai relay di default di Nostra.chat' as any
    });

    const resetBtn = Button('btn-primary btn-color-primary btn-transparent danger');
    resetBtn.textContent = 'Ripristina predefiniti';
    attachClickEvent(resetBtn, () => {
      if(!this.relayPool) return;
      const current = this.relayPool.getRelays();
      for(const relay of current) {
        this.relayPool.removeRelay(relay.url);
      }
      for(const relay of DEFAULT_RELAYS) {
        this.relayPool.addRelay(relay);
      }
      this.renderCards();
    }, {listenerSetter: this.listenerSetter});

    resetSection.content.append(resetBtn);

    this.scrollable.append(
      prefSection.container,
      relaysSection.container,
      addSection.container,
      resetSection.container
    );
  }

  public destroy() {
    if(this.stateCleanup) this.stateCleanup();
    if(this.listCleanup) this.listCleanup();
  }

  private renderCards(): void {
    const container = this.cardListEl;
    if(!container) return;
    container.innerHTML = '';

    const relays: RelayConfig[] = this.relayPool?.getRelays() ?? [];
    const states = this.relayPool?.getRelayStates() ?? [];
    const stateMap = new Map(states.map((s: any) => [s.url, s]));
    const entries = this.relayPool?.getRelayEntries() ?? [];
    const instanceMap = new Map(entries.map((e: any) => [e.config.url, e.instance]));

    if(relays.length === 0) {
      const empty = document.createElement('div');
      empty.classList.add('relay-list-empty');
      empty.textContent = 'Nessun relay configurato';
      container.append(empty);
      this.updateCaption(0, 0);
      return;
    }

    // Tor overhead banner
    let overheadSum = 0;
    let overheadCount = 0;
    let connectedCount = 0;

    for(const relay of relays) {
      const st = stateMap.get(relay.url);
      if(st?.connected) connectedCount++;
      const instance = instanceMap.get(relay.url);
      const torLat = instance?.torLatencyMs ?? -1;
      const dirLat = instance?.directLatencyMs ?? -1;
      if(torLat >= 0 && dirLat >= 0) {
        overheadSum += torLat - dirLat;
        overheadCount++;
      }
    }

    if(overheadCount > 0) {
      const avgOverhead = Math.round(overheadSum / overheadCount);
      const aggEl = document.createElement('div');
      aggEl.classList.add('relay-tor-aggregate');
      aggEl.textContent = `🧅 Avg Tor overhead: +${avgOverhead}ms across ${overheadCount} relay${overheadCount > 1 ? 's' : ''}`;
      container.append(aggEl);
    }

    this.updateCaption(connectedCount, relays.length);

    for(const relay of relays) {
      const st = stateMap.get(relay.url);
      const connected = st?.connected ?? false;
      const latencyMs = st?.latencyMs ?? -1;
      const enabled = st?.enabled ?? true;
      const instance = instanceMap.get(relay.url);
      const torLatency = instance?.torLatencyMs ?? -1;
      const directLatency = instance?.directLatencyMs ?? -1;

      container.append(
        this.createCard(relay, connected, latencyMs, enabled, torLatency, directLatency)
      );
    }
  }

  private createCard(
    relay: RelayConfig,
    connected: boolean,
    latencyMs: number,
    enabled: boolean,
    torLatency: number,
    directLatency: number
  ): HTMLElement {
    const card = document.createElement('div');
    card.classList.add('relay-card');
    if(!enabled) card.classList.add('relay-card--disabled');

    // Header: dot + url + latency
    const header = document.createElement('div');
    header.classList.add('relay-card__header');

    const dot = document.createElement('span');
    const dotColor = !connected ? 'red' : latencyMs > 1000 ? 'yellow' : 'green';
    dot.classList.add('relay-card__dot', `relay-card__dot--${dotColor}`);

    const url = document.createElement('span');
    url.classList.add('relay-card__url');
    url.textContent = relay.url;

    const lat = document.createElement('span');
    lat.classList.add('relay-card__latency');
    if(latencyMs >= 0) {
      if(torLatency >= 0 && directLatency >= 0) {
        const overhead = torLatency - directLatency;
        lat.textContent = `${latencyMs}ms (Tor +${overhead}ms)`;
        lat.classList.add(overhead < 200 ? 'latency-good' : overhead < 500 ? 'latency-moderate' : 'latency-slow');
      } else {
        lat.textContent = `${latencyMs}ms`;
      }
    } else {
      lat.textContent = connected ? '…' : 'offline';
    }

    header.append(dot, url, lat);

    // Footer: chips
    const footer = document.createElement('div');
    footer.classList.add('relay-card__footer');

    const readChip = this.createChip('R', relay.read, () => {
      this.updateRelayRW(relay.url, !relay.read, relay.write);
    });

    const writeChip = this.createChip('W', relay.write, () => {
      this.updateRelayRW(relay.url, relay.read, !relay.write);
    });

    const onChip = this.createChip('On', enabled, () => {
      if(!this.relayPool) return;
      if(enabled) {
        this.relayPool.disableRelay(relay.url);
      } else {
        this.relayPool.enableRelay(relay.url);
      }
      this.renderCards();
    });

    footer.append(readChip, writeChip, onChip);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.classList.add('relay-card__delete', 'tgico-close');
    deleteBtn.addEventListener('click', () => {
      if(this.relayPool) {
        this.relayPool.removeRelay(relay.url);
        this.renderCards();
      }
    });

    card.append(header, footer, deleteBtn);
    return card;
  }

  private createChip(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.classList.add('relay-chip');
    if(active) chip.classList.add('relay-chip--active');
    chip.textContent = label;
    chip.addEventListener('click', onClick);
    return chip;
  }

  private updateRelayRW(url: string, read: boolean, write: boolean): void {
    if(!this.relayPool) return;
    this.relayPool.removeRelay(url);
    this.relayPool.addRelay({url, read, write});
    this.renderCards();
  }

  private updateCaption(connected: number, total: number): void {
    if(this.captionEl) {
      this.captionEl.textContent = `${connected}/${total} connessi`;
    }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v vendor | head -20`

Expected: no new errors. If `InputField.setState` doesn't exist or has a different signature, replace `urlInput.setState('error', '...')` with `urlInput.container.classList.add('error')`.

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebarLeft/tabs/nostraRelaySettings.ts
git commit -m "feat(relay-ui): restyle relay settings with card layout and pill chips"
```

---

### Task 7: Manual verification

**Files:** none (testing only)

- [ ] **Step 1: Start dev server**

Run: `pnpm start`

Open `http://localhost:8080` in a browser.

- [ ] **Step 2: Test Tor disabled state — search bar icon**

1. Open Settings → Privacy & Security.
2. Toggle "Route traffic through Tor" OFF.
3. Observe: the onion icon in the sidebar search bar should immediately turn grey with reduced opacity, without reloading.
4. Toggle it back ON — icon should turn red/green/orange depending on actual state.

- [ ] **Step 3: Test Tor disabled state — popup**

1. With Tor OFF, click the grey onion icon.
2. Popup should show: `⚪ Disabilitato` with a grey dot.
3. "View circuit details" button should appear greyed out and not clickable.
4. Close the popup.

- [ ] **Step 4: Test Tor disabled state — Status tab**

1. Open hamburger menu → Status.
2. Tor Status row should read `⚪ Disabilitato — connessione diretta`.
3. Transport row: `🌐 Direct WebSocket (Tor disabilitato)`.
4. "View Tor Circuit" row should be greyed out (opacity 0.5) and not clickable.

- [ ] **Step 5: Test Status tab shortcuts**

1. Scroll to bottom of Status tab.
2. Click "Impostazioni privacy e Tor" → should open Privacy & Security tab.
3. Go back to Status tab.
4. Click "Gestisci Nostr relays" → should open the restyled Relay Settings tab.

- [ ] **Step 6: Test relay settings restyle**

1. In Relay Settings tab:
   - Confirm relay cards render with status dot, URL in monospace, latency badge.
   - Toggle R/W/On chips — they should flip green/grey.
   - Hover a card — delete X button should appear top-right.
   - Delete a relay — card disappears.
   - Add a relay via URL input + "Aggiungi" button.
   - Toggle "Usa solo i miei relay" checkbox.
   - Click "Ripristina predefiniti" — relays reset to defaults.
2. Confirm the section caption updates live with `N/M connessi`.

- [ ] **Step 7: Run existing tests**

Run: `pnpm test:nostra:quick`

Expected: all existing tests still pass (verify `Tests N passed` line; exit code 1 from pre-existing `tor-ui.test.ts` rejections is expected).
