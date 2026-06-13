# QR Key Exchange & Add Contact UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a shared `KeyExchange` view (own QR with centered avatar + fullscreen jsQR scanner) reachable from Settings and Add Contact popup, and add an "Add Contact" entry to the FAB pencil menu.

**Architecture:** One Solid component (`KeyExchange`) renders identity QR and launches a fullscreen `QRScanner` overlay. Both are reused from two entry points — Settings sub-tab and Add Contact popup — via a shared extracted popup module. Scanner decodes `npub1…` / `nostr:npub1…` via `jsqr`. QR display uses `qr-code-styling` (both libs already installed) with avatar fallback to dicebear generated from npub.

**Tech Stack:** Solid.js (custom fork), TypeScript, `qr-code-styling` (already in deps), `jsqr` (already in deps), `nostr-tools/nip19`, SCSS modules, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-04-14-qr-key-exchange-design.md`

---

## File Structure

**New files:**
- `src/lib/nostra/qr-payload.ts` — pure parser for raw QR strings → `{npub}` or `{error}`
- `src/lib/nostra/avatar-fallback.ts` — `getAvatarDataURL(npub, picture?)` shared helper
- `src/components/popups/addContact.ts` — extracted `showAddContactPopup(managers)` + wires Scan QR button
- `src/components/nostra/KeyExchange.tsx` — identity QR display + Scan CTA
- `src/components/nostra/QRScanner.tsx` — fullscreen camera overlay using jsQR
- `src/components/nostra/key-exchange.module.scss` — scoped styles for both components
- `src/components/sidebarLeft/tabs/nostraQR.ts` — `SliderSuperTab` wrapper that mounts `KeyExchange`
- `src/tests/nostra/qr-payload.test.ts`
- `src/tests/nostra/key-exchange.test.ts`
- `src/tests/e2e/e2e-qr-key-exchange.ts`

**Modified files:**
- `src/components/sidebarLeft/index.ts` — add "Add Contact" to FAB menu; replace inlined dicebear call with import
- `src/components/sidebarLeft/tabs/settings.ts` — add "My QR Code" row
- `src/components/sidebarLeft/tabs/contacts.ts` — delete inline `showAddContactPopup`, import from shared module
- `src/lang.ts` — add strings
- `src/tests/e2e/run-all.sh` — register new E2E test

**Deleted files:**
- `src/components/nostra/QRIdentity.tsx`
- `src/tests/nostra/qr-identity.test.ts`

---

## Task 1: `parseQRPayload` pure function (TDD)

**Files:**
- Create: `src/lib/nostra/qr-payload.ts`
- Test: `src/tests/nostra/qr-payload.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/tests/nostra/qr-payload.test.ts`:

```typescript
import {describe, it, expect, beforeEach, afterEach, beforeAll} from 'vitest';
import {parseQRPayload} from '@lib/nostra/qr-payload';
import {generateNostrIdentity} from '@lib/nostra/nostr-identity';

// Derive a real valid npub/hex pair at runtime — safer than hardcoding.
let VALID_NPUB: string;
let VALID_HEX: string;

beforeAll(() => {
  const id = generateNostrIdentity();
  VALID_NPUB = id.npub;
  VALID_HEX = id.publicKey;
});

