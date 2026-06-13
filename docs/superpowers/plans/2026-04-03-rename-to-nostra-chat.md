# Rename Nostra.chat → Nostra.chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all traces of "Nostra.chat" and "Telegram" branding from the codebase, replacing with "Nostra.chat" to avoid legal issues before publication.

**Architecture:** Mechanical rename in 7 waves: (1) directory renames, (2) file renames, (3) code content replacements for "nostra", (4) code content replacements for "telegram" branding, (5) config/manifest updates, (6) documentation updates, (7) test verification. MTProto protocol URLs (functional WebSocket/HTTPS endpoints) are preserved but commented for phase-07 removal.

**Tech Stack:** bash (sed, git mv), TypeScript, SCSS

---

## Naming Convention

| Context | Old | New |
|---------|-----|-----|
| Brand (UI, titles) | Nostra.chat | Nostra.chat |
| Directory/module | `nostra` | `nostra` |
| camelCase identifier | `nostraBridge` | `nostraBridge` |
| PascalCase identifier | `NostraIceConfig` | `NostraIceConfig` |
| SCREAMING_CASE | `NOSTRA_RESPONSES` | `NOSTRA_RESPONSES` |
| CSS class | `.nostra-*` | `.nostra-*` |
| URL/domain | `nostra.chat` | `nostra.chat` |

## Scope Exclusions (MTProto functional code)

These files contain `telegram` in **functional** URLs/protocol code that would break the app if changed. They are tagged with `// TODO(phase-07): remove telegram dependency` comments instead:

- `src/lib/mtproto/dcConfigurator.ts` — WebSocket URLs to `web.telegram.org`
- `src/lib/mtproto/networker.ts` — network protocol references
- `src/lib/mtproto/authorizer.ts` — auth protocol references
- `src/layer.d.ts` — auto-generated MTProto types with JSDoc links to `core.telegram.org`
- `src/config/app.ts` — `MAIN_DOMAINS` array pointing to telegram.org
- `src/lib/telegramMeWebManager.ts` — handles t.me/telegram.me deep links (file rename deferred to phase-07)
- `src/components/telegramWebView.ts` — Telegram Bot WebApp bridge (file rename deferred to phase-07)
- `src/lib/richTextProcessor/wrapTelegramRichText.ts` — Telegram rich text (file rename deferred to phase-07)
- `src/lib/richTextProcessor/wrapTelegramUrlToAnchor.ts` — Telegram URL handling (file rename deferred to phase-07)
- `src/lib/calls/` — SDP/RTC protocol code referencing Telegram call specs
- `src/lib/internalLinkProcessor.ts` — processes t.me deep links
- `src/lib/internalLink.ts` — internal link type definitions
- `src/components/webApp.tsx` — TelegramWebView integration
- `src/components/chat/bubbles.ts` — `telegram_channel`, `telegram_bot` etc. entity type strings (Telegram API enum values)

---

### Task 1: Rename directories (nostra → nostra)

**Files:**
- Rename: `src/lib/nostra/` → `src/lib/nostra/`
- Rename: `src/components/nostra/` → `src/components/nostra/`
- Rename: `src/pages/nostra/` → `src/pages/nostra/`
- Rename: `src/scss/nostra/` → `src/scss/nostra/`
- Rename: `src/tests/nostra/` → `src/tests/nostra/`

- [ ] **Step 1: Rename all nostra directories using git mv**

```bash
cd /home/raider/Repository/nostra
git mv src/lib/nostra src/lib/nostra
git mv src/components/nostra src/components/nostra
git mv src/pages/nostra src/pages/nostra
git mv src/scss/nostra src/scss/nostra
git mv src/tests/nostra src/tests/nostra
```

- [ ] **Step 2: Verify directories were renamed**

```bash
ls -d src/lib/nostra src/components/nostra src/pages/nostra src/scss/nostra src/tests/nostra
# All 5 should exist
ls -d src/lib/nostra src/components/nostra src/pages/nostra src/scss/nostra src/tests/nostra 2>&1
# All 5 should say "No such file or directory"
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: rename nostra directories to nostra"
```

