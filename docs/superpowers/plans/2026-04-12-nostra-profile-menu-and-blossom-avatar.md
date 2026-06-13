# Profile Menu Entry + Merged Profile Tab + Blossom Avatar Upload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Identity" hamburger entry with an avatar+name row, merge `nostraIdentity.ts` into `editProfile.ts`, and upload avatars to public Blossom servers so they end up in the user's kind 0 `picture` field — with Playwright E2E coverage.

**Architecture:** Solid.js store gets a `picture` accessor fed by `nostra_identity_updated`. `EditPeer` is lightly extended to expose the raw `Blob` selected by the avatar editor. A new `src/lib/nostra/blossom-upload.ts` signs a NIP-24242 auth event with the active Nostra private key (read from encrypted storage on demand) and `PUT`s to a fallback chain of public Blossom servers. `editProfile.ts` absorbs the full NIP-05 UI from `nostraIdentity.ts`, calls the Blossom module on save, and publishes kind 0 via `publishKind0Metadata`. The sidebar menu reads the store on open and renders a custom `HTMLElement` inside `regularText`.

**Tech Stack:** TypeScript 5.7, Solid.js custom fork, `blossom-client-sdk` (new dep), `nostr-tools/pure` (already used), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-04-12-nostra-profile-menu-and-blossom-avatar-design.md`

---

## File Structure

**Create:**
- `src/lib/nostra/blossom-upload.ts` — Blossom upload module (signer + fallback chain)
- `src/tests/nostra/blossom-upload.test.ts` — unit tests for the upload module
- `src/tests/e2e/e2e-profile-blossom.ts` — end-to-end tests for the full flow

**Modify:**
- `src/lib/rootScope.ts:246,249` — add `picture` to nostra identity events
- `src/stores/nostraIdentity.ts` — add `picture` signal and accessor
- `src/components/avatarEdit.ts:133` — pass raw `Blob` alongside upload fn
- `src/components/editPeer.ts:20` — expose `lastAvatarBlob: Blob | null`
- `src/components/sidebarLeft/tabs/editProfile.ts` — merge identity UI, swap save flow
- `src/components/sidebarLeft/index.ts:661-704` — replace Identity entry with profile row
- `package.json` — add `blossom-client-sdk` dep (if license-compatible; see Task 3)

**Delete:**
- `src/components/sidebarLeft/tabs/nostraIdentity.ts`

---

## Task 1: Add `picture` to identity event + store

**Files:**
- Modify: `src/lib/rootScope.ts:246,249`
- Modify: `src/stores/nostraIdentity.ts`

- [ ] **Step 1: Extend event typings in `rootScope.ts`**

Replace lines 246 and 249 with:

```ts
  'nostra_identity_loaded': {npub: string, displayName?: string, nip05?: string, picture?: string, protectionType: 'none' | 'pin' | 'passphrase'},
  'nostra_identity_locked': void,
  'nostra_identity_unlocked': {npub: string},
  'nostra_identity_updated': {displayName?: string, nip05?: string, picture?: string},
```

- [ ] **Step 2: Add `picture` signal to the store**

In `src/stores/nostraIdentity.ts`, add after the existing signal declarations:

```ts
const [picture, setPicture] = createRoot(() => createSignal<string | null>(null));
```

Add this line inside the `nostra_identity_loaded` handler (next to `setNip05`):

```ts
  setPicture(data.picture || null);
```

Add this line inside the `nostra_identity_updated` handler (at the end of the handler body):

```ts
  if(data.picture !== undefined) setPicture(data.picture || null);
