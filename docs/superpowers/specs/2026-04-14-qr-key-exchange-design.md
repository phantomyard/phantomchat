# QR Key Exchange & Add Contact UX

**Date:** 2026-04-14
**Status:** Approved for planning
**Scope:** New feature — in-person Nostr pubkey exchange via QR display + scanner, plus FAB menu UX improvement.

## Problem

Two people meeting in person have no friction-free way to swap Nostr pubkeys in Nostra.chat today. `QRIdentity.tsx` exists in the tree but is orphaned (never mounted). The Add Contact popup has a placeholder "Scan QR" button that only shows a "coming soon" toast. The FAB pencil menu only offers NewChannel/NewGroup/NewPrivateChat — adding a contact requires navigating into the contacts tab first, which is unintuitive.

## Goals

1. A single shared view (`KeyExchange`) that displays the user's own QR **with their avatar centered inside the code** and offers a "Scan QR" CTA.
2. The same view is reachable from two entry points:
   - Settings → new "My QR Code" row
   - Add Contact popup → existing "Scan QR" button
3. A working fullscreen camera scanner (using the already-installed `jsqr`) that decodes NIP-21 `nostr:npub1…` URIs.
4. "Add Contact" becomes a first-class entry in the FAB pencil menu alongside New Group / New Private Chat.

## Non-Goals

- Decoding arbitrary Nostr URIs (nevent, nprofile, naddr). Only npub/nostr:npub is in scope.
- Hex-encoded pubkeys. Scanner rejects them with an explicit error.
- Generating QR codes for groups, channels, or messages.
- Testing the camera pipeline in headless CI. Manual verification only, documented in `docs/CHECKLIST_v2.md`.
- Touching the `newchannel` FAB entry (out of scope even though Nostra has no channels).

## Architecture

### New files

| File | Purpose |
|---|---|
| `src/components/nostra/KeyExchange.tsx` | Solid component: renders own QR (avatar-centered), identity info, Copy/Share buttons, and a "Scan QR" CTA that mounts `QRScanner`. Consumed by both Settings sub-tab and Add Contact popup. |
| `src/components/nostra/QRScanner.tsx` | Fullscreen overlay Solid component. Owns `getUserMedia` lifecycle, `<video>` + off-screen `<canvas>`, `requestAnimationFrame` jsQR decode loop. Emits `onDetected(npub)` / `onClose()`. |
| `src/components/nostra/key-exchange.module.scss` | Scoped styles for `KeyExchange` and `QRScanner` (shared module). Uses existing `--surface-color`, `--primary-text-color`, `--accent-color` tokens. |
| `src/lib/nostra/qr-payload.ts` | Pure function `parseQRPayload(raw: string): {npub: string} \| {error: 'invalid' \| 'unsupported' \| 'self'}`. Strips `nostr:` prefix case-insensitively, validates bech32 via existing `decodePubkey`. |
| `src/lib/nostra/avatar-fallback.ts` | Extracts the dicebear-from-npub helper currently inlined in `buildNostraProfileMenuContent` (`sidebarLeft/index.ts`) into a reusable module. Exports `getAvatarDataURL(npub, picture?): Promise<string>` — returns `picture` if present, else dicebear SVG dataURL. |
| `src/components/sidebarLeft/tabs/nostraQR.ts` | `SliderSuperTab` subclass that mounts `KeyExchange` inside the left-sidebar slider stack. Opened from Settings. |
| `src/components/popups/addContact.ts` | Extracted from `contacts.ts` — exports `showAddContactPopup(managers)` so the FAB can open it without routing through the Contacts tab. The Contacts tab imports the same module. No duplication. |
| `src/tests/nostra/qr-payload.test.ts` | Unit tests for `parseQRPayload`. |
| `src/tests/nostra/key-exchange.test.ts` | Smoke test: mount `KeyExchange` with mocked `useNostraIdentity`, assert QR container exists, Scan button wires handler. |
| `src/tests/e2e/e2e-qr-key-exchange.ts` | Playwright: Settings → My QR Code → QR renders → Copy npub works. FAB → Add Contact → popup → Scan QR → overlay mounts. |

### Modified files

| File | Change |
|---|---|
| `src/components/sidebarLeft/index.ts` (`createNewChatsMenuOptions` ~L1052) | Insert new menu entry between `newgroup` and `newprivate`: `{icon: 'adduser', text: 'AddContact', onClick: () => closeTabsBefore(() => showAddContactPopup(this.managers))}`. |
| `src/components/sidebarLeft/index.ts` (`buildNostraProfileMenuContent`) | Replace inlined dicebear logic with import from `@lib/nostra/avatar-fallback`. |
| `src/components/sidebarLeft/tabs/settings.ts` | Add new `Row` "My QR Code" below the Profile row, clicking opens `AppNostraQRTab`. Icon `qrcode` (or closest existing). |
| `src/components/sidebarLeft/tabs/contacts.ts` | Delete inline `showAddContactPopup` body; import from `@components/popups/addContact`. The existing Scan QR button in the popup (built inside the extracted module) mounts `QRScanner` and, on detection, sets `input.value = npub` + focuses the nickname field (does NOT auto-submit — user confirms). |
| `src/lang.ts` | Add strings: `AddContact`, `MyQRCode`, `ScanQR`, `PointCameraAtQR`, `CameraAccessDenied`, `NoCameraFound`, `NotANostrQR`, `ThatsYourOwnQR`. |