---

### Task 2: Rename files with "nostra" in the name

**Files:**
- Rename: `src/lib/nostra/nostra-bridge.ts` → `src/lib/nostra/nostra-bridge.ts`
- Rename: `src/lib/nostra/nostra-display-bridge.ts` → `src/lib/nostra/nostra-display-bridge.ts`
- Rename: `src/lib/nostra/nostra-send-bridge.ts` → `src/lib/nostra/nostra-send-bridge.ts`
- Rename: `src/stores/nostraIdentity.ts` → `src/stores/nostraIdentity.ts`
- Rename: `src/components/sidebarLeft/tabs/nostraIdentity.ts` → `src/components/sidebarLeft/tabs/nostraIdentity.ts`
- Rename: `src/components/sidebarLeft/tabs/nostraNewGroup.ts` → `src/components/sidebarLeft/tabs/nostraNewGroup.ts`
- Rename: `src/components/sidebarLeft/tabs/nostraRelaySettings.ts` → `src/components/sidebarLeft/tabs/nostraRelaySettings.ts`
- Rename: `src/components/sidebarLeft/tabs/nostraSecurity.ts` → `src/components/sidebarLeft/tabs/nostraSecurity.ts`
- Rename: `src/components/sidebarRight/tabs/nostraGroupInfo.ts` → `src/components/sidebarRight/tabs/nostraGroupInfo.ts`
- Rename: `src/pages/nostra-onboarding-integration.ts` → `src/pages/nostra-onboarding-integration.ts`
- Rename: `src/pages/nostra-onboarding-tweb.css` → `src/pages/nostra-onboarding-tweb.css`
- Rename: `src/pages/nostra-add-peer-dialog.tsx` → `src/pages/nostra-add-peer-dialog.tsx`
- Rename: `src/tests/nostra/nostra-bridge.test.ts` → `src/tests/nostra/nostra-bridge.test.ts`
- Rename: `src/tests/nostra/nostra-display-bridge.test.ts` → `src/tests/nostra/nostra-display-bridge.test.ts`
- Rename: `src/tests/nostra/nostra-add-peer-dialog.test.ts` → `src/tests/nostra/nostra-add-peer-dialog.test.ts`

- [ ] **Step 1: Rename all files with nostra in the name**

```bash
cd /home/raider/Repository/nostra

# Library files
git mv src/lib/nostra/nostra-bridge.ts src/lib/nostra/nostra-bridge.ts
git mv src/lib/nostra/nostra-display-bridge.ts src/lib/nostra/nostra-display-bridge.ts
git mv src/lib/nostra/nostra-send-bridge.ts src/lib/nostra/nostra-send-bridge.ts

# Store
git mv src/stores/nostraIdentity.ts src/stores/nostraIdentity.ts

# Sidebar tabs
git mv src/components/sidebarLeft/tabs/nostraIdentity.ts src/components/sidebarLeft/tabs/nostraIdentity.ts
git mv src/components/sidebarLeft/tabs/nostraNewGroup.ts src/components/sidebarLeft/tabs/nostraNewGroup.ts
git mv src/components/sidebarLeft/tabs/nostraRelaySettings.ts src/components/sidebarLeft/tabs/nostraRelaySettings.ts
git mv src/components/sidebarLeft/tabs/nostraSecurity.ts src/components/sidebarLeft/tabs/nostraSecurity.ts
git mv src/components/sidebarRight/tabs/nostraGroupInfo.ts src/components/sidebarRight/tabs/nostraGroupInfo.ts

# Pages
git mv src/pages/nostra-onboarding-integration.ts 2>/dev/null; git mv src/pages/nostra-onboarding-integration.ts src/pages/nostra-onboarding-integration.ts 2>/dev/null || true
git mv src/pages/nostra-onboarding-tweb.css src/pages/nostra-onboarding-tweb.css 2>/dev/null || true
git mv src/pages/nostra-add-peer-dialog.tsx src/pages/nostra-add-peer-dialog.tsx 2>/dev/null || true

# Tests
git mv src/tests/nostra/nostra-bridge.test.ts src/tests/nostra/nostra-bridge.test.ts
git mv src/tests/nostra/nostra-display-bridge.test.ts src/tests/nostra/nostra-display-bridge.test.ts
git mv src/tests/nostra/nostra-add-peer-dialog.test.ts src/tests/nostra/nostra-add-peer-dialog.test.ts
```

