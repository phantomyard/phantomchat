# Dicebear Fun Emoji Avatar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace initials + gradient fallback avatars with deterministic Dicebear fun-emoji SVGs generated from each peer's npub hex.

**Architecture:** A new helper module (`generateDicebearAvatar.ts`) generates SVG from hex, converts to blob URL, and caches in memory. The avatar component (`avatarNew.tsx`) calls this helper in its fallback path. The onboarding page shows the generated avatar in the display-name step.

**Tech Stack:** `@dicebear/core`, `@dicebear/collection` (fun-emoji), Solid.js, TypeScript

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/helpers/generateDicebearAvatar.ts` | Generate fun-emoji SVG → blob URL with cache |
| Create | `src/tests/generateDicebearAvatar.test.ts` | Tests for the generator |
| Modify | `src/components/avatarNew.tsx:674-698` | Call dicebear in fallback path instead of initials |
| Modify | `src/pages/nostra/onboarding.ts:285-322` | Show avatar preview in display-name step |
| Modify | `src/pages/nostra/onboarding.css` | Style the avatar preview |
| Modify | `package.json` | Add @dicebear/core and @dicebear/collection |

---

### Task 1: Install Dicebear Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install packages**

```bash
pnpm add @dicebear/core @dicebear/collection
```

- [ ] **Step 2: Verify installation**

```bash
pnpm ls @dicebear/core @dicebear/collection
```

Expected: Both packages listed with versions.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @dicebear/core and @dicebear/collection dependencies"
```

---

### Task 2: Create `generateDicebearAvatar` Helper — Tests

**Files:**
- Create: `src/tests/generateDicebearAvatar.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import {describe, it, expect, beforeEach} from 'vitest';
import {generateDicebearAvatar, clearDicebearCache} from '@helpers/generateDicebearAvatar';

describe('generateDicebearAvatar', () => {
  beforeEach(() => {
    clearDicebearCache();
  });

  it('should return a blob URL for a valid hex string', async() => {
    const hex = 'a'.repeat(64);
    const url = await generateDicebearAvatar(hex);
    expect(url).toMatch(/^blob:/);
  });

  it('should return the same URL for the same hex (cached)', async() => {
    const hex = 'b'.repeat(64);
    const url1 = await generateDicebearAvatar(hex);
    const url2 = await generateDicebearAvatar(hex);
    expect(url1).toBe(url2);
  });

  it('should return different URLs for different hex strings', async() => {
    const url1 = await generateDicebearAvatar('a'.repeat(64));
    const url2 = await generateDicebearAvatar('b'.repeat(64));
    expect(url1).not.toBe(url2);
  });

  it('should clear cache when clearDicebearCache is called', async() => {
    const hex = 'c'.repeat(64);
    const url1 = await generateDicebearAvatar(hex);
    clearDicebearCache();
    const url2 = await generateDicebearAvatar(hex);
    // After cache clear, a new blob URL is generated (different object)
    expect(url2).toMatch(/^blob:/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/tests/generateDicebearAvatar
```

Expected: FAIL — module `@helpers/generateDicebearAvatar` not found.

- [ ] **Step 3: Commit**

```bash
git add src/tests/generateDicebearAvatar.test.ts
git commit -m "test: add tests for generateDicebearAvatar helper"
```

---

### Task 3: Create `generateDicebearAvatar` Helper — Implementation

**Files:**
- Create: `src/helpers/generateDicebearAvatar.ts`

- [ ] **Step 1: Write implementation**

```typescript
import {createAvatar} from '@dicebear/core';
import {funEmoji} from '@dicebear/collection';

const cache = new Map<string, string>();

/**
 * Generate a deterministic fun-emoji avatar blob URL from a hex pubkey.
 * Results are cached in memory — same hex always returns same blob URL.
 */
export async function generateDicebearAvatar(hex: string): Promise<string> {
  const cached = cache.get(hex);
  if(cached) {
    return cached;
  }

  const avatar = createAvatar(funEmoji, {
    seed: hex,
    size: 128
  });

  const svg = avatar.toString();
  const blob = new Blob([svg], {type: 'image/svg+xml'});
  const url = URL.createObjectURL(blob);
  cache.set(hex, url);
  return url;
}

/**
 * Clear all cached blob URLs. Useful for testing.
 */
export function clearDicebearCache(): void {
  for(const url of cache.values()) {
    URL.revokeObjectURL(url);
  }
  cache.clear();
}
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
pnpm test src/tests/generateDicebearAvatar
```