### Deleted files

| File | Reason |
|---|---|
| `src/components/nostra/QRIdentity.tsx` | Orphaned (grep confirms no imports). Replaced by `KeyExchange`. |
| `src/tests/nostra/qr-identity.test.ts` | Targets the deleted component. |

## Data flow

### QR display (top half of `KeyExchange`)

1. Read `npub()` and `picture()` from `useNostraIdentity()`.
2. `getAvatarDataURL(npub, picture)` → returns `picture` URL if set, else dicebear SVG dataURL generated deterministically from the npub.
3. Build QR payload: `'nostr:' + npub()` (NIP-21 URI for max client compatibility).
4. Instantiate `QRCodeStyling`:
   - `width: 280`, `height: 280`
   - `data: payload`
   - `image: avatarDataURL`
   - `imageOptions: { crossOrigin: 'anonymous', margin: 6, imageSize: 0.25, hideBackgroundDots: true }`
   - `qrOptions: { errorCorrectionLevel: 'H' }` — **mandatory** when a center image is present; compensates for the ~25% of occluded modules.
   - `dotsOptions: { type: 'rounded', color: '#1a1a2e' }`, `cornersSquareOptions: { type: 'extra-rounded' }` (keep existing styling aesthetic).
5. Append into `ref` container on `onMount`.
6. On `onCleanup`: clear container (qr-code-styling does not expose an explicit teardown; removing DOM node is sufficient).

### Scanner (`QRScanner.tsx`)

1. On mount: `navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })`. Fall back to default facing if rejected with `OverconstrainedError`.
2. Attach stream to `<video autoplay playsinline muted>` inside the overlay.
3. Off-screen `<canvas>` sized to video frame on `loadedmetadata`.
4. `requestAnimationFrame` loop:
   - `drawImage(video)` → `getImageData` → `jsQR(data, w, h, { inversionAttempts: 'dontInvert' })`.
   - On hit: call `parseQRPayload(result.data)`.
5. Dispatch on parse result:
   - `{npub}` and npub ≠ own → stop RAF loop, `track.stop()` on all tracks, call `props.onDetected(npub)`.
   - `{error: 'self'}` → toast "That's your own QR", continue loop (do not close).
   - `{error: 'invalid' | 'unsupported'}` → brief red flash on viewfinder border, toast "Not a Nostr QR code", continue loop.
6. Close button (top-left, `z-index: 9999`): stops tracks, cancels RAF, calls `props.onClose()`.

### Launch contexts

| Launched from | `onDetected` callback |
|---|---|
| Settings → My QR Code → Scan | Calls existing `handleNpubInput(npub)` (same path used when pasting an npub into the contacts search). Opens the resulting chat immediately. |
| Add Contact popup → Scan QR | Writes `npub` into the `input.value` field and focuses the nickname input. User reviews and clicks "Add" explicitly — no auto-submit. |

## Error handling (boundary only)

Per the project's "no defensive coding inside the codebase" rule (CLAUDE.md), error handling lives only at the camera API boundary and the parse boundary:

- `getUserMedia` rejected with `NotAllowedError` → overlay replaces the video area with "Camera access denied" message + close button. No retry loop.
- `getUserMedia` rejected with `NotFoundError` → same overlay, message "No camera found".
- `parseQRPayload` → typed result, no throws. Caller branches on the discriminated union.
- Self-pubkey detection → explicit `{error: 'self'}` branch, not a silent skip.

## FAB menu change

In `createNewChatsMenuOptions` (`sidebarLeft/index.ts:1052`), the returned array becomes:

```
[
  { icon: 'newchannel', text: singular ? 'Channel'   : 'NewChannel',   onClick: … },  // unchanged
  { icon: 'newgroup',   text: singular ? 'Group'     : 'NewGroup',     onClick: onNewGroupClick },  // unchanged
  { icon: 'adduser',    text: 'AddContact',                             onClick: onAddContactClick }, // NEW
  { icon: 'newprivate', text: singular ? 'PrivateChat' : 'NewPrivateChat', onClick: onContactsClick }  // unchanged
]
```

`onAddContactClick = () => closeTabsBefore(() => showAddContactPopup(this.managers))`.

## Layout reference

