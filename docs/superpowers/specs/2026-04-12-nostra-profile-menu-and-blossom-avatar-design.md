# Profile Menu Entry + Merged Profile Tab + Blossom Avatar Upload

**Date:** 2026-04-12
**Status:** Approved, pending implementation plan

## Problem

The sidebar hamburger menu currently exposes the user's Nostr identity through a
plain text entry labeled "Identity" (icon: key) that opens
`AppNostraIdentityTab`. Original tweb-k instead shows the current account as the
first menu entry with a round avatar and display name — the pattern used for
MultiAccount. Nostra should match that pattern to make identity feel native.

Separately, the identity settings are split across two tabs:

- `src/components/sidebarLeft/tabs/editProfile.ts` — has `EditPeer` (avatar
  upload/crop, first/last name, bio) plus a thin Nostr Identity section
  (npub row, NIP-05 row that re-opens `nostraIdentity.ts`).
- `src/components/sidebarLeft/tabs/nostraIdentity.ts` — has the full NIP-05
  verification UI, display name edit, npub copy, read-only Dicebear preview.

Users edit their name/bio in one tab and their NIP-05 in another. Avatar upload
exists in `EditPeer` but currently targets MTProto
(`appProfileManager.uploadProfilePhoto`), which is meaningless in Nostra: the
uploaded photo never reaches any relay, never lands in kind 0 `picture`, and
never appears to other Nostra clients.

## Goals

1. Replace the "Identity" menu entry with a MultiAccount-style profile entry
   (avatar + display name + truncated npub) placed at the top of the hamburger
   menu.
2. Merge `nostraIdentity.ts` into `editProfile.ts` so there is one profile tab
   with avatar upload, display name, bio, npub display/copy, and full NIP-05
   verification flow.
3. Replace the MTProto avatar upload path with a Blossom upload so avatars
   become real files hosted on public Blossom servers, referenced by URL in the
   user's kind 0 `picture` field.
4. Provide Playwright E2E coverage for the full flow: click the profile menu
   entry → edit name/bio/avatar → save → verify kind 0 published to relay with
   the Blossom URL and NIP-05 preserved.

## Non-Goals

- Multi-identity / account switching. The menu entry shows the single active
  Nostra identity. Multiple accounts are out of scope for this spec.
- Self-hosted Blossom server. We use public servers only; a settings panel to
  configure a custom server is a follow-up.
- Avatar migration for existing users. On first save after this change the
  avatar is republished via Blossom; before that, the Dicebear deterministic
  avatar continues to be rendered as fallback.

## Design

### 1. Sidebar menu entry

File: `src/components/sidebarLeft/index.ts`.

Add a new first entry to `menuButtons` (before the existing `newSubmenu`) built
as a `ButtonMenuItemOptions` with:

- `regularText`: an `HTMLElement` containing:
  - Round 36px avatar `<img>` — source: the kind 0 `picture` URL from the
    Nostra identity store if present, otherwise the Dicebear fallback from
    `generateDicebearAvatar(hex)`.
  - A two-line text block: line 1 = display name (from
    `useNostraIdentity().displayName()`), line 2 = truncated npub
    `npub1xxxx…yyyy` (8 + 4 chars).
- `icon`: omitted — the avatar replaces the icon slot visually.
- `separator: true` on the entry that follows (SavedMessages) so the profile
  entry is visually isolated at the top.
- `onClick`: opens the merged profile tab via
  `this.createTab(AppEditProfileTab).open()` wrapped in `closeTabsBefore`.

The existing entry at `src/components/sidebarLeft/index.ts:676-684`
(`icon: 'key'`, `regularText: 'Identity'`) is deleted.

Reactivity: the menu is rebuilt each time the hamburger opens (see
`onOpenBefore` at `index.ts:712`), so reading the store on open is enough — no
persistent subscription needed.

### 2. Merged profile tab

File: `src/components/sidebarLeft/tabs/editProfile.ts`.

Keep the existing `EditPeer` + first/last name + bio layout as the top section.
Replace the thin Nostr Identity section (lines 121-160) with a full merge of
`nostraIdentity.ts` content:

- **Public Key section** — `Row` with the full npub and a copy icon, reusing
  the styling from `nostraIdentity.ts:88-104`.
- **NIP-05 Identity section** — `InputField` for alias, dynamic instructions
  panel, status indicator (unverified / verifying / verified / failed), verify
  button. Exact logic ported from `nostraIdentity.ts:146-228`.

Save flow (triggered by `editPeer.nextBtn`) becomes a single Nostra publish:

```ts
await publishKind0Metadata({
  name: fullName,
  display_name: fullName,
  about: bio,
  nip05: nip05Value || undefined,
  picture: pictureUrl || undefined
});
```

where `pictureUrl` comes from the Blossom upload (see section 3). The call to
`appProfileManager.updateProfile` is removed — it is a MTProto no-op in
Nostra. `appProfileManager.uploadProfilePhoto` is also removed from this path.

Title of the tab: keep `EditAccount.Title` (existing lang key).