- [ ] **Step 2: Verify no nostra-named files remain**

```bash
find src -name "*nostra*" -not -path "*/node_modules/*"
# Should return empty
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: rename nostra files to nostra"
```

---

### Task 3: Replace "nostra" content in ALL source files

This task replaces all variations of "nostra" inside file contents across the entire `src/` tree.

**Files:** All 107 source files containing "nostra" (see exploration results)

- [ ] **Step 1: Replace all nostra content variants in src/ files**

Run these sed commands to handle all case variants:

```bash
cd /home/raider/Repository/nostra

# Nostra.chat (brand) → Nostra.chat
find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.css" -o -name "*.scss" \) \
  -exec sed -i "s/Nostra.chat/Nostra.chat/g" {} +

# NOSTRA_ (constants) → NOSTRA_
find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" \) \
  -exec sed -i "s/NOSTRA_/NOSTRA_/g" {} +

# nostra- (kebab in file refs, CSS classes) → nostra-
find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.css" -o -name "*.scss" \) \
  -exec sed -i "s/nostra-/nostra-/g" {} +

# nostra/ (path references) → nostra/
find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" \) \
  -exec sed -i "s|nostra/|nostra/|g" {} +

# nostraI, nostraN, etc (camelCase identifiers) → nostraI, nostraN, etc
# Using word boundary: nostra followed by uppercase letter
find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" \) \
  -exec sed -i "s/nostra\([A-Z]\)/nostra\1/g" {} +

# Remaining standalone "nostra" (e.g. in strings, comments)
find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.css" -o -name "*.scss" \) \
  -exec sed -i "s/nostra/nostra/g" {} +

# nostra.chat domain → nostra.chat
find src -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" \) \
  -exec sed -i "s/nostra\.app/nostra.chat/g" {} +
```