### `KeyExchange` (vertical stack, 340px max width in popup context, full column in tab context)

```
[ <  My QR Code                     ]   header (back arrow + title)
─────────────────────────────────────
                                         
          ┌──────────────┐
          │ ▓▓▓▓ ▓ ▓▓▓▓  │
          │ ▓  ( avatar ) ▓  │              280×280 QR, 70×70 avatar centered
          │ ▓▓▓▓ ▓ ▓▓▓▓  │
          └──────────────┘

         Display Name                      display_name or truncated npub
         ✓ user@domain                     nip05 if verified

      [ Copy npub ]   [ Share ]            identity actions

      ─────  or scan  ─────                divider

      [    📷  Scan QR    ]                primary scanner CTA
```

### `QRScanner` (fullscreen)

```
[ ✕                                  ]   close, top-left, z 9999
                                         
                                         
            ┌──────────┐
            │          │                   260×260 viewfinder
            │  video   │                   corner brackets in accent color
            │          │
            └──────────┘
                                         
      Point camera at QR code              hint text (lang key)
```

Background: live video with `object-fit: cover`. Dark overlay (`rgba(0,0,0,0.6)`) with a transparent square cut-out for the viewfinder (achieved via `box-shadow: 0 0 0 9999px rgba(0,0,0,0.6)` on the viewfinder element).

## Testing

### Unit (`src/tests/nostra/qr-payload.test.ts`)

- `npub1…` raw (valid bech32) → `{npub: '...'}`
- `nostr:npub1…` → `{npub: '...'}` (prefix stripped)
- `NOSTR:npub1…` → `{npub: '...'}` (case-insensitive prefix)
- `npub1short` → `{error: 'invalid'}`
- 64-char hex pubkey → `{error: 'unsupported'}`
- Random string → `{error: 'invalid'}`
- npub matching own pubkey (mock `window.__nostraOwnPubkey`) → `{error: 'self'}`

### Unit (`src/tests/nostra/key-exchange.test.ts`)

Smoke test: mount `KeyExchange` with mocked `useNostraIdentity` (stub `npub`, `displayName`, `picture`), assert `[data-testid="qr-container"]` is present, assert clicking `[data-testid="scan-btn"]` invokes a spy. Follows the vitest quirks in CLAUDE.md (use `vi.mock('@lib/rootScope')` paired with `afterAll(vi.unmock)`).

### E2E (`src/tests/e2e/e2e-qr-key-exchange.ts`)

Added to `TESTS` array in `src/tests/e2e/run-all.sh`.

1. Boot + onboarding (standard pattern from CLAUDE.md).
2. Open hamburger → Settings → click "My QR Code" row.
3. Assert canvas/svg inside `[data-testid="qr-container"]` is present.
4. Click "Copy npub" → assert clipboard contents start with `npub1`.
5. Close tab, click FAB pencil, assert new "Add Contact" menu entry is visible.
6. Click "Add Contact" → popup appears → click "Scan QR" button → assert `[data-testid="qr-scanner-overlay"]` is mounted.
7. Click close (✕) → assert overlay is unmounted. (Do not test camera stream — jsdom/headless can't provide it.)

Uses `dismissOverlays` helper.

### Manual verification (documented in `docs/CHECKLIST_v2.md`)

- Open on a mobile device, grant camera permission, scan own QR from another device → assert npub fills the Add Contact field.
- Attempt scan without camera permission → assert "Camera access denied" message.
- Scan a non-Nostr QR (e.g., a URL) → assert "Not a Nostr QR code" toast and loop continues.

## Acceptance criteria

- [ ] `KeyExchange` view accessible from Settings → My QR Code row
- [ ] `KeyExchange` view accessible from Add Contact popup Scan QR button
- [ ] QR embeds centered avatar (kind 0 picture or dicebear fallback)
- [ ] QR uses `errorCorrectionLevel: 'H'` and encodes `nostr:npub1…`
- [ ] FAB pencil shows "Add Contact" entry between New Group and New Private Chat
- [ ] Scanner decodes `npub1…` and `nostr:npub1…` payloads via jsQR
- [ ] Scanner rejects hex, self, and non-Nostr payloads with distinct user feedback
- [ ] Add Contact scan flow fills the input field (no auto-submit); Settings scan flow opens chat directly
- [ ] `QRIdentity.tsx` and its test deleted
- [ ] All unit tests pass; E2E test added to `run-all.sh`
- [ ] Manual verification notes added to `docs/CHECKLIST_v2.md`

## Open questions (tracked for implementation)

- Icon name for the Settings row and FAB entry — need to confirm `qrcode` / `adduser` exist in the icon set; fall back to closest existing if not.
- Whether `qr-code-styling` produces `<canvas>` or `<svg>` by default — affects the E2E selector (`data-testid="qr-container"` child assertion). Confirm during implementation.