describe('parseQRPayload', () => {
  beforeEach(() => {
    (window as any).__nostraOwnPubkey = undefined;
  });

  afterEach(() => {
    (window as any).__nostraOwnPubkey = undefined;
  });

  it('accepts raw npub', () => {
    expect(parseQRPayload(VALID_NPUB)).toEqual({npub: VALID_NPUB});
  });

  it('strips nostr: prefix (lowercase)', () => {
    expect(parseQRPayload('nostr:' + VALID_NPUB)).toEqual({npub: VALID_NPUB});
  });

  it('strips NOSTR: prefix (case-insensitive)', () => {
    expect(parseQRPayload('NOSTR:' + VALID_NPUB)).toEqual({npub: VALID_NPUB});
  });

  it('trims surrounding whitespace', () => {
    expect(parseQRPayload('  ' + VALID_NPUB + '\n')).toEqual({npub: VALID_NPUB});
  });

  it('rejects too-short npub', () => {
    expect(parseQRPayload('npub1short')).toEqual({error: 'invalid'});
  });

  it('rejects 64-char hex pubkey as unsupported', () => {
    expect(parseQRPayload(VALID_HEX)).toEqual({error: 'unsupported'});
  });

  it('rejects random string', () => {
    expect(parseQRPayload('hello world')).toEqual({error: 'invalid'});
  });

  it('rejects empty string', () => {
    expect(parseQRPayload('')).toEqual({error: 'invalid'});
  });

  it('returns self error when npub matches own pubkey', () => {
    // __nostraOwnPubkey is stored as hex; parseQRPayload must decode first
    (window as any).__nostraOwnPubkey = VALID_HEX;
    expect(parseQRPayload(VALID_NPUB)).toEqual({error: 'self'});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/nostra/qr-payload.test.ts`
Expected: FAIL — module `@lib/nostra/qr-payload` not found.

- [ ] **Step 3: Implement `parseQRPayload`**

Create `src/lib/nostra/qr-payload.ts`:

```typescript
import {decodePubkey} from './nostr-identity';

export type QRPayloadResult =
  | {npub: string}
  | {error: 'invalid' | 'unsupported' | 'self'};

/**
 * Parse a raw string from a scanned QR code into a Nostr npub.
 * Accepts `npub1…` and `nostr:npub1…` (NIP-21). Rejects hex and self.
 */
export function parseQRPayload(raw: string): QRPayloadResult {
  if(!raw) return {error: 'invalid'};

  const trimmed = raw.trim();
  const stripped = trimmed.replace(/^nostr:/i, '');

  // Hex pubkey (64 hex chars) is explicitly unsupported
  if(/^[0-9a-f]{64}$/i.test(stripped)) {
    return {error: 'unsupported'};
  }

  if(!stripped.startsWith('npub1') || stripped.length < 60) {
    return {error: 'invalid'};
  }

  let hex: string;
  try {
    hex = decodePubkey(stripped);
  } catch(_) {
    return {error: 'invalid'};
  }

  // decodePubkey returns the input unchanged for non-npub strings; sanity check
  if(!/^[0-9a-f]{64}$/i.test(hex)) {
    return {error: 'invalid'};
  }

  const ownHex = (window as any).__nostraOwnPubkey as string | undefined;
  if(ownHex && hex.toLowerCase() === ownHex.toLowerCase()) {
    return {error: 'self'};
  }

  return {npub: stripped};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/nostra/qr-payload.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/qr-payload.ts src/tests/nostra/qr-payload.test.ts
git commit -m "feat(nostra): add parseQRPayload helper for QR scanner"
```

---

## Task 2: `avatar-fallback.ts` shared helper

**Files:**
- Create: `src/lib/nostra/avatar-fallback.ts`
- Modify: `src/components/sidebarLeft/index.ts` (replace inlined dicebear call)

- [ ] **Step 1: Locate existing dicebear logic**

Run: `grep -n "dicebear" src/components/sidebarLeft/index.ts`
Expected: one or more lines showing the URL pattern used by `buildNostraProfileMenuContent` (the hamburger profile entry).

If the grep returns nothing, search instead:

Run: `grep -rn "dicebear" src/`
Expected: find the existing URL pattern (likely `https://api.dicebear.com/...` with the npub as seed).

- [ ] **Step 2: Create `avatar-fallback.ts`**

Create `src/lib/nostra/avatar-fallback.ts`:

```typescript
/**
 * Resolve an avatar URL for a Nostra identity.
 * Returns the kind 0 `picture` if present, otherwise a deterministic
 * dicebear URL seeded from the npub. Matches the fallback used by
 * the hamburger sidebar profile entry so QR and sidebar stay in sync.
 */
export function getAvatarURL(npub: string, picture?: string | null): string {
  if(picture && picture.trim().length > 0) return picture;
  // dicebear fun-emoji style, seeded by npub for determinism
  return `https://api.dicebear.com/7.x/fun-emoji/svg?seed=${encodeURIComponent(npub)}`;
}

/**
 * Fetch the avatar as a dataURL suitable for embedding inside a QR code.
 * qr-code-styling needs either a URL with CORS or a dataURL — dataURL is
 * safer because dicebear CORS can be flaky from a worker/scanner context.
 */
export async function getAvatarDataURL(npub: string, picture?: string | null): Promise<string> {
  const url = getAvatarURL(npub, picture);
  try {
    const response = await fetch(url, {mode: 'cors'});
    if(!response.ok) throw new Error('avatar fetch failed');
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch(_) {
    // Fall back to the URL itself — qr-code-styling will handle CORS or skip the image
    return url;
  }
}
```

- [ ] **Step 3: Replace inlined dicebear in `buildNostraProfileMenuContent`**

Open `src/components/sidebarLeft/index.ts` and find the dicebear URL construction inside `buildNostraProfileMenuContent`. Replace it with:

```typescript
import {getAvatarURL} from '@lib/nostra/avatar-fallback';
// ...
const avatarUrl = getAvatarURL(npub, storedPicture);
```

Keep the rest of the function unchanged. If the inlined version had slightly different URL parameters (e.g. a different dicebear style), update `getAvatarURL` to match so the sidebar visual does not regress.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "vendor/emoji\|vendor/bezierEasing"`
Expected: no new errors (pre-existing ~30 vendor errors are ignored).

- [ ] **Step 5: Manual sanity check of sidebar**

Run: `pnpm start` in a background terminal, open `http://localhost:8080`, onboard a fresh identity, open hamburger, confirm the profile row avatar still renders the dicebear emoji identically to before.

(For agentic execution: skip the manual check — rely on the typecheck and existing snapshot behavior. Note in commit message that visual check is pending.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/nostra/avatar-fallback.ts src/components/sidebarLeft/index.ts
git commit -m "refactor(nostra): extract avatar fallback helper for reuse by QR"
```

---

## Task 3: Extract `showAddContactPopup` into shared module

**Files:**
- Create: `src/components/popups/addContact.ts`
- Modify: `src/components/sidebarLeft/tabs/contacts.ts`

- [ ] **Step 1: Read the current implementation**

Run: `sed -n '325,410p' src/components/sidebarLeft/tabs/contacts.ts`
Expected output: the full body of `showAddContactPopup` from line 328 to ~410, including the Scan QR placeholder button at lines 391-399.

- [ ] **Step 2: Create the extracted module**

Create `src/components/popups/addContact.ts`. Copy the ENTIRE body of `showAddContactPopup` into a new exported function. It takes a `managers` argument (the AppManagers bundle from `rootScope.managers`) and a callback for adding contacts.

```typescript
import type rootScope from '@lib/rootScope';

type Managers = (typeof rootScope)['managers'];

export interface ShowAddContactOptions {
  managers: Managers;
  onContactAdded?: (peerId: PeerId) => void;
}

/**
 * Show the Add Contact modal popup. Extracted from AppContactsTab so both
 * the Contacts tab and the FAB pencil menu can open it without coupling.
 */
export function showAddContactPopup(opts: ShowAddContactOptions): void {
  const {managers, onContactAdded} = opts;

  const overlay = document.createElement('div');
  overlay.classList.add('popup-add-contact-overlay');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:1000;display:flex;align-items:center;justify-content:center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:var(--surface-color);border-radius:12px;padding:24px;width:340px;max-width:90vw;';

  const title = document.createElement('h3');
  title.textContent = 'Add Contact';
  title.style.cssText = 'margin:0 0 16px;font-size:18px;color:var(--primary-text-color);';

  const desc = document.createElement('p');
  desc.textContent = 'Enter an npub address to start a conversation';
  desc.style.cssText = 'margin:0 0 16px;font-size:14px;color:var(--secondary-text-color);';

  const nicknameInput = document.createElement('input');
  nicknameInput.type = 'text';
  nicknameInput.placeholder = 'Nickname (optional)';
  nicknameInput.classList.add('input-clear');
  nicknameInput.style.cssText = 'width:100%;padding:12px;border:1px solid var(--border-color);border-radius:8px;font-size:14px;box-sizing:border-box;background:var(--surface-color);color:var(--primary-text-color);margin-bottom:8px;';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'npub1...';
  input.classList.add('input-clear');
  input.style.cssText = 'width:100%;padding:12px;border:1px solid var(--border-color);border-radius:8px;font-size:14px;box-sizing:border-box;background:var(--surface-color);color:var(--primary-text-color);';

  const errorEl = document.createElement('div');
  errorEl.style.cssText = 'color:var(--danger-color);font-size:12px;margin-top:8px;min-height:18px;';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;margin-top:16px;justify-content:flex-end;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.classList.add('btn-primary', 'btn-transparent');
  cancelBtn.style.cssText = 'padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:14px;';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add';
  addBtn.classList.add('btn-primary', 'btn-color-primary');
  addBtn.style.cssText = 'padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:14px;color:#fff;';
  addBtn.addEventListener('click', async() => {
    const val = input.value.trim();
    if(!val.startsWith('npub1') || val.length < 60) {
      errorEl.textContent = 'Invalid npub format';
      return;
    }
    addBtn.disabled = true;
    addBtn.textContent = 'Adding...';
    try {
      await addNpubContact(managers, val, nicknameInput.value, onContactAdded);
      overlay.remove();
    } catch(err) {
      errorEl.textContent = 'Failed to add contact';
      addBtn.disabled = false;
      addBtn.textContent = 'Add';
    }
  });

  // Scan QR — wired to QRScanner in Task 6
  const qrBtn = document.createElement('button');
  qrBtn.textContent = 'Scan QR';
  qrBtn.classList.add('btn-primary', 'btn-transparent');
  qrBtn.setAttribute('data-testid', 'add-contact-scan-qr');
  qrBtn.style.cssText = 'padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:14px;';
  qrBtn.addEventListener('click', async() => {
    const {launchQRScanner} = await import('@components/nostra/QRScanner');
    launchQRScanner({
      onDetected: (npub) => {
        input.value = npub;
        nicknameInput.focus();
        errorEl.textContent = '';
      }
    });
  });

  overlay.addEventListener('click', (e) => {
    if(e.target === overlay) overlay.remove();
  });

  btnRow.append(qrBtn, cancelBtn, addBtn);
  dialog.append(title, desc, nicknameInput, input, errorEl, btnRow);
  overlay.append(dialog);
  document.body.append(overlay);
  input.focus();
}

/**
 * Resolve an npub to a P2P peer, store nickname mapping, persist the contact,
 * and open the chat. Shared between the popup's Add button and external callers.
 */
async function addNpubContact(
  managers: Managers,
  npub: string,
  nickname: string,
  onContactAdded?: (peerId: PeerId) => void
): Promise<void> {
  const {decodePubkey} = await import('@lib/nostra/nostr-identity');
  const {NostraBridge} = await import('@lib/nostra/nostra-bridge');

  const hexPubkey = decodePubkey(npub);
  const bridge = NostraBridge.getInstance();
  const peerId = await bridge.mapPubkeyToPeerId(hexPubkey);

  if(nickname && nickname.trim()) {
    const {storeMapping} = await import('@lib/nostra/virtual-peers-db');
    await storeMapping(hexPubkey, peerId, nickname.trim());
  }

  const appImManager = (await import('@lib/appImManager')).default;
  appImManager.setInnerPeer({peerId});

  onContactAdded?.(peerId);
}
```

**Note:** this extraction DOES NOT yet use `KeyExchange` or `QRScanner` — those are built in later tasks. The `launchQRScanner` dynamic import will be satisfied by Task 5.

- [ ] **Step 3: Replace the body in `contacts.ts`**

Open `src/components/sidebarLeft/tabs/contacts.ts`. Replace the entire `showAddContactPopup` method body (currently lines 328-410) with a delegation:

```typescript
  private showAddContactPopup() {
    showAddContactPopup({managers: this.managers});
  }
```

Add the import at the top:

```typescript
import {showAddContactPopup} from '@components/popups/addContact';
```

Since the method is now a one-liner, consider removing it entirely and calling `showAddContactPopup` directly from the attachClickEvent handler. If you remove the method, also update line ~39 to call the imported function directly.

**Note on duplication with inlined `handleNpubInput`:** the `contacts.ts` file already has a `handleNpubInput` method for the search-paste flow. Keep it — it serves a different surface (search input). The extracted `addNpubContact` in the popup module is functionally equivalent but owned by the popup. DRY fix for this duplication is out of scope.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "vendor/emoji\|vendor/bezierEasing"`
Expected: no new errors. The `launchQRScanner` dynamic import will resolve at runtime once Task 5 lands — tsc will flag it as unresolved. To avoid a blocking error, use `as any` on the import:

```typescript
const {launchQRScanner} = await import('@components/nostra/QRScanner' as any);
```

Remove the `as any` in Task 5 once `QRScanner.tsx` exists.

- [ ] **Step 5: Commit**

```bash
git add src/components/popups/addContact.ts src/components/sidebarLeft/tabs/contacts.ts
git commit -m "refactor(contacts): extract showAddContactPopup into shared module"
```

---

## Task 4: `KeyExchange.tsx` display (no scanner yet)

**Files:**
- Create: `src/components/nostra/KeyExchange.tsx`
- Create: `src/components/nostra/key-exchange.module.scss`
- Test: `src/tests/nostra/key-exchange.test.ts`

- [ ] **Step 1: Write the failing smoke test**

Create `src/tests/nostra/key-exchange.test.ts`:

```typescript
import {describe, it, expect, vi, beforeEach, afterAll} from 'vitest';
import {render, cleanup} from '@solidjs/testing-library';

// Mock useNostraIdentity with fixed values
vi.mock('@stores/nostraIdentity', () => ({
  default: () => ({
    npub: () => 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m',
    displayName: () => 'Alice',
    nip05: () => 'alice@example.com',
    picture: () => ''
  })
}));

// Mock qr-code-styling to avoid canvas in jsdom
vi.mock('qr-code-styling', () => ({
  default: class {
    append(el: HTMLElement) {
      el.innerHTML = '<svg data-testid="qr-svg"></svg>';
    }
    getRawData() { return Promise.resolve(new Blob()); }
    download() {}
  }
}));

// Mock avatar fallback
vi.mock('@lib/nostra/avatar-fallback', () => ({
  getAvatarURL: (npub: string) => `https://dicebear.test/${npub}`,
  getAvatarDataURL: async(npub: string) => `data:image/svg+xml;base64,${npub}`
}));

describe('KeyExchange', () => {
  beforeEach(() => {
    cleanup();
  });

  afterAll(() => {
    vi.unmock('@stores/nostraIdentity');
    vi.unmock('qr-code-styling');
    vi.unmock('@lib/nostra/avatar-fallback');
    vi.restoreAllMocks();
  });

  it('renders QR container, identity info, and scan button', async() => {
    const {default: KeyExchange} = await import('@components/nostra/KeyExchange');
    const {container, findByTestId, getByText} = render(() => <KeyExchange />);

    // QR container exists
    const qrContainer = await findByTestId('qr-container');
    expect(qrContainer).toBeTruthy();

    // Display name rendered
    expect(getByText('Alice')).toBeTruthy();

    // Scan button is present
    const scanBtn = container.querySelector('[data-testid="scan-btn"]');
    expect(scanBtn).toBeTruthy();
  });

  it('scan button invokes onScanClick callback', async() => {
    const {default: KeyExchange} = await import('@components/nostra/KeyExchange');
    const onScanClick = vi.fn();
    const {container} = render(() => <KeyExchange onScanClick={onScanClick} />);

    const scanBtn = container.querySelector('[data-testid="scan-btn"]') as HTMLButtonElement;
    scanBtn.click();
    expect(onScanClick).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/nostra/key-exchange.test.ts`
Expected: FAIL — module `@components/nostra/KeyExchange` not found.

- [ ] **Step 3: Create SCSS module**

Create `src/components/nostra/key-exchange.module.scss`:

```scss
.wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px;
  gap: 16px;
}

.qr {
  width: 280px;
  height: 280px;
  padding: 12px;
  background: #ffffff;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;

  svg, canvas {
    width: 100%;
    height: 100%;
  }
}

.info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.name {
  font-size: 17px;
  font-weight: 600;
  color: var(--primary-text-color);
}

.nip05 {
  font-size: 13px;
  color: var(--accent-color);
  display: flex;
  align-items: center;
  gap: 4px;
}

.actions {
  display: flex;
  gap: 8px;
  width: 100%;
  max-width: 320px;

  button {
    flex: 1;
    padding: 10px 16px;
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--surface-color);
    color: var(--primary-text-color);
    font-size: 14px;
    cursor: pointer;

    &:hover {
      background: var(--light-filled-secondary-text-color);
    }
  }
}

.divider {
  display: flex;
  align-items: center;
  width: 100%;
  max-width: 320px;
  color: var(--secondary-text-color);
  font-size: 12px;
  text-transform: uppercase;
  gap: 12px;

  &::before, &::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border-color);
  }
}

.scanBtn {
  width: 100%;
  max-width: 320px;
  padding: 14px 16px;
  border: none;
  border-radius: 12px;
  background: var(--accent-color);
  color: #fff;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;

  &:hover {
    filter: brightness(1.1);
  }
}
```

- [ ] **Step 4: Implement `KeyExchange.tsx`**

Create `src/components/nostra/KeyExchange.tsx`:

```typescript
import {createSignal, onMount, onCleanup, Show} from 'solid-js';
import classNames from '@helpers/string/classNames';
import useNostraIdentity from '@stores/nostraIdentity';
import {getAvatarDataURL} from '@lib/nostra/avatar-fallback';
import styles from './key-exchange.module.scss';

export interface KeyExchangeProps {
  class?: string;
  onScanClick?: () => void;
}

export default function KeyExchange(props: KeyExchangeProps) {
  const {npub, displayName, nip05, picture} = useNostraIdentity();
  const [copied, setCopied] = createSignal(false);
  let qrContainer: HTMLDivElement | undefined;
  let qrInstance: any = null;
  let copiedTimeout: ReturnType<typeof setTimeout> | undefined;

  onMount(async() => {
    const currentNpub = npub();
    if(!currentNpub || !qrContainer) return;

    const avatarDataURL = await getAvatarDataURL(currentNpub, picture());

    const {default: QRCodeStyling} = await import('qr-code-styling' as any);
    qrInstance = new QRCodeStyling({
      width: 280,
      height: 280,
      data: 'nostr:' + currentNpub,
      image: avatarDataURL,
      imageOptions: {
        crossOrigin: 'anonymous',
        margin: 6,
        imageSize: 0.25,
        hideBackgroundDots: true
      },
      qrOptions: {
        errorCorrectionLevel: 'H'
      },
      dotsOptions: {
        color: '#1a1a2e',
        type: 'rounded'
      },
      cornersSquareOptions: {
        type: 'extra-rounded'
      },
      backgroundOptions: {
        color: '#ffffff'
      }
    });

    qrInstance.append(qrContainer);
  });

  onCleanup(() => {
    if(copiedTimeout) clearTimeout(copiedTimeout);
    if(qrContainer) qrContainer.innerHTML = '';
  });

  const handleCopy = async() => {
    const currentNpub = npub();
    if(!currentNpub) return;
    try {
      await navigator.clipboard.writeText(currentNpub);
      setCopied(true);
      copiedTimeout = setTimeout(() => setCopied(false), 2000);
    } catch(err) {
      console.warn('Failed to copy npub:', err);
    }
  };

  const handleShare = async() => {
    if(!qrInstance) return;
    try {
      if(typeof navigator.share === 'function') {
        const blob = await qrInstance.getRawData('png');
        if(blob) {
          const file = new File([blob], 'nostra-qr.png', {type: 'image/png'});
          await navigator.share({
            title: 'My Nostra.chat QR',
            text: npub() || '',
            files: [file]
          });
          return;
        }
      }
      qrInstance.download({name: 'nostra-qr', extension: 'png'});
    } catch(_) {
      try {
        qrInstance.download({name: 'nostra-qr', extension: 'png'});
      } catch(err) {
        console.warn('Failed to share/download QR:', err);
      }
    }
  };

  const truncateNpub = (value: string): string => {
    if(value.length <= 16) return value;
    return value.slice(0, 10) + '...' + value.slice(-6);
  };

  return (
    <div class={classNames(styles.wrap, props.class)}>
      <div class={styles.qr} ref={qrContainer} data-testid="qr-container" />

      <div class={styles.info}>
        <div class={styles.name}>
          {displayName() || truncateNpub(npub() || '')}
        </div>
        <Show when={nip05()}>
          <div class={styles.nip05}>
            <span>&#10003;</span>
            <span>{nip05()}</span>
          </div>
        </Show>
      </div>

      <div class={styles.actions}>
        <button onClick={handleCopy}>
          {copied() ? 'Copied!' : 'Copy npub'}
        </button>
        <button onClick={handleShare}>Share QR</button>
      </div>

      <div class={styles.divider}>or scan</div>

      <button
        class={styles.scanBtn}
        data-testid="scan-btn"
        onClick={() => props.onScanClick?.()}
      >
        Scan QR
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/tests/nostra/key-exchange.test.ts`
Expected: PASS (2 tests). If `@solidjs/testing-library` is not installed, fall back to a manual DOM test using Solid's `render` from `@vendor/solid/web` — check how other Solid tests in `src/tests/` mount components and follow that pattern.

- [ ] **Step 6: Commit**

```bash
git add src/components/nostra/KeyExchange.tsx src/components/nostra/key-exchange.module.scss src/tests/nostra/key-exchange.test.ts
git commit -m "feat(nostra): KeyExchange component with avatar-centered QR"
```

---

## Task 5: `QRScanner.tsx` fullscreen overlay

**Files:**
- Create: `src/components/nostra/QRScanner.tsx`
- Modify: `src/components/nostra/key-exchange.module.scss` (append scanner styles)
- Modify: `src/components/popups/addContact.ts` (remove `as any` on import)

- [ ] **Step 1: Append scanner styles to `key-exchange.module.scss`**

Append to `src/components/nostra/key-exchange.module.scss`:

```scss
.scannerOverlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: #000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.scannerVideo {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.scannerDim {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.scannerViewfinder {
  position: relative;
  width: 260px;
  height: 260px;
  border-radius: 24px;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.6);
  z-index: 1;

  &::before, &::after,
  .corner {
    content: '';
    position: absolute;
    width: 32px;
    height: 32px;
    border: 3px solid var(--accent-color, #4caf50);
  }

  &::before {
    top: 0;
    left: 0;
    border-right: none;
    border-bottom: none;
    border-top-left-radius: 16px;
  }

  &::after {
    top: 0;
    right: 0;
    border-left: none;
    border-bottom: none;
    border-top-right-radius: 16px;
  }
}

.scannerViewfinderError {
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.6), inset 0 0 0 3px rgba(255, 68, 68, 0.9);
  transition: box-shadow 0.15s;
}

.scannerClose {
  position: absolute;
  top: 16px;
  left: 16px;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  border: none;
  color: #fff;
  font-size: 20px;
  cursor: pointer;
  z-index: 2;
}

.scannerHint {
  position: absolute;
  bottom: 10%;
  color: #fff;
  font-size: 15px;
  z-index: 2;
  text-align: center;
  padding: 0 24px;
}

.scannerError {
  position: relative;
  z-index: 2;
  color: #fff;
  text-align: center;
  padding: 24px;

  button {
    margin-top: 16px;
    padding: 10px 20px;
    border-radius: 10px;
    border: none;
    background: var(--accent-color);
    color: #fff;
    cursor: pointer;
  }
}
```

- [ ] **Step 2: Implement `QRScanner.tsx`**

Create `src/components/nostra/QRScanner.tsx`:

```typescript
import {createSignal, onCleanup, onMount, Show} from 'solid-js';
import {render} from 'solid-js/web';
import {parseQRPayload} from '@lib/nostra/qr-payload';
import {toast} from '@components/toast';
import styles from './key-exchange.module.scss';

export interface QRScannerProps {
  onDetected: (npub: string) => void;
  onClose?: () => void;
}

type ScannerState =
  | {kind: 'loading'}
  | {kind: 'scanning'}
  | {kind: 'denied'}
  | {kind: 'nocamera'};

function QRScannerComponent(props: QRScannerProps) {
  const [state, setState] = createSignal<ScannerState>({kind: 'loading'});
  const [errorFlash, setErrorFlash] = createSignal(false);
  let videoEl: HTMLVideoElement | undefined;
  let canvasEl: HTMLCanvasElement | undefined;
  let stream: MediaStream | null = null;
  let rafId: number | null = null;
  let detected = false;
  let flashTimeout: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    if(rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if(stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if(flashTimeout) clearTimeout(flashTimeout);
  };

  const close = () => {
    cleanup();
    props.onClose?.();
  };

  const flashError = () => {
    setErrorFlash(true);
    if(flashTimeout) clearTimeout(flashTimeout);
    flashTimeout = setTimeout(() => setErrorFlash(false), 400);
  };

  onMount(async() => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: 'environment'}
      });
    } catch(err: any) {
      if(err?.name === 'NotAllowedError') {
        setState({kind: 'denied'});
      } else if(err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') {
        // Retry without facingMode constraint
        try {
          stream = await navigator.mediaDevices.getUserMedia({video: true});
        } catch(_) {
          setState({kind: 'nocamera'});
          return;
        }
      } else {
        setState({kind: 'nocamera'});
        return;
      }
    }

    if(!stream || !videoEl) return;
    videoEl.srcObject = stream;
    await videoEl.play().catch(() => {});
    setState({kind: 'scanning'});

    const jsQRModule = await import('jsqr');
    const jsQR = jsQRModule.default;

    const tick = () => {
      if(detected || !videoEl || !canvasEl) return;
      if(videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
        const ctx = canvasEl.getContext('2d', {willReadFrequently: true});
        if(!ctx) return;
        canvasEl.width = videoEl.videoWidth;
        canvasEl.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
        const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert'
        });
        if(code) {
          const result = parseQRPayload(code.data);
          if('npub' in result) {
            detected = true;
            cleanup();
            props.onDetected(result.npub);
            props.onClose?.();
            return;
          }
          if(result.error === 'self') {
            toast("That's your own QR");
            flashError();
          } else if(result.error === 'unsupported') {
            toast('Hex pubkeys are not supported — scan an npub QR');
            flashError();
          } else {
            toast('Not a Nostr QR code');
            flashError();
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  });

  onCleanup(cleanup);

  return (
    <div class={styles.scannerOverlay} data-testid="qr-scanner-overlay">
      <button class={styles.scannerClose} onClick={close} aria-label="Close scanner">✕</button>

      <Show when={state().kind === 'scanning'}>
        <video ref={videoEl} class={styles.scannerVideo} autoplay playsinline muted />
        <canvas ref={canvasEl} style="display:none" />
        <div classList={{[styles.scannerViewfinder]: true, [styles.scannerViewfinderError]: errorFlash()}} />
        <div class={styles.scannerHint}>Point camera at QR code</div>
      </Show>

      <Show when={state().kind === 'denied'}>
        <div class={styles.scannerError}>
          <div>Camera access denied</div>
          <div style="font-size:13px;opacity:0.7;margin-top:8px;">Enable camera permission in your browser settings and try again.</div>
          <button onClick={close}>Close</button>
        </div>
      </Show>

      <Show when={state().kind === 'nocamera'}>
        <div class={styles.scannerError}>
          <div>No camera found</div>
          <button onClick={close}>Close</button>
        </div>
      </Show>

      <Show when={state().kind === 'loading'}>
        <div class={styles.scannerError}>
          <div>Starting camera…</div>
        </div>
      </Show>
    </div>
  );
}

/**
 * Imperatively launch the QR scanner overlay. Returns a disposer that
 * unmounts it. The scanner also unmounts itself on detection or close.
 */
export function launchQRScanner(props: QRScannerProps): () => void {
  const host = document.createElement('div');
  document.body.append(host);

  const dispose = render(
    () => (
      <QRScannerComponent
        onDetected={props.onDetected}
        onClose={() => {
          props.onClose?.();
          dispose();
          host.remove();
        }}
      />
    ),
    host
  );

  return () => {
    dispose();
    host.remove();
  };
}

export default QRScannerComponent;
```

- [ ] **Step 3: Remove the `as any` cast from `addContact.ts`**

Open `src/components/popups/addContact.ts` and change:

```typescript
const {launchQRScanner} = await import('@components/nostra/QRScanner' as any);
```

to:

```typescript
const {launchQRScanner} = await import('@components/nostra/QRScanner');
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "vendor/emoji\|vendor/bezierEasing"`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/nostra/QRScanner.tsx src/components/nostra/key-exchange.module.scss src/components/popups/addContact.ts
git commit -m "feat(nostra): QRScanner fullscreen overlay with jsQR decode"
```

---

## Task 6: Wire scanner into `KeyExchange` + Settings launch

**Files:**
- Modify: `src/components/nostra/KeyExchange.tsx`
- Create: `src/components/sidebarLeft/tabs/nostraQR.ts`
- Modify: `src/components/sidebarLeft/tabs/settings.ts`

- [ ] **Step 1: Wire scanner launcher into `KeyExchange`**

Open `src/components/nostra/KeyExchange.tsx`. Update the `onScanClick` default behavior so the component can operate standalone (when used inside Settings). Replace the Scan button's `onClick`:

```typescript
const handleScan = async() => {
  if(props.onScanClick) {
    props.onScanClick();
    return;
  }
  const {launchQRScanner} = await import('./QRScanner');
  launchQRScanner({
    onDetected: async(scannedNpub) => {
      const {NostraBridge} = await import('@lib/nostra/nostra-bridge');
      const {decodePubkey} = await import('@lib/nostra/nostr-identity');
      const bridge = NostraBridge.getInstance();
      const hex = decodePubkey(scannedNpub);
      const peerId = await bridge.mapPubkeyToPeerId(hex);
      const appImManager = (await import('@lib/appImManager')).default;
      appImManager.setInnerPeer({peerId});
    }
  });
};
```

And change:

```typescript
<button class={styles.scanBtn} data-testid="scan-btn" onClick={handleScan}>
  Scan QR
</button>
```

- [ ] **Step 2: Create `nostraQR.ts` slider sub-tab**

First find the SliderSuperTab pattern used by other Nostra tabs:

Run: `grep -l "SliderSuperTab" src/components/sidebarLeft/tabs/ | head -3`

Open one (e.g. `nostraNewGroup.ts`) and mirror its structure.

Create `src/components/sidebarLeft/tabs/nostraQR.ts`:

```typescript
import {SliderSuperTab} from '@components/slider';
import {render} from 'solid-js/web';

export default class AppNostraQRTab extends SliderSuperTab {
  private mountPoint?: HTMLDivElement;
  private dispose?: () => void;

  public async init() {
    this.container.classList.add('nostra-qr-tab');
    this.setTitle('My QR Code');

    this.mountPoint = document.createElement('div');
    this.scrollable.append(this.mountPoint);

    const {default: KeyExchange} = await import('@components/nostra/KeyExchange');
    this.dispose = render(() => <KeyExchange />, this.mountPoint);
  }

  protected onCloseAfterTimeout(): Promise<void> {
    this.dispose?.();
    return super.onCloseAfterTimeout();
  }
}
```

**Note:** `nostraQR.ts` contains JSX so the file extension must be `.tsx`:

Rename to `src/components/sidebarLeft/tabs/nostraQR.tsx`. Other Nostra tab files in the same directory that use JSX already use `.tsx` — confirm with `ls src/components/sidebarLeft/tabs/nostra*`.

- [ ] **Step 3: Add "My QR Code" row to Settings**

Open `src/components/sidebarLeft/tabs/settings.ts`. Locate where the existing Profile / Edit Profile row is created (grep for `EditProfile` or `Profile`). Add a new Row immediately below:

```typescript
import AppNostraQRTab from './nostraQR';

// ...inside the tab init, near the existing Profile row:
const qrRow = new Row({
  icon: 'qrcode',
  titleLangKey: 'MyQRCode' as any, // fallback if lang key missing
  clickable: () => {
    this.slider.createTab(AppNostraQRTab).open();
  },
  listenerSetter: this.listenerSetter
});
// Append after the profile row's parent container
profileRowContainer.append(qrRow.container);
```

**Note:** the exact wiring depends on the current settings layout. Read `settings.ts` first:

Run: `grep -n "new Row\|createTab\|profile" src/components/sidebarLeft/tabs/settings.ts | head -30`

Pick the insertion point that matches the existing pattern (likely near an existing `new Row({icon: '...', ...})` call in the profile section). If no `qrcode` icon exists, use `'lock'` or `'info'` as a placeholder and open an issue for the icon — do NOT invent a new icon.

Run: `grep -rn "'qrcode'" src/components/ | head -5` to check if the icon exists. If not, run `grep -rn "icon: '" src/components/sidebarLeft/tabs/settings.ts` and pick the closest existing icon from the settings tab.

- [ ] **Step 4: Add lang strings**

Open `src/lang.ts` and add:

```typescript
'MyQRCode': 'My QR Code',
'AddContact': 'Add Contact',
'ScanQR': 'Scan QR',
'PointCameraAtQR': 'Point camera at QR code',
'CameraAccessDenied': 'Camera access denied',
'NoCameraFound': 'No camera found',
'NotANostrQR': 'Not a Nostr QR code',
'ThatsYourOwnQR': "That's your own QR",
```

Insert them alphabetically among the existing keys. Run `grep -n "'My" src/lang.ts | head -5` to find the alphabetical neighborhood.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "vendor/emoji\|vendor/bezierEasing"`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/nostra/KeyExchange.tsx src/components/sidebarLeft/tabs/nostraQR.tsx src/components/sidebarLeft/tabs/settings.ts src/lang.ts
git commit -m "feat(nostra): Settings row + sub-tab for KeyExchange view"
```

---

## Task 7: FAB pencil menu — "Add Contact" entry

**Files:**
- Modify: `src/components/sidebarLeft/index.ts`

- [ ] **Step 1: Locate `createNewChatsMenuOptions`**

Run: `grep -n "createNewChatsMenuOptions\|onNewGroupClick\|onContactsClick" src/components/sidebarLeft/index.ts`
Expected: line ~1030 (`onNewGroupClick`), ~1046 (`onContactsClick`), ~1052 (return array).

- [ ] **Step 2: Add Add Contact handler and entry**

Around line 1050, add a new click handler:

```typescript
const onAddContactClick = () => {
  closeTabsBefore(async() => {
    const {showAddContactPopup} = await import('@components/popups/addContact');
    showAddContactPopup({managers: this.managers});
  });
};
```

Then in the returned array (around line 1052), add a new entry between `newgroup` and `newprivate`:

```typescript
return [{
  icon: 'newchannel',
  text: singular ? 'Channel' : 'NewChannel',
  onClick: () => {
    closeTabsBefore(() => {
      this.createTab(AppNewChannelTab).open();
    });
  }
}, {
  icon: 'newgroup',
  text: singular ? 'Group' : 'NewGroup',
  onClick: onNewGroupClick
}, {
  icon: 'adduser',
  text: 'AddContact',
  onClick: onAddContactClick
}, {
  icon: 'newprivate',
  text: singular ? 'PrivateChat' : 'NewPrivateChat',
  onClick: onContactsClick
}];
```

- [ ] **Step 3: Verify `adduser` icon exists**

Run: `grep -rn "'adduser'" src/components/ | head -3`
Expected: at least one match (icon is standard in tweb). If missing, substitute with the closest existing icon (e.g. `'add'` or `'user'`) — find candidates via `grep -n "icon: '" src/components/sidebarLeft/index.ts`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "vendor/emoji\|vendor/bezierEasing"`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebarLeft/index.ts
git commit -m "feat(sidebar): add Add Contact entry to FAB pencil menu"
```

---

## Task 8: Delete orphan `QRIdentity`

**Files:**
- Delete: `src/components/nostra/QRIdentity.tsx`
- Delete: `src/tests/nostra/qr-identity.test.ts`

- [ ] **Step 1: Confirm no imports**

Run: `grep -rn "QRIdentity" src/ --include="*.ts" --include="*.tsx"`
Expected: matches only inside `QRIdentity.tsx` itself and `qr-identity.test.ts`. If any other file imports it, STOP and reconcile before deleting.

- [ ] **Step 2: Delete**

```bash
rm src/components/nostra/QRIdentity.tsx
rm src/tests/nostra/qr-identity.test.ts
```

- [ ] **Step 3: Typecheck + run all nostra unit tests**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "vendor/emoji\|vendor/bezierEasing"
npx vitest run src/tests/nostra/
```

Expected: no new TS errors. Vitest shows all passing (KeyExchange + qr-payload tests green, qr-identity file gone from output).

- [ ] **Step 4: Commit**

```bash
git add -u src/components/nostra/QRIdentity.tsx src/tests/nostra/qr-identity.test.ts
git commit -m "chore(nostra): remove orphan QRIdentity, replaced by KeyExchange"
```

---

## Task 9: E2E test

**Files:**
- Create: `src/tests/e2e/e2e-qr-key-exchange.ts`
- Modify: `src/tests/e2e/run-all.sh`

- [ ] **Step 1: Review an existing E2E test for boot pattern**

Run: `cat src/tests/e2e/e2e-bug-regression.ts | head -80`

Observe the standard boot pattern (goto → waitForTimeout → reload → waitForTimeout, wait on onboarding selector, dismiss overlays).

- [ ] **Step 2: Write `e2e-qr-key-exchange.ts`**

Create `src/tests/e2e/e2e-qr-key-exchange.ts`:

```typescript
// @ts-nocheck
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = process.env.E2E_APP_URL || process.env.APP_URL || 'http://localhost:8080';

async function main() {
  const browser = await chromium.launch(launchOptions());
  const ctx = await browser.newContext({permissions: ['clipboard-read', 'clipboard-write']});
  const page = await ctx.newPage();

  console.log('[test] boot');
  await page.goto(APP_URL, {waitUntil: 'load'});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load'});
  await page.waitForTimeout(15000);

  // Onboard
  await page.waitForSelector('button:has-text("Create New Identity")', {timeout: 30000});
  await page.click('button:has-text("Create New Identity")');
  await page.waitForTimeout(1000);

  // Skip any setup that blocks
  const skipBtn = page.locator('text=SKIP').first();
  if(await skipBtn.isVisible().catch(() => false)) {
    await skipBtn.click();
  }
  await page.waitForTimeout(3000);
  await dismissOverlays(page);

  // ----- Test 1: Settings -> My QR Code -----
  console.log('[test] open hamburger');
  await page.waitForSelector('.sidebar-header .btn-menu-toggle', {timeout: 30000});

  // Solid delegation workaround: dispatch synthetic mousedown + click on the same element
  await page.evaluate(() => {
    const btn = document.querySelector('.sidebar-header .btn-menu-toggle') as HTMLElement;
    btn.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
    btn.dispatchEvent(new MouseEvent('click', {bubbles: true}));
  });
  await page.waitForTimeout(500);

  // Click Settings menu item
  const settingsBtn = page.locator('.btn-menu-item:has-text("Settings")').first();
  await settingsBtn.click();
  await page.waitForTimeout(1000);

  // Click "My QR Code" row
  console.log('[test] click My QR Code');
  await page.locator('.row:has-text("My QR Code")').first().click();
  await page.waitForTimeout(1500);

  // Assert QR container rendered
  const qrContainer = await page.locator('[data-testid="qr-container"]').count();
  if(qrContainer === 0) throw new Error('QR container not rendered');
  console.log('[test] QR container rendered ✓');

  // Assert Scan button present
  const scanBtn = await page.locator('[data-testid="scan-btn"]').count();
  if(scanBtn === 0) throw new Error('Scan button not rendered');
  console.log('[test] Scan button rendered ✓');

  // Click Copy npub and verify clipboard
  await page.locator('button:has-text("Copy npub")').first().click();
  await page.waitForTimeout(500);
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  if(!clipboard.startsWith('npub1')) throw new Error('Clipboard does not contain npub: ' + clipboard);
  console.log('[test] Copy npub works ✓');

  // Close the Settings tab (go back to chat list)
  await page.evaluate(() => {
    const back = document.querySelector('.sidebar-slider-item-inner .sidebar-back-button') as HTMLElement;
    back?.click();
  });
  await page.waitForTimeout(500);

  // ----- Test 2: FAB pencil -> Add Contact -----
  console.log('[test] open FAB pencil');
  await page.locator('#new-menu').click();
  await page.waitForTimeout(500);

  // Assert new Add Contact entry is visible
  const addContactEntry = page.locator('.btn-menu-item:has-text("Add Contact")');
  const addContactCount = await addContactEntry.count();
  if(addContactCount === 0) throw new Error('Add Contact menu entry missing');
  console.log('[test] Add Contact FAB entry rendered ✓');

  await addContactEntry.first().click();
  await page.waitForTimeout(500);

  // Popup visible
  const popup = await page.locator('.popup-add-contact-overlay').count();
  if(popup === 0) throw new Error('Add Contact popup did not open');
  console.log('[test] Add Contact popup opened ✓');

  // Click Scan QR → overlay should mount
  await page.locator('[data-testid="add-contact-scan-qr"]').click();
  await page.waitForTimeout(1000);

  const overlay = await page.locator('[data-testid="qr-scanner-overlay"]').count();
  if(overlay === 0) throw new Error('QR scanner overlay did not mount');
  console.log('[test] QR scanner overlay mounted ✓');

  // Close scanner (may show "Camera access denied" or "No camera found" in headless — close button works regardless)
  await page.locator('[data-testid="qr-scanner-overlay"] button[aria-label="Close scanner"]').click();
  await page.waitForTimeout(500);

  const overlayAfter = await page.locator('[data-testid="qr-scanner-overlay"]').count();
  if(overlayAfter !== 0) throw new Error('QR scanner overlay did not unmount on close');
  console.log('[test] Scanner close works ✓');

  console.log('[test] ALL PASS');
  await browser.close();
}

main().catch(async(err) => {
  console.error('[test] FAIL', err);
  process.exit(1);
});
```

- [ ] **Step 3: Register in run-all.sh**

Open `src/tests/e2e/run-all.sh`. Find the `TESTS` array and append `"e2e-qr-key-exchange.ts"` as a new entry, matching the existing quoting style.

- [ ] **Step 4: Run the test**

Start the dev server in the background:

```bash
pnpm start &
sleep 20
```

Then:

```bash
pnpm test:e2e src/tests/e2e/e2e-qr-key-exchange.ts
```

Expected: all `[test]` log lines print with ✓ and final `ALL PASS`. If the camera denies headlessly the test still passes because it only asserts the overlay mounts and unmounts (not the video stream).

Kill the dev server:

```bash
pkill -f "vite"
```

- [ ] **Step 5: Commit**

```bash
git add src/tests/e2e/e2e-qr-key-exchange.ts src/tests/e2e/run-all.sh
git commit -m "test(e2e): QR key exchange end-to-end flow"
```

---

## Task 10: Document manual verification in CHECKLIST

**Files:**
- Modify: `docs/CHECKLIST_v2.md`

- [ ] **Step 1: Append manual verification section**

Open `docs/CHECKLIST_v2.md` and append (or insert under a suitable feature section):

```markdown
### QR Key Exchange (manual verification)

1. On a mobile device, open Settings → My QR Code. Confirm the QR displays with the avatar centered. If no kind 0 picture, the dicebear emoji avatar must appear in the center.
2. Tap "Copy npub". Paste into a text field elsewhere to confirm it matches the displayed identity.
3. Tap "Scan QR" from the same view. Grant camera permission. Scan another user's Nostra QR. Expected: the chat with that user opens directly.
4. Open the FAB pencil menu. Confirm "Add Contact" is visible between "New Group" and "New Private Chat".
5. Tap "Add Contact". In the popup, tap "Scan QR". Grant camera permission. Scan another user's Nostra QR. Expected: the popup's npub input fills with the scanned value, nickname field is focused, no auto-submit.
6. Scan a non-Nostr QR (e.g., a plain URL). Expected: red flash on viewfinder + toast "Not a Nostr QR code", scanner stays open.
7. Scan your own QR. Expected: toast "That's your own QR", scanner stays open.
8. Deny camera permission. Expected: "Camera access denied" message with Close button, no crash.
```

- [ ] **Step 2: Commit**

```bash
git add docs/CHECKLIST_v2.md
git commit -m "docs: manual verification steps for QR key exchange"
```

---

## Task 11: Final verification

- [ ] **Step 1: Run unit tests**

```bash
npx vitest run src/tests/nostra/qr-payload.test.ts src/tests/nostra/key-exchange.test.ts
```

Expected: 11 tests pass (9 in qr-payload + 2 in key-exchange).

- [ ] **Step 2: Run quick nostra suite**

```bash
pnpm test:nostra:quick
```

Expected: `Tests N passed (N)` line shows all green (exit code may be non-zero due to pre-existing tor-ui unhandled rejections — verify the passed line, not exit code, per CLAUDE.md).

- [ ] **Step 3: Full typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "vendor/emoji\|vendor/bezierEasing"
```

Expected: no new errors (pre-existing ~30 vendor errors ignored).

- [ ] **Step 4: Lint**

```bash
pnpm lint 2>&1 | tail -20
```

Expected: no errors in files touched by this plan. Warnings unrelated to new files are OK.

- [ ] **Step 5: Production build smoke**

```bash
pnpm build 2>&1 | tail -20
```

Expected: build succeeds. If the bundle flags `jsqr` or `qr-code-styling` as dynamic-import-only (expected for lazy loads), that's fine — this plan uses dynamic imports deliberately to keep cold start light.

- [ ] **Step 6: Final commit (no-op or docs)**

If anything was fixed during final verification, commit. Otherwise nothing to do.

---

## Acceptance checklist

- [ ] `parseQRPayload` handles npub, `nostr:npub`, NIP-21 case-insensitive, hex (unsupported), self, invalid
- [ ] `KeyExchange.tsx` displays QR with centered avatar (dicebear fallback)
- [ ] QR uses `errorCorrectionLevel: 'H'` and `nostr:` NIP-21 payload
- [ ] `QRScanner.tsx` mounts fullscreen, decodes via jsQR, handles denied/nocamera/self/unsupported
- [ ] Settings → "My QR Code" row opens `KeyExchange` in a slider sub-tab
- [ ] Add Contact popup's Scan QR button mounts the scanner and fills the input on detection
- [ ] FAB pencil menu shows "Add Contact" between New Group and New Private Chat
- [ ] `QRIdentity.tsx` and its test are deleted
- [ ] Unit tests pass; E2E test registered in `run-all.sh`
- [ ] Manual verification steps added to `docs/CHECKLIST_v2.md`