Expected: All 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/helpers/generateDicebearAvatar.ts
git commit -m "feat: add generateDicebearAvatar helper with blob URL caching"
```

---

### Task 4: Integrate Dicebear into `avatarNew.tsx` Fallback Path

**Files:**
- Modify: `src/components/avatarNew.tsx:674-698`

The fallback path is in the `_render` function, around lines 674-698. Currently when there's no avatar photo and it's not cached, it calls `getPeerInitials(peer)` and renders initials with a color gradient. We replace this with the dicebear avatar.

- [ ] **Step 1: Add imports at the top of `avatarNew.tsx`**

Add after the existing imports (after line 50):

```typescript
import {generateDicebearAvatar} from '@helpers/generateDicebearAvatar';
import {getPubkey} from '@lib/nostra/virtual-peers-db';
```

- [ ] **Step 2: Replace the fallback block**

Find this block (lines 673-701):

```typescript
    let isSet = false;
    if(!avatarRendered && !isAvatarCached) {
      let color: string;
      if(peerId && (peerId !== myId || !isDialog)) {
        color = getPeerAvatarColorByPeer(peer);
      }

      if(peerId === REPLIES_PEER_ID) {
        set({color, icon: 'reply_filled'});
        return;
      }

      if(peerId === HIDDEN_PEER_ID) {
        set({color: 'violet', icon: 'author_hidden'});
        return;
      }

      const abbr = /* title ? wrapAbbreviation(title) :  */getPeerInitials(peer);
      set({
        abbreviature: documentFragmentToNodes(abbr),
        color,
        isForum: _isForum,
        isSubscribed: _isSubscribed,
        isMonoforum: !!linkedMonoforumPeer,
        storiesSegments
      });
      isSet = true;
      // return Promise.resolve(true);
    }
```

Replace with:

```typescript
    let isSet = false;
    if(!avatarRendered && !isAvatarCached) {
      let color: string;
      if(peerId && (peerId !== myId || !isDialog)) {
        color = getPeerAvatarColorByPeer(peer);
      }

      if(peerId === REPLIES_PEER_ID) {
        set({color, icon: 'reply_filled'});
        return;
      }

      if(peerId === HIDDEN_PEER_ID) {
        set({color: 'violet', icon: 'author_hidden'});
        return;
      }

      // Try dicebear fun-emoji avatar from peer's hex pubkey
      const peerIdNum = typeof peerId === 'number' ? peerId : +peerId;
      const hexPubkey = (peer as any)?.p2pPubkey || (peerIdNum >= 1e15 ? await getPubkey(peerIdNum) : null);
      if(hexPubkey) {
        const dicebearUrl = await generateDicebearAvatar(hexPubkey);
        if(!middleware()) return;
        const img = document.createElement('img');
        img.className = 'avatar-photo';
        await renderImageFromUrlPromise(img, dicebearUrl, props.useCache);
        if(!middleware()) return;
        _setMedia(img);
        isSet = true;
      } else {
        const abbr = getPeerInitials(peer);
        set({
          abbreviature: documentFragmentToNodes(abbr),
          color,
          isForum: _isForum,
          isSubscribed: _isSubscribed,
          isMonoforum: !!linkedMonoforumPeer,
          storiesSegments
        });
        isSet = true;
      }
    }
```

- [ ] **Step 3: Verify the app builds**

```bash
pnpm build 2>&1 | tail -20
```

Expected: Build succeeds without errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/avatarNew.tsx
git commit -m "feat: use dicebear fun-emoji as fallback avatar for P2P peers"
```

---

### Task 5: Add Avatar Preview to Onboarding Display Name Step

**Files:**
- Modify: `src/pages/nostra/onboarding.ts:285-322`
- Modify: `src/pages/nostra/onboarding.css`

- [ ] **Step 1: Add import to onboarding.ts**