- [ ] **Step 2: Verify no nostra references remain in src/**

```bash
grep -ri "nostra" src/ --include="*.ts" --include="*.tsx" --include="*.js" --include="*.css" --include="*.scss" | head -20
# Should return empty
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: replace all nostra references with nostra in source code"
```

---

### Task 4: Replace "Telegram" branding in user-visible strings

Replace "Telegram" in UI-facing strings (`lang.ts`, `langSign.ts`) and app metadata. Do NOT touch MTProto protocol code, `layer.d.ts`, or WebSocket URLs.

**Files:**
- Modify: `src/lang.ts` — all user-visible "Telegram" → "Nostra.chat"
- Modify: `src/langSign.ts` — sign-in strings "Telegram" → "Nostra.chat"
- Modify: `src/config/app.ts` — add comment about legacy domains
- Modify: `src/tests/build-output.test.ts` — update test expectations
- Modify: `src/tests/nostra/ui-cleanup.test.ts` — update test expectations

- [ ] **Step 1: Replace Telegram branding in lang.ts**

```bash
cd /home/raider/Repository/nostra

# Replace "Telegram" with "Nostra.chat" in lang.ts
# BUT preserve URLs like telegram.org/android, getdesktop.telegram.org
# Strategy: first replace brand mentions, then fix URLs back

# Replace all "Telegram" brand mentions in lang.ts
sed -i "s/Telegram Web/Nostra.chat/g" src/lang.ts
sed -i "s/Telegram Premium/Nostra.chat Premium/g" src/lang.ts
sed -i "s/on Telegram/on Nostra.chat/g" src/lang.ts
sed -i "s/to Telegram/to Nostra.chat/g" src/lang.ts
sed -i "s/in Telegram/in Nostra.chat/g" src/lang.ts
sed -i "s/of Telegram/of Nostra.chat/g" src/lang.ts
sed -i "s/use Telegram/use Nostra.chat/g" src/lang.ts
sed -i "s/Use Telegram/Use Nostra.chat/g" src/lang.ts
sed -i "s/Open Telegram/Open Nostra.chat/g" src/lang.ts
sed -i "s/by Telegram/by Nostra.chat/g" src/lang.ts
sed -i "s/from Telegram/from Nostra.chat/g" src/lang.ts
sed -i "s/with Telegram/with Nostra.chat/g" src/lang.ts
sed -i "s/for Telegram/for Nostra.chat/g" src/lang.ts
sed -i "s/Give Telegram/Give Nostra.chat/g" src/lang.ts

# Catch any remaining standalone "Telegram" that is a brand reference (not in URLs)
# This handles cases like "Telegram is syncing"
sed -i "s/Telegram is /Nostra.chat is /g" src/lang.ts
sed -i "s/Telegram supports/Nostra.chat supports/g" src/lang.ts
sed -i "s/Telegram will /Nostra.chat will /g" src/lang.ts
sed -i "s/Telegram automatically/Nostra.chat automatically/g" src/lang.ts
sed -i "s/Telegram and /Nostra.chat and /g" src/lang.ts
```

- [ ] **Step 2: Replace Telegram branding in langSign.ts**

```bash
sed -i "s/Sign in to Telegram/Sign in to Nostra.chat/g" src/langSign.ts
sed -i "s/in Telegram/in Nostra.chat/g" src/langSign.ts
sed -i "s/Open Telegram/Open Nostra.chat/g" src/langSign.ts
sed -i "s/Telegram Premium/Nostra.chat Premium/g" src/langSign.ts
sed -i "s/Log in to Telegram/Log in to Nostra.chat/g" src/langSign.ts
```

- [ ] **Step 3: Verify remaining Telegram references in lang files are only URLs**

```bash
grep -n "Telegram" src/lang.ts | grep -v "telegram.org" | grep -v "getdesktop.telegram" | grep -v "t\.me" | head -20
grep -n "Telegram" src/langSign.ts | grep -v "telegram.org" | head -10
# Should only show URL references, not brand mentions
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: replace Telegram branding with Nostra.chat in UI strings"
```

---

### Task 5: Update config, manifest, and public files

**Files:**
- Modify: `vite.config.ts` — title, description, url
- Modify: `public/site.webmanifest` — name, short_name, description
- Modify: `public/404.html` — title
- Modify: `package.json` — name field
- Modify: `.github/workflows/deploy.yml` — workflow name
- Modify: `README.md` — complete rewrite of header
- Modify: `TELEGRAM_FEATURES.md` — rename file to `FEATURES.md`

- [ ] **Step 1: Update vite.config.ts metadata**

Replace lines 34-39 in `vite.config.ts`:
```typescript
  context: {
    title: 'Nostra.chat',
    description: 'Nostra.chat is a privacy-first messaging app with end-to-end encryption and anonymous relay-based delivery.',
    url: 'https://nostra.chat/',
    origin: 'https://nostra.chat/'
  }
```

- [ ] **Step 2: Update public/site.webmanifest**

Replace name and description:
```json
{
    "name": "Nostra.chat",
    "short_name": "Nostra.chat",
    "description": "Privacy-first decentralized messaging with end-to-end encryption",
    ...
}
```

- [ ] **Step 3: Update public/404.html title**

```html
<title>Nostra.chat</title>
```

- [ ] **Step 4: Update package.json name**

```json
"name": "nostra-chat",
```

- [ ] **Step 5: Update deploy.yml workflow name**

```yaml
name: Deploy Nostra.chat
```

- [ ] **Step 6: Rewrite README.md header**

```markdown
## Nostra.chat
Privacy-first decentralized messaging with end-to-end encryption and anonymous relay-based delivery.

Based on tweb (Telegram Web K), re-engineered for decentralized Nostr-based communication.
```

- [ ] **Step 7: Rename TELEGRAM_FEATURES.md**

```bash
git mv TELEGRAM_FEATURES.md FEATURES.md
sed -i "s/Telegram Features/Features/g" FEATURES.md
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: update configs and manifests for Nostra.chat branding"
```

---

### Task 6: Update CLAUDE.md project documentation

**Files:**
- Modify: `CLAUDE.md` — replace Nostra.chat/Telegram branding throughout

- [ ] **Step 1: Replace all Nostra.chat/Telegram brand references in CLAUDE.md**

```bash
cd /home/raider/Repository/nostra

# Replace project identity
sed -i "s/tweb (Telegram Web K)/Nostra.chat (formerly tweb)/g" CLAUDE.md
sed -i "s/Telegram Web K/Nostra.chat/g" CLAUDE.md
sed -i "s/Telegram web client/decentralized messaging client/g" CLAUDE.md
sed -i "s/web.telegram.org\/k\//nostra.chat\//g" CLAUDE.md
sed -i "s/Telegram's MTProto/MTProto/g" CLAUDE.md

# Replace Nostra.chat references
sed -i "s/Nostra.chat/Nostra.chat/g" CLAUDE.md
sed -i "s/nostra/nostra/g" CLAUDE.md
sed -i "s/nostraIntercept/nostraIntercept/g" CLAUDE.md

# Replace directory references
sed -i "s|src/lib/nostra/|src/lib/nostra/|g" CLAUDE.md
sed -i "s|src/components/nostra/|src/components/nostra/|g" CLAUDE.md
```

- [ ] **Step 2: Verify no Nostra.chat/Telegram branding remains (excluding MTProto technical notes)**

```bash
grep -in "nostra\|Nostra.chat" CLAUDE.md
# Should return empty
grep -in "Telegram" CLAUDE.md | grep -v "MTProto" | grep -v "mtproto" | grep -v "phase-07" | grep -v "tweb"
# Should return empty or only technical context references
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for Nostra.chat branding"
```

---

### Task 7: Update planning and GSD documentation

**Files:** ~250+ files in `.planning/` and `.gsd/` directories

- [ ] **Step 1: Bulk replace in .planning/ directory**

```bash
cd /home/raider/Repository/nostra

find .planning -type f -name "*.md" -exec sed -i \
  -e "s/Nostra.chat/Nostra.chat/g" \
  -e "s/nostra/nostra/g" \
  -e "s/NOSTRA/NOSTRA/g" \
  -e "s|nostra\.app|nostra.chat|g" \
  {} +
```

- [ ] **Step 2: Bulk replace in .gsd/ directory**

```bash
find .gsd -type f -name "*.md" -o -name "*.json" | xargs sed -i \
  -e "s/Nostra.chat/Nostra.chat/g" \
  -e "s/nostra/nostra/g" \
  -e "s/NOSTRA/NOSTRA/g" \
  -e "s|nostra\.app|nostra.chat|g"
```

- [ ] **Step 3: Bulk replace in docs/ directory**

```bash
find docs -type f -name "*.md" -exec sed -i \
  -e "s/Nostra.chat/Nostra.chat/g" \
  -e "s/nostra/nostra/g" \
  -e "s/NOSTRA/NOSTRA/g" \
  -e "s|nostra\.app|nostra.chat|g" \
  {} +
```

- [ ] **Step 4: Replace Telegram branding in planning docs (not MTProto technical refs)**

```bash
# Replace "Telegram" brand references but keep technical MTProto discussion intact
find .planning -type f -name "*.md" -exec sed -i \
  -e "s/Telegram Web K/Nostra.chat/g" \
  -e "s/Telegram Web/Nostra.chat/g" \
  -e "s/Telegram UX/messaging UX/g" \
  -e "s/Telegram chat UI/chat UI/g" \
  {} +

find .gsd -type f -name "*.md" -exec sed -i \
  -e "s/Telegram Web K/Nostra.chat/g" \
  -e "s/Telegram Web/Nostra.chat/g" \
  -e "s/Telegram UX/messaging UX/g" \
  -e "s/Telegram chat UI/chat UI/g" \
  {} +
```

- [ ] **Step 5: Verify**

```bash
grep -ri "nostra" .planning/ .gsd/ docs/ | head -5
# Should return empty
```

- [ ] **Step 6: Commit**

```bash
git add .planning/ .gsd/ docs/
git commit -m "docs: update planning and GSD docs for Nostra.chat branding"
```

---

### Task 8: Update memory files and remaining root files

**Files:**
- Modify: Claude memory files in `~/.claude/projects/-home-raider-Repository-nostra/memory/`
- Modify: `todo.md`
- Modify: `CHANGELOG.md`, `CHANGELOG_ru.md`
- Modify: `SECURITY.md`
- Modify: `stats.html`

- [ ] **Step 1: Update todo.md**

```bash
cd /home/raider/Repository/nostra
sed -i -e "s/Nostra.chat/Nostra.chat/g" -e "s/nostra/nostra/g" todo.md
```

- [ ] **Step 2: Update CHANGELOG files**

```bash
sed -i \
  -e "s/Telegram Web K/Nostra.chat/g" \
  -e "s/WebK/Nostra.chat/g" \
  CHANGELOG.md CHANGELOG_ru.md
```

- [ ] **Step 3: Update SECURITY.md if it has brand references**

```bash
sed -i -e "s/Nostra.chat/Nostra.chat/g" -e "s/nostra/nostra/g" SECURITY.md 2>/dev/null || true
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: update remaining root files for Nostra.chat branding"
```

---

### Task 9: Run tests and fix any breakage

- [ ] **Step 1: Run the full test suite**

```bash
cd /home/raider/Repository/nostra
pnpm test -- --run 2>&1 | head -100
```

Expected: Some tests may fail due to import path changes or string expectations.

- [ ] **Step 2: Fix any import path failures**

Check for remaining broken imports by searching for old paths:

```bash
grep -rn "from.*nostra" src/ --include="*.ts" --include="*.tsx" | head -20
grep -rn "import.*nostra" src/ --include="*.ts" --include="*.tsx" | head -20
```

Fix any remaining references.

- [ ] **Step 3: Run tests again to verify all pass**

```bash
pnpm test -- --run 2>&1 | tail -30
```

Expected: All tests pass.

- [ ] **Step 4: Run lint check**

```bash
pnpm lint 2>&1 | tail -20
```

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve import paths and test expectations after rename"
```

---

### Task 10: Final verification sweep

- [ ] **Step 1: Comprehensive grep for any remaining nostra references**

```bash
cd /home/raider/Repository/nostra
grep -ri "nostra" src/ --include="*.ts" --include="*.tsx" --include="*.js" --include="*.css" --include="*.scss" | wc -l
grep -ri "nostra" CLAUDE.md README.md package.json vite.config.ts public/ .github/ | wc -l
```

Both should return 0.

- [ ] **Step 2: Check for Telegram branding in user-visible code (excluding MTProto internals)**

```bash
# Check lang files
grep -c "Telegram" src/lang.ts src/langSign.ts
# Remaining hits should only be in URLs (telegram.org/android, etc.)

# Check UI components for stray Telegram brand references
grep -rn "Telegram" src/components/ src/pages/ --include="*.ts" --include="*.tsx" | \
  grep -v "telegramWebView" | grep -v "telegramMeWeb" | grep -v "wrapTelegram" | \
  grep -v "telegram_channel" | grep -v "telegram_bot" | grep -v "telegram_mega" | \
  grep -v "telegram_user" | grep -v "telegram_chatlist" | grep -v "telegram_story" | \
  grep -v "telegram_gift" | grep -v "telegram_nft" | grep -v "telegram_collection" | \
  grep -v "telegram_livestream" | grep -v "telegram_stickerset" | \
  head -20
```

- [ ] **Step 3: Build the project to verify no compile errors**

```bash
pnpm build 2>&1 | tail -20
```

- [ ] **Step 4: Final commit if any remaining fixes needed**

```bash
git add -A
git commit -m "refactor: final cleanup of rename to Nostra.chat" 2>/dev/null || echo "Nothing to commit"
```