After the merge, delete `src/components/sidebarLeft/tabs/nostraIdentity.ts`
and remove the dynamic import from `editProfile.ts:150` (it no longer exists).
Also remove the dynamic import at `src/components/sidebarLeft/index.ts:681-682`
along with the deleted menu entry.

### 3. Blossom avatar upload

New module: `src/lib/nostra/blossom-upload.ts` (~80 lines).

Responsibilities:

- Accept a `Blob | File` from `EditPeer.uploadAvatar()` (already returns a
  `File`-like wrapper for MTProto; we intercept before the MTProto call).
- Build a Blossom `kind: 24242` auth event using the existing Nostra signer
  (`@lib/nostra/nostr-identity` + `key-storage`), with the required `t=upload`
  tag and `x=<sha256>` tag computed from the blob bytes.
- Use `blossom-client-sdk` (`BlossomClient.uploadBlob(server, blob, {auth})`)
  against a hardcoded ordered list of public servers:
  1. `https://blossom.primal.net`
  2. `https://cdn.satellite.earth`
  3. `https://blossom.band`
  On upload failure, try the next server. If all fail, surface a toast and
  leave the kind 0 `picture` field unchanged.
- Return `{url, sha256}` on success.

**Dependency:** `pnpm add blossom-client-sdk`. License: verify MIT/ISC — if
GPL-incompatible we inline the minimal logic instead (roughly: sha256 of blob,
build NIP-98-style event, sign, PUT to `<server>/upload` with
`Authorization: Nostr <base64(event)>`).

**Flow change in `editProfile.ts`:**

```ts
if (this.editPeer.uploadAvatar) {
  const file = await this.editPeer.uploadAvatar();
  const {url} = await uploadToBlossom(file);
  pictureUrl = url;
}
```

The `appProfileManager.uploadProfilePhoto(inputFile)` call is removed. The
`EditPeer.avatarEdit` UI (crop, preview, delete) continues to work as-is
because it operates on the local blob before handing it off.

**Store update:** after a successful upload, dispatch
`nostra_identity_updated` with `{picture: url}` so the menu entry and any
other subscribers refresh. The Nostra identity store
(`src/stores/nostraIdentity.ts`) gets a new `picture` accessor mirroring
`displayName`/`nip05`.

### 4. E2E tests

New file: `src/tests/e2e/e2e-profile-blossom.ts`. Pattern: follow existing
`e2e-bug-regression.ts` boot sequence (goto → 5s wait → reload → 15s wait →
dismiss Vite overlay).

Test cases:

1. **Menu entry renders identity** — after onboarding, open the hamburger
   menu, assert the first entry contains an `<img>` whose `src` is either the
   kind 0 `picture` URL or a Dicebear data URI, and a text node containing the
   display name and a truncated npub `npub1…`.
2. **Menu entry opens merged tab** — click the entry, assert the tab title
   matches `EditAccount.Title` lang key and the tab contains both the
   `.input-field` for first name AND the NIP-05 section from the merged
   content (selector: `[data-section="nip05"]` added to the SettingSection).
3. **Save flow publishes kind 0 with Blossom URL** — in a page that pins
   `window.fetch` to mock the Blossom servers (return a deterministic URL for
   PUT `/upload`), fill first name, upload a small PNG via `setInputFiles` on
   the hidden avatar input, click save, then use `LocalRelay.waitForEvent(kind
   0)` helper (add if missing) to read the published event and assert `picture
   === mockUrl`, `name === fillValue`, `display_name === fillValue`.
4. **Blossom fallback chain** — mock first server returns 500, second returns
   200; assert save still succeeds and the event contains the second server's
   URL.
5. **NIP-05 persists across save** — set a NIP-05 alias (mock the
   `.well-known/nostr.json` via `page.route()`), verify it, save, reopen the
   tab, assert the alias is still shown.

Reuse `LocalRelay` (`src/tests/e2e/helpers/local-relay.ts`) so kind 0 publish
is captured deterministically without hitting public relays.

## Risks & open items

- **Blossom SDK license** — must verify before `pnpm add`. If GPL-incompatible
  we fall back to the inline implementation described in section 3.
- **`EditPeer.uploadAvatar()` return shape** — the current method returns an
  MTProto `InputFile`. We need to confirm whether the underlying blob is still
  accessible, or whether we have to hook `editPeer.avatarElem` earlier (at
  `onChangeAvatar`) to grab the raw `File` before upload is triggered. If the
  latter, `EditPeer` gets a small addition: expose the last `File` selected.
- **Save button enablement** — `EditPeer.handleChange()` currently enables the
  save button only when MTProto-watched fields change. After the merge the
  NIP-05 input and the avatar both need to feed the same enablement path.
- **Race on menu reopen** — if the user saves then immediately reopens the
  menu, we need the new avatar URL to be reflected without a full reload. The
  `nostra_identity_updated` dispatch above plus reading from the store in the
  menu builder handles this, but the test plan item (1) should assert the
  avatar `src` matches after a save within the same session.

## Out of scope / follow-ups

- Settings panel to configure custom Blossom servers.
- Migration of existing users' Dicebear avatars to Blossom uploads.
- Multi-identity switching.
- Deleting old Blossom blobs on avatar replacement (BUD-01 `DELETE`).