```

Extend the returned object in `useNostraIdentity`:

```ts
export default function useNostraIdentity() {
  return {
    npub,
    displayName,
    nip05,
    picture,
    isLocked,
    protectionType
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "rootScope|nostraIdentity" | grep "error TS"`
Expected: no output (no new errors).

- [ ] **Step 4: Commit**

```bash
git add src/lib/rootScope.ts src/stores/nostraIdentity.ts
git commit -m "feat(nostra): add picture field to identity store and events"
```

---

## Task 2: Expose raw Blob from avatar editor

**Files:**
- Modify: `src/components/avatarEdit.ts:103,133`
- Modify: `src/components/editPeer.ts:20,64-66`

- [ ] **Step 1: Widen `onChange` signature in `avatarEdit.ts`**

At line 103, replace:

```ts
  onChange: (value: () => CancellablePromise<InputFile>) => void;
```

with:

```ts
  onChange: (value: () => CancellablePromise<InputFile>, blob: Blob) => void;
```

At line 31 (constructor parameter), replace:

```ts
  constructor(onChange: (uploadAvatar: () => CancellablePromise<InputFile>) => void, options?: Options) {
```

with:

```ts
  constructor(onChange: (uploadAvatar: () => CancellablePromise<InputFile>, blob: Blob) => void, options?: Options) {
```

At line 133, replace:

```ts
  onChange(() => appDownloadManager.upload(resultPayload.blob));
```

with:

```ts
  onChange(() => appDownloadManager.upload(resultPayload.blob), resultPayload.blob);
```

- [ ] **Step 2: Store the blob in `EditPeer`**

In `src/components/editPeer.ts`, add after line 20 (`public uploadAvatar`):

```ts
  public lastAvatarBlob: Blob | null = null;
```

Replace the `AvatarEdit` instantiation block (around lines 64-66) — the current:

```ts
        this.avatarEdit = new AvatarEdit((_upload) => {
          this.uploadAvatar = _upload;
```

becomes:

```ts
        this.avatarEdit = new AvatarEdit((_upload, _blob) => {
          this.uploadAvatar = _upload;
          this.lastAvatarBlob = _blob;
```

(Keep whatever lines follow the original closure — only the signature and the first body line change.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "avatarEdit|editPeer" | grep "error TS"`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/components/avatarEdit.ts src/components/editPeer.ts
git commit -m "feat(editPeer): expose lastAvatarBlob from avatar editor"
```

---

## Task 3: Add `blossom-client-sdk` dependency (with license fallback decision)

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Check the package license**

Run: `npm view blossom-client-sdk license repository.url --json`
Expected output shape:
```json
{"license": "MIT", "repository.url": "..."}
```

If license is MIT / ISC / BSD / Apache-2.0 / 0BSD, continue. If it is GPL-3.0-only / GPL-2.0-only / AGPL / proprietary, **SKIP THE INSTALL** — go to Step 2b (inline implementation). If unclear, open the GitHub LICENSE file and read it before proceeding.

- [ ] **Step 2a: Install (permissive license path)**

Run: `pnpm add blossom-client-sdk`
Expected: package added to `dependencies`, lockfile updated.

- [ ] **Step 2b: Inline fallback path (only if Step 1 showed an incompatible license)**

Skip `pnpm add`. In Task 4, replace `import {BlossomClient} from 'blossom-client-sdk'` with a local helper in `blossom-upload.ts` that builds the request manually: compute `sha256(blob)` with `crypto.subtle.digest`, sign a kind 24242 event with `finalizeEvent`, `base64.encode` the JSON, `PUT` with header `Authorization: Nostr <b64>` and body `blob`, parse the JSON response `{url, sha256, size, type, uploaded}`. Reject on non-2xx.

Document the decision with a comment at the top of `blossom-upload.ts`.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): add blossom-client-sdk for avatar upload"
```

(Skip the commit if Step 2b was taken — nothing to add.)

---

## Task 4: Blossom upload module — failing unit test first

**Files:**
- Create: `src/tests/nostra/blossom-upload.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Unit tests for blossom-upload: verify signer builds a valid NIP-24242
 * event, the fallback chain tries servers in order, and failures surface.
 */
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {bytesToHex} from '@noble/hashes/utils';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import {uploadToBlossom, BLOSSOM_SERVERS} from '@lib/nostra/blossom-upload';

describe('blossom-upload', () => {
  let privkeyHex: string;
  let pubkeyHex: string;

  beforeEach(() => {
    fetchMock.mockReset();
    const sk = generateSecretKey();
    privkeyHex = bytesToHex(sk);
    pubkeyHex = getPublicKey(sk);
  });

  it('uploads to first server on success', async() => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], {type: 'image/png'});

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      url: 'https://blossom.primal.net/abc.png',
      sha256: 'abc',
      size: 4,
      type: 'image/png'
    }), {status: 200}));

    const result = await uploadToBlossom(blob, privkeyHex);

    expect(result.url).toBe('https://blossom.primal.net/abc.png');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(BLOSSOM_SERVERS[0] + '/upload');
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toMatch(/^Nostr [A-Za-z0-9+/=]+$/);
  });

  it('falls back to next server on 5xx', async() => {
    const blob = new Blob([new Uint8Array([1])], {type: 'image/png'});

    fetchMock
    .mockResolvedValueOnce(new Response('boom', {status: 500}))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      url: 'https://cdn.satellite.earth/def.png',
      sha256: 'def',
      size: 1,
      type: 'image/png'
    }), {status: 200}));

    const result = await uploadToBlossom(blob, privkeyHex);

    expect(result.url).toBe('https://cdn.satellite.earth/def.png');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(BLOSSOM_SERVERS[0] + '/upload');
    expect(fetchMock.mock.calls[1][0]).toBe(BLOSSOM_SERVERS[1] + '/upload');
  });

  it('throws if every server fails', async() => {
    const blob = new Blob([new Uint8Array([1])], {type: 'image/png'});
    fetchMock.mockResolvedValue(new Response('down', {status: 503}));

    await expect(uploadToBlossom(blob, privkeyHex)).rejects.toThrow(/all blossom servers failed/i);
    expect(fetchMock).toHaveBeenCalledTimes(BLOSSOM_SERVERS.length);
  });

  it('signs an auth event with the given privkey', async() => {
    const blob = new Blob([new Uint8Array([9, 9])], {type: 'image/png'});
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      url: 'x', sha256: 'y', size: 2, type: 'image/png'
    }), {status: 200}));

    await uploadToBlossom(blob, privkeyHex);

    const authHeader = fetchMock.mock.calls[0][1].headers.Authorization as string;
    const b64 = authHeader.replace(/^Nostr /, '');
    const event = JSON.parse(atob(b64));

    expect(event.kind).toBe(24242);
    expect(event.pubkey).toBe(pubkeyHex);
    expect(event.tags).toEqual(expect.arrayContaining([
      expect.arrayContaining(['t', 'upload']),
      expect.arrayContaining(['x'])
    ]));
    expect(event.sig).toMatch(/^[0-9a-f]{128}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/tests/nostra/blossom-upload.test.ts`
Expected: FAIL with module resolution error `Cannot find module '@lib/nostra/blossom-upload'`.

---

## Task 5: Implement `blossom-upload.ts`

**Files:**
- Create: `src/lib/nostra/blossom-upload.ts`

- [ ] **Step 1: Write the module**

```ts
/*
 * Nostra.chat — Blossom upload helper
 *
 * Signs a NIP-24242 auth event with the active Nostra private key and
 * uploads a blob to a fallback chain of public Blossom servers. Returns the
 * resulting URL for the first server that accepts the upload.
 *
 * This module uses a hand-rolled PUT rather than blossom-client-sdk if the
 * latter's license is GPL-incompatible — see the plan task for the decision.
 */

import {finalizeEvent} from 'nostr-tools/pure';
import {hexToBytes, bytesToHex} from '@noble/hashes/utils';
import {sha256} from '@noble/hashes/sha2';

export const BLOSSOM_SERVERS = [
  'https://blossom.primal.net',
  'https://cdn.satellite.earth',
  'https://blossom.band'
] as const;

export interface BlossomUploadResult {
  url: string;
  sha256: string;
}

export async function uploadToBlossom(
  blob: Blob,
  privkeyHex: string
): Promise<BlossomUploadResult> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const hash = bytesToHex(sha256(bytes));

  const privkey = hexToBytes(privkeyHex);
  const expiration = Math.floor(Date.now() / 1000) + 300;

  const event = finalizeEvent({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    content: 'Upload avatar',
    tags: [
      ['t', 'upload'],
      ['x', hash],
      ['expiration', expiration.toString()]
    ]
  }, privkey);

  const authHeader = 'Nostr ' + btoa(JSON.stringify(event));

  const errors: string[] = [];
  for(const server of BLOSSOM_SERVERS) {
    try {
      const res = await fetch(server + '/upload', {
        method: 'PUT',
        headers: {
          'Authorization': authHeader,
          'Content-Type': blob.type || 'application/octet-stream'
        },
        body: blob
      });

      if(!res.ok) {
        errors.push(`${server}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json() as {url: string; sha256: string};
      if(!data.url) {
        errors.push(`${server}: no url in response`);
        continue;
      }
      return {url: data.url, sha256: data.sha256 || hash};
    } catch(err) {
      errors.push(`${server}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`all blossom servers failed: ${errors.join('; ')}`);
}
```

- [ ] **Step 2: Run the tests**

Run: `pnpm vitest run src/tests/nostra/blossom-upload.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "blossom-upload" | grep "error TS"`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/blossom-upload.ts src/tests/nostra/blossom-upload.test.ts
git commit -m "feat(nostra): blossom upload module with fallback chain"
```

---

## Task 6: Merge identity UI into `editProfile.ts`

**Files:**
- Modify: `src/components/sidebarLeft/tabs/editProfile.ts`

- [ ] **Step 1: Add imports at the top of the file**

Add these imports below the existing ones (keep existing imports intact):

```ts
import Button from '@components/button';
import {uploadToBlossom} from '@lib/nostra/blossom-upload';
import {loadEncryptedIdentity, loadBrowserKey, decryptKeys} from '@lib/nostra/key-storage';
import {importFromMnemonic, decodePubkey} from '@lib/nostra/nostr-identity';
import {verifyNip05, buildNip05Instructions} from '@lib/nostra/nip05';
import type {Nip05Status} from '@lib/nostra/nip05';
```

- [ ] **Step 2: Add private fields on the class**

Inside `class AppEditProfileTab extends SliderSuperTab {`, below the existing `bioInputField` field, add:

```ts
  private nip05InputField: InputField;
  private nip05Status: Nip05Status = 'unverified';
  private nip05StatusEl: HTMLElement | null = null;
```

- [ ] **Step 3: Replace the existing thin identity section (lines 121-160)**

Delete everything from the line that begins with `// [Nostra.chat] Nostr Identity section` up to and including the line that closes that block with `this.scrollable.append(identitySection.container);` and the blank line after it. Replace with:

```ts
    // [Nostra.chat] Nostr Identity section — merged from nostraIdentity.ts
    const identity = useNostraIdentity();
    let npubValue = identity.npub() || '';

    if(!npubValue) {
      try {
        const record = await loadEncryptedIdentity();
        if(record) {
          const browserKey = await loadBrowserKey();
          if(browserKey) {
            const {seed} = await decryptKeys(record.iv, record.encryptedKeys, browserKey);
            const id = importFromMnemonic(seed);
            npubValue = id.npub;
            rootScope.dispatchEvent('nostra_identity_loaded', {
              npub: id.npub,
              displayName: record.displayName || null,
              nip05: undefined,
              protectionType: 'none'
            });
          }
        }
      } catch(err) {
        console.warn('[EditProfile] failed to load identity:', err);
      }
    }

    if(npubValue) {
      const pubkeySection = new SettingSection({name: 'Public Key' as any});
      const npubRow = new Row({
        title: npubValue,
        subtitle: 'Your Nostr public key (npub)',
        icon: 'copy',
        clickable: () => {
          navigator.clipboard.writeText(npubValue).then(() => toast('Copied to clipboard'));
        },
        listenerSetter: this.listenerSetter
      });
      npubRow.title.classList.add('npub-wordbreak');
      pubkeySection.content.append(npubRow.container);
      this.scrollable.append(pubkeySection.container);

      const nip05Section = new SettingSection({
        name: 'NIP-05 Identity' as any,
        caption: 'Set a human-readable identifier (e.g. alice@example.com)' as any
      });
      nip05Section.container.dataset.section = 'nip05';

      this.nip05InputField = new InputField({
        label: 'NIP-05 Alias' as any,
        name: 'nip05-alias',
        maxLength: 100,
        plainText: true
      });
      this.nip05InputField.setOriginalValue(identity.nip05() || '', true);

      const instructionsEl = document.createElement('div');
      instructionsEl.classList.add('nip05-instructions');
      this.updateInstructions(instructionsEl, this.nip05InputField.value, npubValue);
      this.nip05InputField.input.addEventListener('input', () => {
        this.updateInstructions(instructionsEl, this.nip05InputField.value, npubValue);
      });

      this.nip05StatusEl = document.createElement('div');
      this.nip05StatusEl.classList.add('nip05-status');
      if(identity.nip05()) {
        this.nip05Status = 'verified';
      }
      this.updateNip05StatusDisplay();

      const verifyBtn = Button('btn-primary btn-color-primary');
      verifyBtn.textContent = 'Verify';
      attachClickEvent(verifyBtn, async() => {
        const alias = this.nip05InputField.value.trim();
        if(!alias) { toast('Enter a NIP-05 alias first'); return; }
        const hexPub = npubValue ? decodePubkey(npubValue) : null;
        if(!hexPub) { toast('No identity loaded'); return; }

        this.nip05Status = 'verifying';
        this.updateNip05StatusDisplay();

        const result = await verifyNip05(alias, hexPub);
        if(result.ok) {
          this.nip05Status = 'verified';
          this.updateNip05StatusDisplay();
          rootScope.dispatchEvent('nostra_identity_updated', {nip05: alias});
          toast('NIP-05 verified');
        } else {
          this.nip05Status = 'failed';
          this.updateNip05StatusDisplay(result.error);
        }
      }, {listenerSetter: this.listenerSetter});

      nip05Section.content.append(
        this.nip05InputField.container,
        instructionsEl,
        this.nip05StatusEl,
        verifyBtn
      );
      this.scrollable.append(nip05Section.container);
    }
```

- [ ] **Step 4: Add helper methods to the class**

Add these two methods inside the class body (after `public focus(on: string)` or before the closing brace — anywhere in the class):

```ts
  private updateInstructions(el: HTMLElement, alias: string, npub: string): void {
    el.textContent = '';
    const atIndex = alias.indexOf('@');
    if(atIndex < 1 || !npub) {
      const hint = document.createElement('p');
      hint.classList.add('nip05-hint');
      hint.textContent = 'Enter a NIP-05 alias above to see setup instructions.';
      el.append(hint);
      return;
    }
    const name = alias.slice(0, atIndex);
    const domain = alias.slice(atIndex + 1);
    const hexPub = decodePubkey(npub);
    const snippet = buildNip05Instructions(name, hexPub);
    const hint = document.createElement('p');
    hint.classList.add('nip05-hint');
    hint.textContent = `Add this to https://${domain}/.well-known/nostr.json:`;
    const pre = document.createElement('pre');
    pre.classList.add('nip05-snippet');
    pre.textContent = snippet;
    el.append(hint, pre);
  }

  private updateNip05StatusDisplay(errorMsg?: string): void {
    if(!this.nip05StatusEl) return;
    this.nip05StatusEl.className = 'nip05-status';
    switch(this.nip05Status) {
      case 'unverified': this.nip05StatusEl.textContent = ''; break;
      case 'verifying':
        this.nip05StatusEl.classList.add('nip05-status--verifying');
        this.nip05StatusEl.textContent = 'Verifying...';
        break;
      case 'verified':
        this.nip05StatusEl.classList.add('nip05-status--verified');
        this.nip05StatusEl.textContent = 'Verified';
        break;
      case 'failed':
        this.nip05StatusEl.classList.add('nip05-status--failed');
        this.nip05StatusEl.textContent = errorMsg || 'Verification failed';
        break;
    }
  }
```

- [ ] **Step 5: Rewrite the save click handler**

Find the existing `attachClickEvent(this.editPeer.nextBtn, () => {` block (around line 162) and replace the entire block up to its closing `}, {listenerSetter: this.listenerSetter});` with:

```ts
    attachClickEvent(this.editPeer.nextBtn, async() => {
      this.editPeer.nextBtn.disabled = true;
      try {
        const fullName = [this.firstNameInputField.value, this.lastNameInputField.value].filter(Boolean).join(' ');
        const bio = this.bioInputField.value;

        let pictureUrl: string | undefined;
        if(this.editPeer.lastAvatarBlob) {
          try {
            const record = await loadEncryptedIdentity();
            const browserKey = await loadBrowserKey();
            if(!record || !browserKey) throw new Error('no identity loaded');
            const {seed} = await decryptKeys(record.iv, record.encryptedKeys, browserKey);
            const id = importFromMnemonic(seed);
            const {url} = await uploadToBlossom(this.editPeer.lastAvatarBlob, id.privateKey);
            pictureUrl = url;
          } catch(err) {
            console.error('[EditProfile] blossom upload failed:', err);
            toast('Avatar upload failed — saved without new avatar');
          }
        }

        if(npubValue) {
          rootScope.dispatchEvent('nostra_identity_updated', {
            displayName: fullName,
            ...(pictureUrl ? {picture: pictureUrl} : {})
          });
          await publishKind0Metadata({
            name: fullName,
            display_name: fullName,
            about: bio,
            nip05: useNostraIdentity().nip05() || undefined,
            picture: pictureUrl || undefined
          }).catch((err) => {
            console.error('[EditProfile] kind 0 publish failed:', err);
            toast('Profile saved locally but relay publish failed');
          });
        }

        this.close();
      } finally {
        this.editPeer.nextBtn.removeAttribute('disabled');
      }
    }, {listenerSetter: this.listenerSetter});
```

- [ ] **Step 6: Verify `importFromMnemonic` returns `privateKey`**

Run: `grep -n "return.*{" src/lib/nostra/nostr-identity.ts | head -5`
Check that `importFromMnemonic` returns an object with `privateKey: string` (hex). If the return shape uses a different key (e.g. `privkey` or `sk`), update the `uploadToBlossom(..., id.<KEY>)` call in Step 5 to match.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "editProfile" | grep "error TS"`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add src/components/sidebarLeft/tabs/editProfile.ts
git commit -m "feat(profile): merge nostra identity ui into edit profile tab"
```

---

## Task 7: Delete standalone `nostraIdentity.ts` tab

**Files:**
- Delete: `src/components/sidebarLeft/tabs/nostraIdentity.ts`

- [ ] **Step 1: Find any remaining references**

Run: `grep -rn "nostraIdentity'" src/ --include="*.ts" --include="*.tsx"`
Expected: only the import in `src/components/sidebarLeft/index.ts` (handled in Task 8) — no other references.

If other files import it, STOP and add a task here to update them first.

- [ ] **Step 2: Delete the file**

Run: `rm src/components/sidebarLeft/tabs/nostraIdentity.ts`

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "@vendor"`
Expected: only the `sidebarLeft/index.ts` error about missing `AppNostraIdentityTab` import — this will be resolved in Task 8.

- [ ] **Step 4: Commit (after Task 8, not now — keep this staged)**

Do NOT commit yet. Task 8 fixes the broken import; commit both together at the end of Task 8.

---

## Task 8: Replace "Identity" menu entry with profile row

**Files:**
- Modify: `src/components/sidebarLeft/index.ts`

- [ ] **Step 1: Add imports**

Near the top of the file, add:

```ts
import useNostraIdentity from '@stores/nostraIdentity';
import {generateDicebearAvatar} from '@helpers/generateDicebearAvatar';
import {decodePubkey} from '@lib/nostra/nostr-identity';
```

- [ ] **Step 2: Build a helper that returns the custom menu entry content**

Inside `AppSidebarLeft` class (near other private methods — placement doesn't matter), add:

```ts
  private buildNostraProfileMenuContent(): HTMLElement {
    const identity = useNostraIdentity();
    const wrap = document.createElement('div');
    wrap.classList.add('nostra-profile-menu-entry');
    wrap.style.cssText = 'display:flex;align-items:center;gap:0.75rem;padding:0.25rem 0';

    const avatar = document.createElement('img');
    avatar.classList.add('nostra-profile-menu-entry-avatar');
    avatar.style.cssText = 'width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0';

    const picture = identity.picture?.();
    const npub = identity.npub() || '';
    if(picture) {
      avatar.src = picture;
    } else if(npub) {
      try {
        const hex = decodePubkey(npub);
        generateDicebearAvatar(hex).then((url) => { avatar.src = url; });
      } catch{}
    }

    const text = document.createElement('div');
    text.style.cssText = 'display:flex;flex-direction:column;min-width:0;line-height:1.2';
    const nameEl = document.createElement('span');
    nameEl.textContent = identity.displayName() || 'Profile';
    nameEl.style.cssText = 'font-weight:600;font-size:0.9375rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    const npubEl = document.createElement('span');
    npubEl.textContent = npub ? `${npub.slice(0, 12)}…${npub.slice(-4)}` : '';
    npubEl.style.cssText = 'font-size:0.75rem;opacity:0.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

    text.append(nameEl, npubEl);
    wrap.append(avatar, text);
    return wrap;
  }
```

- [ ] **Step 3: Replace the old Identity entry with the new profile entry**

Find the `const menuButtons: (...)[] = [newSubmenu, {` declaration (line 661). Replace the entire array literal from `[newSubmenu, {` through `}, moreSubmenu];` with:

```ts
    const profileEntry: typeof menuButtons[0] = {
      regularText: this.buildNostraProfileMenuContent(),
      onClick: () => {
        closeTabsBefore(() => {
          this.createTab(AppEditProfileTab).open();
        });
      },
      separator: true
    };

    const menuButtons: (ButtonMenuItemOptions & {verify?: () => boolean | Promise<boolean>})[] = [profileEntry, newSubmenu, {
      icon: 'savedmessages',
      text: 'SavedMessages',
      onClick: () => {
        setTimeout(() => {
          appImManager.setPeer({
            peerId: appImManager.myId
          });
        }, 0);
      }
    }, btnArchive, {
      icon: 'user',
      text: 'Contacts',
      onClick: onContactsClick
    }, {
      icon: 'info',
      regularText: 'Status',
      onClick: () => {
        closeTabsBefore(async() => {
          const {default: AppNostraStatusTab} = await import('@components/sidebarLeft/tabs/nostraStatus');
          this.createTab(AppNostraStatusTab).open();
        });
      }
    }, {
      id: 'settings',
      icon: 'settings',
      text: 'Settings',
      separator: true,
      onClick: () => {
        closeTabsBefore(() => {
          this.createTab(AppSettingsTab).open();
        });
      }
    }, moreSubmenu];
```

Note the changes vs. original: `profileEntry` is inserted as first element, the `separator: true` that used to live on `SavedMessages` is moved to `profileEntry`, the old `{icon: 'key', regularText: 'Identity', ...}` entry is deleted entirely.

- [ ] **Step 4: Delete the now-unused `AppNostraIdentityTab` import**

Run: `grep -n "AppNostraIdentityTab\|nostraIdentity" src/components/sidebarLeft/index.ts`
For each matching line, delete the reference (there should be none left after Step 3's replacement — the old dynamic `import('@components/sidebarLeft/tabs/nostraIdentity')` was inside the deleted entry's onClick).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "@vendor"`
Expected: no output.

- [ ] **Step 6: Lint**

Run: `pnpm lint src/components/sidebarLeft/index.ts src/components/sidebarLeft/tabs/editProfile.ts`
Expected: no errors. Fix any spacing/comma-dangle issues surfaced.

- [ ] **Step 7: Commit (combined with Task 7)**

```bash
git add src/components/sidebarLeft/index.ts src/components/sidebarLeft/tabs/nostraIdentity.ts
git commit -m "feat(sidebar): profile row in hamburger menu; drop standalone identity tab"
```

---

## Task 9: Manual smoke test in the dev server

**Files:** none

- [ ] **Step 1: Start dev server**

Run: `pnpm start`
Expected: server on :8080. Leave running.

- [ ] **Step 2: Load the app, complete onboarding**

Open `http://localhost:8080/?debug=1` in a browser. Complete Nostra onboarding (new identity or recover). Note the display name and npub.

- [ ] **Step 3: Open the hamburger menu**

Click the hamburger icon. Expected:
- First entry shows a round avatar (dicebear fallback is fine), the display name in bold, and a truncated npub `npub1xxxxxxxxx…yyyy` underneath.
- A separator line below it.
- No "Identity" text entry anywhere in the menu.

- [ ] **Step 4: Click the profile entry**

Expected: the merged profile tab opens. Contains:
- Avatar editor (upload/crop) at the top.
- First name / Last name / Bio input fields.
- "Public Key" section with the full npub + copy icon.
- "NIP-05 Identity" section with alias input, dynamic instructions area, verify button.

- [ ] **Step 5: Edit and save**

Change the first name, upload a small image, click the save button. Expected:
- No console errors (except possibly a toast if all blossom public servers are offline).
- Tab closes.
- Reopen hamburger: new name appears immediately in the profile row. If a blossom upload succeeded, the avatar `<img src>` should now be an HTTPS URL, not a data URI.

- [ ] **Step 6: Stop the dev server** — ctrl+C.

---

## Task 10: E2E test — menu renders and opens merged tab

**Files:**
- Create: `src/tests/e2e/e2e-profile-blossom.ts`

- [ ] **Step 1: Scaffold the test file**

```ts
// @ts-nocheck
/**
 * E2E: profile menu entry + merged tab + blossom avatar upload.
 *
 * Uses LocalRelay for kind 0 capture and page.route() to mock blossom
 * server endpoints so tests are hermetic.
 */
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {LocalRelay} from './helpers/local-relay';

const APP_URL = 'http://localhost:8080/?debug=1';

async function completeOnboarding(page) {
  await page.goto(APP_URL, {waitUntil: 'load'});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load'});
  await page.waitForTimeout(15000);
  await page.evaluate(() => document.querySelector('vite-plugin-checker-error-overlay')?.remove());

  // Skip link if present
  const skip = page.getByText('SKIP');
  if(await skip.count() > 0) {
    await skip.click();
    await page.waitForTimeout(2000);
  }
}

async function test1_menuEntryRenders() {
  console.log('[test1] menu entry renders identity');
  const relay = new LocalRelay();
  await relay.start();

  const browser = await chromium.launch(launchOptions());
  const ctx = await browser.newContext();
  await relay.injectInto(ctx);
  const page = await ctx.newPage();
  await completeOnboarding(page);

  // Open hamburger
  await page.locator('.sidebar-header__btn-container .btn-icon').first().click();
  await page.waitForTimeout(500);

  const firstEntry = page.locator('.btn-menu-item').first();
  const hasAvatar = await firstEntry.locator('img.nostra-profile-menu-entry-avatar').count();
  const entryText = await firstEntry.textContent();

  if(hasAvatar !== 1) throw new Error('expected avatar image in first menu entry');
  if(!/npub1[a-z0-9]{6,}…[a-z0-9]{4}/.test(entryText || '')) {
    throw new Error(`expected truncated npub in first entry, got: ${entryText}`);
  }

  console.log('[test1] PASS');
  await browser.close();
  await relay.stop();
}

async function test2_clickOpensMergedTab() {
  console.log('[test2] click opens merged profile tab');
  const relay = new LocalRelay();
  await relay.start();
  const browser = await chromium.launch(launchOptions());
  const ctx = await browser.newContext();
  await relay.injectInto(ctx);
  const page = await ctx.newPage();
  await completeOnboarding(page);

  await page.locator('.sidebar-header__btn-container .btn-icon').first().click();
  await page.waitForTimeout(500);
  await page.locator('.btn-menu-item').first().click();
  await page.waitForTimeout(1000);

  // Merged tab: both the name input AND the nip05 section must exist
  const firstNameInput = await page.locator('input[name="first-name"]').count();
  const nip05Section = await page.locator('[data-section="nip05"]').count();

  if(firstNameInput !== 1) throw new Error('missing first-name input in merged tab');
  if(nip05Section !== 1) throw new Error('missing nip05 section in merged tab');

  console.log('[test2] PASS');
  await browser.close();
  await relay.stop();
}

(async() => {
  try {
    await test1_menuEntryRenders();
    await test2_clickOpensMergedTab();
    console.log('\nALL PASS');
    process.exit(0);
  } catch(err) {
    console.error(err);
    process.exit(1);
  }
})();
```

- [ ] **Step 2: Confirm `LocalRelay` exists**

Run: `test -f src/tests/e2e/helpers/local-relay.ts && echo OK`
Expected: `OK`. If missing, STOP — the harness is not set up and this task needs a predecessor.

- [ ] **Step 3: Run the test**

In a separate terminal: `pnpm start`

Then: `E2E_HEADED=0 pnpm tsx src/tests/e2e/e2e-profile-blossom.ts`
Expected: `ALL PASS`.

- [ ] **Step 4: Commit**

```bash
git add src/tests/e2e/e2e-profile-blossom.ts
git commit -m "test(e2e): profile menu entry renders and opens merged tab"
```

---

## Task 11: E2E test — save publishes kind 0 with Blossom URL (mocked)

**Files:**
- Modify: `src/tests/e2e/e2e-profile-blossom.ts`

- [ ] **Step 1: Add test 3 to the file**

Append a new test function `test3_saveWithBlossomMock` before the `(async() => {` runner, and add the call `await test3_saveWithBlossomMock();` in the runner body.

```ts
async function test3_saveWithBlossomMock() {
  console.log('[test3] save publishes kind 0 with blossom url');
  const relay = new LocalRelay();
  await relay.start();

  const browser = await chromium.launch(launchOptions());
  const ctx = await browser.newContext();
  await relay.injectInto(ctx);
  const page = await ctx.newPage();

  // Mock ALL blossom servers to return a deterministic URL
  const mockedUrl = 'https://mocked-blossom.example/avatar123.png';
  await page.route(/blossom\.primal\.net\/upload|cdn\.satellite\.earth\/upload|blossom\.band\/upload/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({url: mockedUrl, sha256: 'abc', size: 10, type: 'image/png'})
    });
  });

  await completeOnboarding(page);

  // Open profile tab
  await page.locator('.sidebar-header__btn-container .btn-icon').first().click();
  await page.waitForTimeout(500);
  await page.locator('.btn-menu-item').first().click();
  await page.waitForTimeout(1000);

  // Fill a new name
  const newName = `E2EName${Date.now()}`;
  await page.locator('input[name="first-name"]').fill('');
  await page.locator('input[name="first-name"]').fill(newName);

  // Upload a tiny PNG via the hidden file input on the avatar editor
  const pngBytes = Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4' +
    '890000000D49444154789C6300010000000500010D0A2DB40000000049454E44AE426082',
    'hex'
  );
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles({name: 'avatar.png', mimeType: 'image/png', buffer: pngBytes});
  await page.waitForTimeout(2000); // wait for crop editor

  // If an AvatarEdit confirm button appears, click it
  const confirmBtn = page.locator('button:has-text("Set")');
  if(await confirmBtn.count() > 0) {
    await confirmBtn.first().click();
    await page.waitForTimeout(1000);
  }

  // Click save (the floating next button)
  await page.locator('.btn-corner').first().click();

  // Capture kind 0 from local relay
  const event = await relay.waitForEvent({kinds: [0]}, 20000);
  if(!event) throw new Error('no kind 0 event published');

  const metadata = JSON.parse(event.content);
  if(metadata.picture !== mockedUrl) {
    throw new Error(`expected picture=${mockedUrl}, got ${metadata.picture}`);
  }
  if(metadata.name !== newName) {
    throw new Error(`expected name=${newName}, got ${metadata.name}`);
  }

  console.log('[test3] PASS');
  await browser.close();
  await relay.stop();
}
```

- [ ] **Step 2: Verify `LocalRelay.waitForEvent` exists; if not, add it**

Run: `grep -n "waitForEvent" src/tests/e2e/helpers/local-relay.ts`
If no match, open the file and add:

```ts
  async waitForEvent(filter: {kinds?: number[]}, timeoutMs = 15000): Promise<any | null> {
    const start = Date.now();
    while(Date.now() - start < timeoutMs) {
      const events = await this.queryEvents(filter);
      if(events.length > 0) return events[events.length - 1];
      await new Promise(r => setTimeout(r, 250));
    }
    return null;
  }
```

If `queryEvents` also doesn't exist, wire through strfry's `strfry scan` command via `execSync` to dump matching events from the DB. Inspect the existing file before adding — reuse whatever subscription API it already has.

- [ ] **Step 3: Run the test**

Run: `pnpm start &` (if not already running), then
`E2E_HEADED=0 pnpm tsx src/tests/e2e/e2e-profile-blossom.ts`
Expected: all 3 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tests/e2e/e2e-profile-blossom.ts src/tests/e2e/helpers/local-relay.ts
git commit -m "test(e2e): save publishes kind 0 with mocked blossom url"
```

---

## Task 12: E2E test — Blossom fallback chain

**Files:**
- Modify: `src/tests/e2e/e2e-profile-blossom.ts`

- [ ] **Step 1: Add test 4**

Append before the runner IIFE, and call it from the runner:

```ts
async function test4_blossomFallback() {
  console.log('[test4] blossom fallback chain');
  const relay = new LocalRelay();
  await relay.start();

  const browser = await chromium.launch(launchOptions());
  const ctx = await browser.newContext();
  await relay.injectInto(ctx);
  const page = await ctx.newPage();

  const fallbackUrl = 'https://mocked-fallback.example/def.png';
  // First server fails, second succeeds, third never called
  await page.route(/blossom\.primal\.net\/upload/, (r) => r.fulfill({status: 500, body: 'down'}));
  await page.route(/cdn\.satellite\.earth\/upload/, (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({url: fallbackUrl, sha256: 'def', size: 10, type: 'image/png'})
  }));

  await completeOnboarding(page);

  await page.locator('.sidebar-header__btn-container .btn-icon').first().click();
  await page.waitForTimeout(500);
  await page.locator('.btn-menu-item').first().click();
  await page.waitForTimeout(1000);

  const pngBytes = Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4' +
    '890000000D49444154789C6300010000000500010D0A2DB40000000049454E44AE426082',
    'hex'
  );
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles({name: 'avatar.png', mimeType: 'image/png', buffer: pngBytes});
  await page.waitForTimeout(2000);
  const confirmBtn = page.locator('button:has-text("Set")');
  if(await confirmBtn.count() > 0) {
    await confirmBtn.first().click();
    await page.waitForTimeout(1000);
  }
  await page.locator('.btn-corner').first().click();

  const event = await relay.waitForEvent({kinds: [0]}, 20000);
  if(!event) throw new Error('no kind 0 event published');
  const metadata = JSON.parse(event.content);
  if(metadata.picture !== fallbackUrl) {
    throw new Error(`expected picture=${fallbackUrl}, got ${metadata.picture}`);
  }

  console.log('[test4] PASS');
  await browser.close();
  await relay.stop();
}
```

- [ ] **Step 2: Run**

Run: `E2E_HEADED=0 pnpm tsx src/tests/e2e/e2e-profile-blossom.ts`
Expected: 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tests/e2e/e2e-profile-blossom.ts
git commit -m "test(e2e): blossom fallback chain on first-server failure"
```

---

## Task 13: E2E test — NIP-05 persists across save + reopen

**Files:**
- Modify: `src/tests/e2e/e2e-profile-blossom.ts`

- [ ] **Step 1: Add test 5**

Append before the runner, call from the runner:

```ts
async function test5_nip05Persists() {
  console.log('[test5] nip05 persists across save and reopen');
  const relay = new LocalRelay();
  await relay.start();

  const browser = await chromium.launch(launchOptions());
  const ctx = await browser.newContext();
  await relay.injectInto(ctx);
  const page = await ctx.newPage();

  // Mock .well-known/nostr.json to make verify succeed deterministically
  await page.route('**/.well-known/nostr.json**', async(route) => {
    // We need the pubkey hex — read it from the page after identity loads
    const hex = await page.evaluate(() => (window as any).__nostraOwnPubkey);
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({names: {alice: hex}})
    });
  });

  await completeOnboarding(page);

  // Open profile
  await page.locator('.sidebar-header__btn-container .btn-icon').first().click();
  await page.waitForTimeout(500);
  await page.locator('.btn-menu-item').first().click();
  await page.waitForTimeout(1000);

  // Fill NIP-05 alias and verify
  await page.locator('input[name="nip05-alias"]').fill('alice@example.com');
  await page.locator('button:has-text("Verify")').click();
  await page.waitForTimeout(2000);

  const statusText = await page.locator('.nip05-status').textContent();
  if(!/verified/i.test(statusText || '')) {
    throw new Error(`expected verified status, got: ${statusText}`);
  }

  // Save (any save will do; we're testing persistence, not publish)
  await page.locator('.btn-corner').first().click();
  await page.waitForTimeout(1500);

  // Reopen
  await page.locator('.sidebar-header__btn-container .btn-icon').first().click();
  await page.waitForTimeout(500);
  await page.locator('.btn-menu-item').first().click();
  await page.waitForTimeout(1000);

  const aliasValue = await page.locator('input[name="nip05-alias"]').inputValue();
  if(aliasValue !== 'alice@example.com') {
    throw new Error(`expected alice@example.com after reopen, got: ${aliasValue}`);
  }

  console.log('[test5] PASS');
  await browser.close();
  await relay.stop();
}
```

- [ ] **Step 2: Run full E2E suite**

Run: `E2E_HEADED=0 pnpm tsx src/tests/e2e/e2e-profile-blossom.ts`
Expected: all 5 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tests/e2e/e2e-profile-blossom.ts
git commit -m "test(e2e): nip05 alias persists across save and reopen"
```

---

## Task 14: Full validation

**Files:** none

- [ ] **Step 1: Run lint**

Run: `pnpm lint`
Expected: no errors in touched files. Fix any surfaced.

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "@vendor"`
Expected: no new errors vs. the pre-existing baseline from `@vendor/emoji`, `@vendor/bezierEasing`.

- [ ] **Step 3: Run unit tests**

Run: `pnpm test:nostra:quick`
Expected: all critical P2P tests still pass (includes the new `blossom-upload.test.ts`).

- [ ] **Step 4: Run the new E2E suite one more time**

Run: `pnpm start` in one terminal, then in another:
`E2E_HEADED=0 pnpm tsx src/tests/e2e/e2e-profile-blossom.ts`
Expected: all 5 tests PASS.

- [ ] **Step 5: Run the regression suite**

Run: `pnpm tsx src/tests/e2e/e2e-bug-regression.ts`
Expected: still green — the changes should not affect the 4 P2P regression bugs.

- [ ] **Step 6: Final commit (only if extra lint/tsc fixes were needed)**

```bash
git status
# If there are unstaged fixes:
git add <files>
git commit -m "fix: lint and tsc fixes from validation pass"
```

---

## Self-review notes

- **Spec coverage:**
  - Menu entry: Task 8 ✓
  - Merged tab: Tasks 6, 7 ✓
  - Blossom upload: Tasks 3, 4, 5 ✓
  - E2E (5 cases): Tasks 10, 11, 12, 13 ✓
  - `picture` field threading: Task 1 ✓
  - Raw blob exposure from `EditPeer`: Task 2 ✓
- **Open items carried from spec:** SDK license is handled (Task 3 has fallback path); `uploadAvatar()` blob access is handled (Task 2 extends `AvatarEdit`). The remaining spec risks (`handleChange` enablement races, reopen avatar refresh) are observable in Task 9 manual smoke and Task 10 E2E — if they fail, debug in place rather than pre-emptively adding code.
- **Type consistency:** `lastAvatarBlob` used in Tasks 2 and 6, `picture` accessor used in Tasks 1 and 8, `uploadToBlossom` signature `(blob, privkeyHex) → {url, sha256}` used in Tasks 4, 5, 6.
- **No placeholders:** every code step is concrete; the one "check and adapt" step (Task 6 Step 6 for `importFromMnemonic` return shape) is an explicit verification with an exact grep command and a specific adaptation if the shape differs.