Add after the existing imports (after line 27):

```typescript
import {generateDicebearAvatar} from '@helpers/generateDicebearAvatar';
import {decodePubkey} from '@lib/nostra/nostr-identity';
```

- [ ] **Step 2: Modify `showDisplayName()` to include avatar preview**

Replace the method `showDisplayName()` (lines 285-322) with:

```typescript
  private showDisplayName(): void {
    this.currentStep = 'display-name';
    this.container.innerHTML = '';

    const h4 = document.createElement('h4');
    h4.classList.add('text-center');
    h4.textContent = 'Choose a Display Name';

    const subtitle = document.createElement('div');
    subtitle.classList.add('subtitle', 'text-center');
    subtitle.textContent = 'This is how others will see you';

    // Avatar preview from npub
    const avatarPreview = document.createElement('div');
    avatarPreview.classList.add('nostra-avatar-preview');

    const avatarImg = document.createElement('img');
    avatarImg.classList.add('nostra-avatar-img');
    avatarPreview.append(avatarImg);

    if(this.identity?.npub) {
      const hex = decodePubkey(this.identity.npub);
      generateDicebearAvatar(hex).then((url) => {
        avatarImg.src = url;
      });
    }

    const avatarLabel = document.createElement('div');
    avatarLabel.classList.add('nostra-avatar-label');
    avatarLabel.textContent = 'Your unique avatar';
    avatarPreview.append(avatarLabel);

    const nameField = new InputField({
      label: 'Display Name' as any,
      name: 'display-name',
      maxLength: 50,
      plainText: true
    });

    const inputWrapper = document.createElement('div');
    inputWrapper.classList.add('input-wrapper');

    const btnFinish = Button('btn-primary btn-color-primary');
    btnFinish.textContent = 'Get Started';
    btnFinish.addEventListener('click', async() => {
      const displayName = nameField.value.trim() || undefined;
      await this.completeOnboarding(displayName, btnFinish);
    });

    const btnSkip = Button('btn-primary btn-secondary btn-primary-transparent primary');
    btnSkip.textContent = 'Skip';
    btnSkip.addEventListener('click', async() => {
      await this.completeOnboarding(undefined, btnSkip);
    });

    inputWrapper.append(nameField.container, btnFinish, btnSkip);
    this.container.append(h4, subtitle, avatarPreview, inputWrapper);
    setTimeout(() => nameField.input.focus(), 100);
  }
```

- [ ] **Step 3: Add CSS for avatar preview**

Append to `src/pages/nostra/onboarding.css`:

```css
/* ─── Avatar Preview ───────────────────────────────────────────────── */

.nostra-avatar-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-bottom: 1.5rem;
}

.nostra-avatar-img {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: var(--surface-color, #f4f4f5);
  object-fit: cover;
}

.nostra-avatar-label {
  margin-top: 0.5rem;
  font-size: 0.8rem;
  color: var(--secondary-text-color);
}
```

- [ ] **Step 4: Verify the app builds**

```bash
pnpm build 2>&1 | tail -20
```

Expected: Build succeeds without errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/nostra/onboarding.ts src/pages/nostra/onboarding.css
git commit -m "feat: show dicebear avatar preview in onboarding display-name step"
```

---

### Task 6: Manual Testing & Cleanup

**Files:**
- None (verification only)

- [ ] **Step 1: Start dev server and test**

```bash
pnpm start
```

Open `http://localhost:8080` and verify:

1. **Onboarding**: Create new identity → display-name step shows fun-emoji avatar
2. **Contact list**: Contacts without photos show fun-emoji instead of initials
3. **Chat bubbles**: Sender avatar shows fun-emoji when no photo
4. **Profile**: Peer profile shows fun-emoji when no photo
5. **Determinism**: Same npub always shows the same emoji

- [ ] **Step 2: Run all tests**

```bash
pnpm test
```

Expected: All tests pass, including the new dicebear tests.

- [ ] **Step 3: Run linter**

```bash
pnpm lint
```

Expected: No new lint errors.

- [ ] **Step 4: Final commit (if any lint fixes needed)**

```bash
git add -A
git commit -m "fix: lint fixes for dicebear integration"
```
