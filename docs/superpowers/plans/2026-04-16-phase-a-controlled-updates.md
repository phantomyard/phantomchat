# Phase A — Controlled Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Nostra.chat's silent PWA auto-update mechanism with a user-controlled update flow that cross-verifies each release against 3 independent distribution origins and never activates new code without explicit consent.

**Architecture:** Service Worker is modified to never `skipWaiting()` in install and intercepts navigation. Each boot, the main thread runs `updateBootstrap()` first — three integrity defenses (local SW URL check, `registration.update()` byte-check, cross-source manifest verification) gate the app before normal init. On detected update, a modal popup shows the changelog + integrity verdict; on consent, the new bundle is hash-verified per file and registered.

**Tech Stack:** Solid.js (custom fork in `src/vendor/solid/`), TypeScript 5.7, Vite 5, Vitest, Playwright. Build scripts written as `.ts` executed via `npx tsx`. Service Worker using Web Crypto SHA-256. No new runtime dependencies (markdown rendering via minimal regex parser).

**Spec:** `docs/superpowers/specs/2026-04-16-phase-a-controlled-updates-design.md`

---

## File structure overview

### New files
- `src/scripts/build/emit-update-manifest.ts` — generates `dist/update-manifest.json` post-build
- `src/scripts/build/validate-update-manifest.ts` — CI-time sanity check of generated manifest
- `src/lib/update/types.ts` — shared types (`Manifest`, `UpdateState`, `BootGate`, `UpdateFlowState`, `CompromiseReason`, `FailureReason`, `IntegrityResult`)
- `src/lib/update/update-transport.ts` — `fetch` vs `webtorClient.fetch` selector based on privacy mode
- `src/lib/update/manifest-verifier.ts` — multi-source manifest fetch + verdict logic
- `src/lib/update/update-state-machine.ts` — state transitions + persistence
- `src/lib/update/update-bootstrap.ts` — top-level bootstrap orchestrator (Step 0 / 1a / 1b / 2 / gate)
- `src/lib/update/update-flow.ts` — download/verify/register/finalize handlers (Phases 3-6)
- `src/lib/update/compromise-alert-mount.ts` — full-screen mount helper for `<CompromiseAlert>`
- `src/lib/update/build-version.ts` — re-exports `BUILD_VERSION` constant (injected by Vite)
- `src/lib/update/promise-pool.ts` — tiny concurrency-bounded promise pool
- `src/components/popups/updateAvailable/index.tsx` — update popup (Solid)
- `src/components/popups/updateAvailable/index.module.scss` — popup styles
- `src/components/updateCompromise/index.tsx` — full-screen alert (Solid)
- `src/components/updateCompromise/index.module.scss` — alert styles
- `src/components/sidebarLeft/tabs/updateSettings.ts` — settings panel
- `src/tests/update/` — new test directory
- `src/tests/e2e/e2e-update-controlled.ts` — E2E suite
- `src/tests/e2e/helpers/local-manifest-server.ts` — multi-source manifest mock server
- `src/tests/e2e/helpers/rewrite-source-urls.ts` — injects local URLs into MANIFEST_SOURCES

### Modified files
- `src/lib/serviceWorker/index.service.ts` — remove `skipWaiting()` in install, remove `clients.claim()` in activate, add navigation intercept, add SKIP_WAITING message handler
- `src/lib/apiManagerProxy.ts:671` — add `updateViaCache: 'all'` to register options
- `src/index.ts` — invoke `updateBootstrap()` first
- `src/lib/rootScope.ts` — add update events to `BroadcastEvents`
- `src/lib/nostra/nostra-cleanup.ts` — clear `nostra.update.*` LS keys in both cleanup modes
- `src/components/sidebarLeft/tabs/nostraSecurity.ts` OR a new entry point — add row linking to new update settings tab
- `package.json` — add `tsx` devDep; update `build` script to call emit + validate
- `public/_headers` — cache headers for `/sw-*.js`, `/assets/*`, `/update-manifest.json`, etc.
- `cloudflare-worker/src/index.js` — rule to bypass cache for `/update-manifest.json`
- `.github/workflows/deploy.yml` — new job `upload-release-manifest`
- `vite.config.ts` — inject `BUILD_VERSION` constant from `package.json`

---

# Ship 1 — Build tooling & deployment infrastructure

**Shippable on its own.** Produces `update-manifest.json` at release time and configures CDN caching. No client code change yet — client continues to ignore the manifest in this ship. Safe to ship independently.

## Task 1.1: Add `tsx` devDependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `tsx` to devDependencies**

Run: `pnpm add -D tsx@^4.19.0`

Expected: `tsx` appears in `package.json` `devDependencies`, `pnpm-lock.yaml` updated.

- [ ] **Step 2: Verify tsx works**

Run: `npx tsx --version`

Expected: Prints a version like `tsx v4.19.0 node-v20.x.x`.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(build): add tsx for build-time TypeScript execution"
```

## Task 1.2: Create `src/scripts/build/` directory and stub `emit-update-manifest.ts`

**Files:**
- Create: `src/scripts/build/emit-update-manifest.ts`

- [ ] **Step 1: Create directory and initial file**

```bash
mkdir -p src/scripts/build
```

Create `src/scripts/build/emit-update-manifest.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Emits dist/update-manifest.json for Phase A controlled updates.
 * Input: dist/ directory (post-build), CHANGELOG.md, package.json
 * Output: dist/update-manifest.json
 */

import {readFileSync, writeFileSync, readdirSync, statSync} from 'fs';
import {createHash} from 'crypto';
import {join, relative} from 'path';
import {execSync} from 'child_process';

const DIST_DIR = 'dist';
const PKG = JSON.parse(readFileSync('package.json', 'utf8'));
const VERSION: string = PKG.version;
const GIT_SHA: string = process.env.GITHUB_SHA || execSync('git rev-parse HEAD').toString().trim();

const EXCLUDE_PATTERNS: RegExp[] = [
  /\.map$/,
  /update-manifest\.json$/
];

function sha256File(path: string): string {
  const h = createHash('sha256');
  h.update(readFileSync(path));
  return 'sha256-' + h.digest('hex');
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for(const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if(statSync(full).isDirectory()) results.push(...walkFiles(full));
    else results.push(full);
  }
  return results;
}

function extractChangelog(version: string): string {
  const raw = readFileSync('CHANGELOG.md', 'utf8');
  const regex = new RegExp(`##\\s*\\[${version.replace(/\./g, '\\.')}\\][\\s\\S]*?(?=\\n##\\s*\\[|$)`);
  const match = raw.match(regex);
  if(!match) return '';
  // strip the heading line itself; keep body
  return match[0].replace(/^##\s*\[[^\]]+\][^\n]*\n+/, '').trim();
}

function main() {
  const files = walkFiles(DIST_DIR);
  const bundleHashes: Record<string, string> = {};
  let swUrl: string | undefined;

  for(const f of files) {
    if(EXCLUDE_PATTERNS.some(p => p.test(f))) continue;
    const rel = './' + relative(DIST_DIR, f).replace(/\\/g, '/');
    bundleHashes[rel] = sha256File(f);
    if(/^\.\/sw-[a-z0-9]+\.js$/.test(rel)) {
      swUrl = rel;
    }
  }

  if(!swUrl) {
    throw new Error('SW file not found in dist/ (expected ./sw-<hash>.js)');
  }

  const manifest = {
    schemaVersion: 1,
    version: VERSION,
    gitSha: GIT_SHA,
    published: new Date().toISOString(),
    swUrl,
    bundleHashes,
    changelog: extractChangelog(VERSION),
    alternateSources: {}
  };

  const outPath = join(DIST_DIR, 'update-manifest.json');
  writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`Emitted ${outPath} for v${VERSION} (${Object.keys(bundleHashes).length} files, swUrl=${swUrl})`);
}

main();
```

- [ ] **Step 2: Verify it lints**

Run: `npx eslint src/scripts/build/emit-update-manifest.ts`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/scripts/build/emit-update-manifest.ts
git commit -m "feat(build): add emit-update-manifest.ts (Phase A manifest generator)"
```

## Task 1.3: Test `emit-update-manifest.ts` end-to-end

**Files:**
- Uses: existing `dist/` after a build

- [ ] **Step 1: Run a fresh build**

Run: `pnpm build`

Expected: `dist/` populated, exits 0.

- [ ] **Step 2: Execute the script manually**

Run: `npx tsx src/scripts/build/emit-update-manifest.ts`

Expected: Console prints `Emitted dist/update-manifest.json for v0.7.1 (<N> files, swUrl=./sw-<hash>.js)`.

- [ ] **Step 3: Inspect the output**

Run: `cat dist/update-manifest.json | head -40`

Expected fields visible: `schemaVersion: 1`, `version: "0.7.1"`, `gitSha`, `published` (ISO), `swUrl`, `bundleHashes` with many entries, `changelog`, `alternateSources: {}`.

- [ ] **Step 4: Validate hash format**

Run: `node -e "const m=require('./dist/update-manifest.json'); for(const [k,v] of Object.entries(m.bundleHashes)) { if(!/^sha256-[a-f0-9]{64}$/.test(v)) { console.error('BAD HASH for', k, v); process.exit(1); } } console.log('all hashes valid');"`

Expected: `all hashes valid`.

- [ ] **Step 5: Verify SW hash matches manifest entry**

Run: 
```bash
SW=$(node -e "console.log(require('./dist/update-manifest.json').swUrl)")
EXPECTED=$(node -e "console.log(require('./dist/update-manifest.json').bundleHashes[$(node -e "console.log(JSON.stringify(require('./dist/update-manifest.json').swUrl))")])")
ACTUAL="sha256-$(sha256sum dist/${SW#./} | cut -d' ' -f1)"
[ "$EXPECTED" = "$ACTUAL" ] && echo "match" || (echo "MISMATCH: $EXPECTED vs $ACTUAL"; exit 1)
```

Expected: `match`.

No commit (manual test only).

## Task 1.4: Add `validate-update-manifest.ts`

**Files:**
- Create: `src/scripts/build/validate-update-manifest.ts`

- [ ] **Step 1: Write the validator**

Create `src/scripts/build/validate-update-manifest.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Validates a generated update-manifest.json. Used in CI to fail-fast
 * on malformed manifests before publish.
 */

import {readFileSync, readdirSync, statSync} from 'fs';
import {join, relative} from 'path';

const PKG = JSON.parse(readFileSync('package.json', 'utf8'));

function die(msg: string): never {
  console.error(`validate-update-manifest: ${msg}`);
  process.exit(1);
}

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for(const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if(statSync(full).isDirectory()) results.push(...walkFiles(full));
    else results.push(full);
  }
  return results;
}

const manifestPath = process.argv[2];
if(!manifestPath) die('usage: validate-update-manifest.ts <path-to-manifest.json>');

const m = JSON.parse(readFileSync(manifestPath, 'utf8'));

// Required fields
for(const k of ['schemaVersion', 'version', 'gitSha', 'published', 'swUrl', 'bundleHashes', 'changelog']) {
  if(!(k in m)) die(`missing required field: ${k}`);
}

if(m.schemaVersion !== 1) die(`unexpected schemaVersion: ${m.schemaVersion}`);
if(m.version !== PKG.version) die(`version mismatch: manifest=${m.version} package.json=${PKG.version}`);
if(process.env.GITHUB_SHA && m.gitSha !== process.env.GITHUB_SHA) {
  die(`gitSha mismatch: manifest=${m.gitSha} GITHUB_SHA=${process.env.GITHUB_SHA}`);
}

if(!m.bundleHashes[m.swUrl]) die(`swUrl ${m.swUrl} not found in bundleHashes`);

// Every file in dist/ should be covered (or explicitly excluded)
const distDir = 'dist';
const files = walkFiles(distDir);
const covered = new Set(Object.keys(m.bundleHashes));
const EXCLUDED = [/\.map$/, /update-manifest\.json$/];

const missing: string[] = [];
for(const f of files) {
  if(EXCLUDED.some(p => p.test(f))) continue;
  const rel = './' + relative(distDir, f).replace(/\\/g, '/');
  if(!covered.has(rel)) missing.push(rel);
}

if(missing.length > 0) {
  die(`files in dist/ not covered by bundleHashes:\n${missing.map(f => '  - ' + f).join('\n')}`);
}

// Hash format check
for(const [k, v] of Object.entries(m.bundleHashes as Record<string, string>)) {
  if(!/^sha256-[a-f0-9]{64}$/.test(v)) die(`invalid hash format for ${k}: ${v}`);
}

if(!m.changelog || m.changelog.trim().length === 0) {
  console.warn(`validate-update-manifest: WARNING changelog is empty for v${m.version}`);
}

console.log(`validate-update-manifest: OK (v${m.version}, ${Object.keys(m.bundleHashes).length} files covered)`);
```

- [ ] **Step 2: Run it against the manifest from Task 1.3**

Run: `npx tsx src/scripts/build/validate-update-manifest.ts dist/update-manifest.json`

Expected: `validate-update-manifest: OK (v0.7.1, <N> files covered)`.

- [ ] **Step 3: Test failure mode — tamper the manifest**

```bash
cp dist/update-manifest.json /tmp/manifest-backup.json
node -e "const m=require('./dist/update-manifest.json'); delete m.schemaVersion; require('fs').writeFileSync('./dist/update-manifest.json', JSON.stringify(m))"
```

Run: `npx tsx src/scripts/build/validate-update-manifest.ts dist/update-manifest.json`

Expected: exits 1 with `missing required field: schemaVersion`.

Restore: `cp /tmp/manifest-backup.json dist/update-manifest.json`

- [ ] **Step 4: Commit**

```bash
git add src/scripts/build/validate-update-manifest.ts
git commit -m "feat(build): add validate-update-manifest.ts (CI manifest sanity check)"
```

## Task 1.5: Integrate into `package.json` build script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update the build script**

In `package.json`, change:
```json
"build": "pnpm run generate-changelog && pnpm run update-tor-consensus && vite build",
```

to:
```json
"build": "pnpm run generate-changelog && pnpm run update-tor-consensus && vite build && pnpm run emit-manifest && pnpm run validate-manifest",
"emit-manifest": "tsx src/scripts/build/emit-update-manifest.ts",
"validate-manifest": "tsx src/scripts/build/validate-update-manifest.ts dist/update-manifest.json",
```

- [ ] **Step 2: Run full build**

Run: `pnpm build`

Expected: exits 0, `dist/update-manifest.json` exists and validates.

- [ ] **Step 3: Verify manifest is in dist/**

Run: `ls -la dist/update-manifest.json`

Expected: file listed, non-empty.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build: wire emit-manifest + validate-manifest into pnpm build"
```

## Task 1.6: Update `public/_headers` with cache directives

**Files:**
- Modify: `public/_headers`

- [ ] **Step 1: Read current content**

Run: `cat public/_headers`

Expected: existing COOP/COEP headers.

- [ ] **Step 2: Append Phase A cache headers**

Append to `public/_headers`:

```
/sw-*.js
  Cache-Control: public, max-age=31536000, immutable

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/webtor/*
  Cache-Control: public, max-age=31536000, immutable

/*.woff2
  Cache-Control: public, max-age=31536000, immutable

/index.html
  Cache-Control: no-cache, must-revalidate

/
  Cache-Control: no-cache, must-revalidate

/update-manifest.json
  Cache-Control: no-cache, must-revalidate

/*.webmanifest
  Cache-Control: public, max-age=3600
```

- [ ] **Step 3: Rebuild and verify the file ships to dist**

Run: `pnpm build && cat dist/_headers | tail -30`

Expected: Phase A entries present.

- [ ] **Step 4: Commit**

```bash
git add public/_headers
git commit -m "ops(cdn): add Phase A cache-control headers for immutable assets and no-cache manifest"
```

## Task 1.7: Update `cloudflare-worker` to bypass cache for manifest

**Files:**
- Modify: `cloudflare-worker/src/index.js`

- [ ] **Step 1: Read current worker code**

Run: `cat cloudflare-worker/src/index.js | head -60`

Identify the request-routing section.

- [ ] **Step 2: Add manifest bypass rule**

In `cloudflare-worker/src/index.js`, before the main request handling logic (inside the `fetch` function entry), add:

```js
// Phase A: bypass all caches for update manifest to guarantee freshness.
if(url.pathname === '/update-manifest.json') {
  const upstream = await fetch(request, {cf: {cacheTtl: 0, cacheEverything: false}});
  const h = new Headers(upstream.headers);
  h.set('Cache-Control', 'no-cache, must-revalidate');
  h.set('Access-Control-Allow-Origin', '*');
  return new Response(upstream.body, {status: upstream.status, statusText: upstream.statusText, headers: h});
}
```

Exact placement depends on worker structure — place after `const url = new URL(request.url)` and before any DNSLink/IPFS logic.

- [ ] **Step 3: Deploy worker locally for smoke test (optional)**

Run: `cd cloudflare-worker && npx wrangler dev`

In another terminal: `curl -I http://localhost:8787/update-manifest.json`

Expected: `Cache-Control: no-cache, must-revalidate` in response headers.

- [ ] **Step 4: Commit**

```bash
git add cloudflare-worker/src/index.js
git commit -m "ops(worker): bypass cache for /update-manifest.json"
```

## Task 1.8: Add `upload-release-manifest` CI job

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Add a new job**

After the `deploy-github-pages` job block (maintaining consistent indentation), add:

```yaml
  upload-release-manifest:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: dist
          path: dist/

      - name: Upload manifest to GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: dist/update-manifest.json
          tag_name: ${{ github.ref_name }}
          fail_on_unmatched_files: true
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ops(ci): upload update-manifest.json as release asset on tag push"
```

## Task 1.9: Ship 1 milestone — squash merge to main

- [ ] **Step 1: Push branch / open PR**

This is a logical stopping point. Ship 1 is self-contained: produces manifests, configures CDN. Client code still ignores the manifest.

```bash
git push origin <branch>
gh pr create --title "Phase A Ship 1 — build tooling & deploy infra" --body "Spec: docs/superpowers/specs/2026-04-16-phase-a-controlled-updates-design.md. Ship 1 of 7."
```

---

# Ship 2 — Service Worker lifecycle changes

**Depends on:** Ship 1 merged (so `update-manifest.json` exists on CDN before clients start querying it in later ships).

**Key principle**: At the end of Ship 2, the SW no longer calls `skipWaiting()` in install and no longer calls `clients.claim()` in activate. This is the foundational behavioral change that enables later ships.

## Task 2.1: Remove `skipWaiting()` from SW install + pre-cache navigation entry

**Files:**
- Modify: `src/lib/serviceWorker/index.service.ts:349-352`

- [ ] **Step 1: Locate current install handler**

Run: `grep -n "addEventListener.'install'" src/lib/serviceWorker/index.service.ts`

Expected: line ~349.

- [ ] **Step 2: Replace the install handler**

Find:
```ts
ctx.addEventListener('install', (event) => {
  log('installing');
  event.waitUntil(ctx.skipWaiting().then(() => log('skipped waiting'))); // Activate worker immediately
});
```

Replace with:
```ts
ctx.addEventListener('install', (event) => {
  log('installing');
  event.waitUntil((async () => {
    try {
      const cache = await ctx.caches.open(CACHE_ASSETS_NAME);
      await cache.addAll(['./', './index.html']);
      log('pre-cached navigation entry');
    } catch(err) {
      log.warn('failed to pre-cache index.html', err);
    }
    // NO skipWaiting() — new SW stays in waiting until user consent via main-thread SKIP_WAITING message
  })());
});
```

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | grep -E "serviceWorker/index\.service" | head -5`

Expected: no new errors from this file (pre-existing errors from `@vendor/emoji` / `@vendor/bezierEasing` are OK per CLAUDE.md).

- [ ] **Step 4: Commit**

```bash
git add src/lib/serviceWorker/index.service.ts
git commit -m "feat(sw): remove skipWaiting from install, pre-cache navigation entry"
```

## Task 2.2: Remove `clients.claim()` from SW activate

**Files:**
- Modify: `src/lib/serviceWorker/index.service.ts:354-358`

- [ ] **Step 1: Locate current activate handler**

Run: `grep -n "addEventListener.'activate'" src/lib/serviceWorker/index.service.ts`

Expected: line ~354.

- [ ] **Step 2: Replace the activate handler**

Find:
```ts
ctx.addEventListener('activate', (event) => {
  log('activating', ctx);
  event.waitUntil(ctx.caches.delete(CACHE_ASSETS_NAME).then(() => log('cleared assets cache')));
  event.waitUntil(ctx.clients.claim().then(() => log('claimed clients')));
});
```

Replace with:
```ts
ctx.addEventListener('activate', (event) => {
  log('activating', ctx);
  event.waitUntil((async () => {
    // Clear old asset cache — reached either on explicit user consent (normal Phase A flow)
    // or on the one-time silent migration from pre-Phase A SW (spec: "migration strategy").
    await ctx.caches.delete(CACHE_ASSETS_NAME);
    log('cleared assets cache');
    // NO clients.claim() — reload is handled by main thread via controllerchange listener.
  })());
});
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/serviceWorker/index.service.ts
git commit -m "feat(sw): remove clients.claim from activate — main thread orchestrates reload"
```

## Task 2.3: Add navigation intercept to SW fetch handler

**Files:**
- Modify: `src/lib/serviceWorker/index.service.ts:266-274` (start of `onFetch`)

- [ ] **Step 1: Locate the `onFetch` function**

Run: `grep -n "const onFetch" src/lib/serviceWorker/index.service.ts`

Expected: line ~266.

- [ ] **Step 2: Insert navigation intercept at the top of `onFetch`**

Before the existing `if(import.meta.env.PROD && !IS_SAFARI && ...)` block, insert:

```ts
  // Phase A: intercept navigation so the SW serves cached index.html.
  // This prevents a compromised CDN from swapping /index.html to redirect
  // the browser to attacker-controlled chunk URLs that bypass the trusted bundle.
  if(
    import.meta.env.PROD &&
    (
      event.request.mode === 'navigate' ||
      /\/$|\.html?($|\?)/.test(event.request.url)
    ) &&
    new URL(event.request.url).origin === location.origin
  ) {
    return event.respondWith(requestCache(event));
  }
```

- [ ] **Step 3: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | grep "index.service"`

Expected: no new errors from the file.

- [ ] **Step 4: Commit**

```bash
git add src/lib/serviceWorker/index.service.ts
git commit -m "feat(sw): intercept navigation requests to serve cached index.html"
```

## Task 2.4: Add SKIP_WAITING message handler in SW

**Files:**
- Modify: `src/lib/serviceWorker/index.service.ts` (near bottom, before final `export` if any)

- [ ] **Step 1: Locate a good spot (after onChangeState or similar)**

Run: `grep -n "onChangeState\|ctx.addEventListener" src/lib/serviceWorker/index.service.ts | tail -5`

- [ ] **Step 2: Add the handler**

After the `ctx.addEventListener('activate', …)` block, add:

```ts
// Phase A: main thread sends {type: 'SKIP_WAITING'} after user consent.
// This is the ONLY path that promotes a waiting SW to active (no skipWaiting in install).
ctx.addEventListener('message', (event) => {
  if(event.data && event.data.type === 'SKIP_WAITING') {
    log('received SKIP_WAITING message, promoting this SW to active');
    ctx.skipWaiting();
  }
});
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/serviceWorker/index.service.ts
git commit -m "feat(sw): add SKIP_WAITING message handler for user-consent activation"
```

## Task 2.5: Add `updateViaCache: 'all'` to SW registration

**Files:**
- Modify: `src/lib/apiManagerProxy.ts:671-676`

- [ ] **Step 1: Locate the register call**

Run: `grep -n "serviceWorker.register" src/lib/apiManagerProxy.ts`

Expected: line ~671.

- [ ] **Step 2: Add the option**

Find:
```ts
navigator.serviceWorker.register(
  // * doesn't work
  // new URL('../../../sw.ts', import.meta.url),
  // '../../../sw',
  ServiceWorkerURL,
  {type: 'module', scope: './'}
).then((registration) => {
```

Replace the options object with:
```ts
  {type: 'module', scope: './', updateViaCache: 'all'}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/apiManagerProxy.ts
git commit -m "feat(sw): register with updateViaCache:'all' — respect HTTP cache on update checks"
```

## Task 2.6: Smoke test SW lifecycle changes

**Files:**
- Uses: dev server + browser

- [ ] **Step 1: Start dev server**

Run: `pnpm start`

Expected: Vite dev server on `:8080`.

- [ ] **Step 2: Open browser, load the app**

Go to `http://localhost:8080` in Chrome. Open DevTools → Application → Service Workers.

Expected: SW registered, active.

- [ ] **Step 3: Verify new install/activate behavior**

In DevTools → Application → Service Workers, note the active SW. Modify any source file in `src/` to trigger HMR rebuild. In SW section click "Update" — expected: a new SW appears in "installing" / "waiting" state and **does NOT auto-activate**. The old SW remains active.

- [ ] **Step 4: Send manual SKIP_WAITING**

In DevTools console:
```js
navigator.serviceWorker.getRegistration().then(r => r.waiting?.postMessage({type: 'SKIP_WAITING'}))
```

Expected: New SW transitions to active. Console logs visible (check DevTools → Application → Service Workers → "inspect").

No commit (manual test).

## Task 2.7: Ship 2 milestone — squash merge to main

- [ ] **Step 1: PR**

```bash
git push origin <branch>
gh pr create --title "Phase A Ship 2 — SW lifecycle changes" --body "Removes skipWaiting()/clients.claim() defaults, adds navigation intercept and SKIP_WAITING handler. No user-visible change yet (main thread still doesn't drive updates). Ship 2 of 7."
```

---

# Ship 3 — Bootstrap engine (integrity defenses)

**Depends on:** Ships 1 + 2 merged.

**Scope:** Implement `updateBootstrap()` module that runs FIRST at boot. Implements Step 0 (first install), Step 1a (local URL check), Step 1b (`registration.update()` byte-check), Step 2 (manifest cross-source verification). No UI yet — compromise detections just throw and log; new-version detection just dispatches an event.

## Task 3.1: Define shared types in `src/lib/update/types.ts`

**Files:**
- Create: `src/lib/update/types.ts`

- [ ] **Step 1: Write the types file**

Create `src/lib/update/types.ts`:

```ts
/**
 * Shared types for Phase A controlled updates.
 * Spec: docs/superpowers/specs/2026-04-16-phase-a-controlled-updates-design.md
 */

export interface Manifest {
  schemaVersion: number;
  version: string;
  gitSha: string;
  published: string;
  swUrl: string;
  bundleHashes: Record<string, string>;
  changelog: string;
  alternateSources?: Record<string, unknown>;
}

export type IntegrityVerdict = 'verified' | 'verified-partial' | 'conflict' | 'insufficient' | 'offline';

export interface IntegrityResult {
  verdict: IntegrityVerdict;
  manifest?: Manifest;
  sources: Array<{
    name: string;
    status: 'ok' | 'error' | 'stale';
    error?: string;
    version?: string;
    gitSha?: string;
    swUrl?: string;
  }>;
  checkedAt: number;
}

export enum BootGate {
  LocalChecksOnly = 'local-checks-only',
  NetworkPending = 'network-pending',
  AllVerified = 'all-verified'
}

export type CompromiseReason =
  | {type: 'sw-url-changed'; expected: string; got: string}
  | {type: 'sw-body-changed-at-same-url'; url?: string; waitingUrl?: string}
  | {type: 'manifest-schema-too-new'; receivedSchemaVersion: number};

export type FailureReason =
  | {type: 'network-error'; err: string}
  | {type: 'hash-mismatch'; path: string; expected: string; actual: string}
  | {type: 'install-timeout'}
  | {type: 'install-redundant'}
  | {type: 'register-failed'; err: string}
  | {type: 'finalization-url-mismatch'; expected: string; actual: string};

export type UpdateFlowState =
  | {kind: 'idle'}
  | {kind: 'available'; manifest: Manifest}
  | {kind: 'downloading'; target: Manifest; completed: number; total: number}
  | {kind: 'verifying'; target: Manifest}
  | {kind: 'registering'; target: Manifest}
  | {kind: 'finalizing'; target: Manifest}
  | {kind: 'failed'; reason: FailureReason; target?: Manifest};

export class CompromiseAlertError extends Error {
  readonly reason: CompromiseReason;
  constructor(reason: CompromiseReason) {
    super(`CompromiseAlert: ${reason.type}`);
    this.reason = reason;
    this.name = 'CompromiseAlertError';
  }
}

export class UpdateFlowError extends Error {
  readonly reason: FailureReason;
  constructor(reason: FailureReason) {
    super(`UpdateFlow: ${reason.type}`);
    this.reason = reason;
    this.name = 'UpdateFlowError';
  }
}
```

- [ ] **Step 2: TypeScript check**

Run: `npx tsc --noEmit 2>&1 | grep "lib/update"`

Expected: no errors from this file.

- [ ] **Step 3: Lint**

Run: `npx eslint src/lib/update/types.ts`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
mkdir -p src/lib/update
git add src/lib/update/types.ts
git commit -m "feat(update): add shared types for Phase A controlled updates"
```

## Task 3.2: Add `BUILD_VERSION` injection via Vite

**Files:**
- Modify: `vite.config.ts`
- Create: `src/lib/update/build-version.ts`

- [ ] **Step 1: Inspect vite.config.ts `define` section**

Run: `grep -n "define" vite.config.ts | head -5`

- [ ] **Step 2: Add BUILD_VERSION to define**

In `vite.config.ts`, inside the `define: {...}` block, add:

```ts
    __BUILD_VERSION__: JSON.stringify(pkg.version),
```

(ensure `pkg` is imported or already read — check existing pattern around version.)

- [ ] **Step 3: Create the typed re-export**

Create `src/lib/update/build-version.ts`:

```ts
/**
 * BUILD_VERSION — the semver of this build, injected by Vite from package.json.
 * Used by updateBootstrap to compare against localStorage installedVersion.
 */

declare const __BUILD_VERSION__: string;

export const BUILD_VERSION: string = __BUILD_VERSION__;
```

- [ ] **Step 4: Add global declaration if needed**

Run: `grep -n "__BUILD_VERSION__\|declare const __" src/global.d.ts`

If not present, append to `src/global.d.ts`:
```ts
declare const __BUILD_VERSION__: string;
```

- [ ] **Step 5: Verify build**

Run: `pnpm build 2>&1 | tail -10`

Expected: build succeeds.

- [ ] **Step 6: Verify injection**

Run: `grep -c "$(node -e 'console.log(require("./package.json").version)')" dist/assets/*.js | head -3`

Expected: version string appears in at least one emitted chunk.

- [ ] **Step 7: Commit**

```bash
git add vite.config.ts src/lib/update/build-version.ts src/global.d.ts
git commit -m "feat(update): inject BUILD_VERSION from package.json via Vite"
```

## Task 3.3: Write `src/lib/update/update-transport.ts`

**Files:**
- Create: `src/lib/update/update-transport.ts`

- [ ] **Step 1: Write the transport**

Create `src/lib/update/update-transport.ts`:

```ts
/**
 * Transport selector for update-related HTTP requests.
 * In privacy (Tor) mode, routes through webtorClient.fetch to avoid
 * leaking the user's IP to CDN / GitHub / IPFS gateways during
 * integrity checks. In direct mode, uses native fetch().
 */

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let currentFetch: FetchFn = (input, init) => fetch(input as any, init);

export function setUpdateTransport(fn: FetchFn): void {
  currentFetch = fn;
}

export function resetUpdateTransport(): void {
  currentFetch = (input, init) => fetch(input as any, init);
}

export const updateTransport = {
  fetch: (url: string, init?: RequestInit) => currentFetch(url, init)
};
```

**Note:** The wiring to `webtorClient.fetch` happens in `update-bootstrap.ts` once privacy settles — kept here as a pluggable indirection for testability.

- [ ] **Step 2: Lint and tsc**

Run: `npx eslint src/lib/update/update-transport.ts && npx tsc --noEmit 2>&1 | grep update-transport`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/update/update-transport.ts
git commit -m "feat(update): add update-transport with pluggable fetch for privacy mode"
```

## Task 3.4: Test + implement `manifest-verifier.ts`

**Files:**
- Create: `src/tests/update/manifest-verifier.test.ts`
- Create: `src/lib/update/manifest-verifier.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tests/update/manifest-verifier.test.ts`:

```ts
import {describe, it, expect, beforeEach, vi, afterEach} from 'vitest';
import {verifyManifestsAcrossSources} from '@lib/update/manifest-verifier';
import {setUpdateTransport, resetUpdateTransport} from '@lib/update/update-transport';
import type {Manifest} from '@lib/update/types';

const validManifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  schemaVersion: 1,
  version: '0.8.0',
  gitSha: 'abc123',
  published: '2026-05-10T12:00:00Z',
  swUrl: './sw-xyz.js',
  bundleHashes: {'./sw-xyz.js': 'sha256-aaa', './index.html': 'sha256-bbb'},
  changelog: 'changes',
  ...overrides
});

function mockFetchMap(byUrl: Map<string, Manifest | Error>): void {
  setUpdateTransport(async (url: any) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    for(const [pattern, result] of byUrl) {
      if(urlStr.includes(pattern)) {
        if(result instanceof Error) throw result;
        return new Response(JSON.stringify(result), {status: 200}) as any;
      }
    }
    throw new Error(`no mock for ${urlStr}`);
  });
}

describe('verifyManifestsAcrossSources', () => {
  afterEach(() => resetUpdateTransport());

  it('returns verified when all 3 sources agree', async () => {
    const m = validManifest();
    mockFetchMap(new Map([
      ['update-manifest.json', m],
      ['raw.githubusercontent', m],
      ['ipfs.nostra.chat', m]
    ]));

    const result = await verifyManifestsAcrossSources();
    expect(result.verdict).toBe('verified');
    expect(result.manifest).toEqual(m);
    expect(result.sources.filter(s => s.status === 'ok')).toHaveLength(3);
  });

  it('returns verified-partial when 2 succeed and 1 offline, and the 2 agree', async () => {
    const m = validManifest();
    mockFetchMap(new Map<string, Manifest | Error>([
      ['update-manifest.json', m],
      ['github.com/nostra-chat/nostra-chat/releases', m],
      ['ipfs.nostra.chat', new Error('offline')]
    ]));

    const result = await verifyManifestsAcrossSources();
    expect(result.verdict).toBe('verified-partial');
    expect(result.manifest).toEqual(m);
  });

  it('returns conflict when sources disagree on version', async () => {
    const m1 = validManifest({version: '0.8.0'});
    const m2 = validManifest({version: '0.9.0'});
    mockFetchMap(new Map([
      ['update-manifest.json', m1],
      ['github.com/nostra-chat/nostra-chat/releases', m2],
      ['ipfs.nostra.chat', m1]
    ]));

    const result = await verifyManifestsAcrossSources();
    expect(result.verdict).toBe('conflict');
  });

  it('returns insufficient when only 1 source succeeds', async () => {
    const m = validManifest();
    mockFetchMap(new Map<string, Manifest | Error>([
      ['update-manifest.json', m],
      ['github.com/nostra-chat/nostra-chat/releases', new Error('nope')],
      ['ipfs.nostra.chat', new Error('nope')]
    ]));

    const result = await verifyManifestsAcrossSources();
    expect(result.verdict).toBe('insufficient');
  });

  it('returns offline when all sources fail', async () => {
    mockFetchMap(new Map<string, Manifest | Error>([
      ['update-manifest.json', new Error('nope')],
      ['github.com/nostra-chat/nostra-chat/releases', new Error('nope')],
      ['ipfs.nostra.chat', new Error('nope')]
    ]));

    const result = await verifyManifestsAcrossSources();
    expect(result.verdict).toBe('offline');
    expect(result.manifest).toBeUndefined();
  });

  it('rejects manifests with unknown schemaVersion', async () => {
    const m = validManifest({schemaVersion: 99});
    mockFetchMap(new Map([
      ['update-manifest.json', m],
      ['github.com/nostra-chat/nostra-chat/releases', m],
      ['ipfs.nostra.chat', m]
    ]));

    const result = await verifyManifestsAcrossSources();
    // All 3 sources return valid JSON but schema is too new → treated as error
    expect(result.verdict).toBe('offline');
  });

  it('tolerates changelog differences across sources (whitespace etc.)', async () => {
    const base = validManifest();
    mockFetchMap(new Map([
      ['update-manifest.json', {...base, changelog: 'foo'}],
      ['github.com/nostra-chat/nostra-chat/releases', {...base, changelog: 'foo\n'}],
      ['ipfs.nostra.chat', {...base, changelog: 'bar'}]
    ]));

    const result = await verifyManifestsAcrossSources();
    expect(result.verdict).toBe('verified');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/tests/update/manifest-verifier.test.ts`

Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement `manifest-verifier.ts`**

Create `src/lib/update/manifest-verifier.ts`:

```ts
import type {Manifest, IntegrityResult, IntegrityVerdict} from '@lib/update/types';
import {updateTransport} from '@lib/update/update-transport';

interface ManifestSource {
  name: string;
  url: string;
}

export const MANIFEST_SOURCES: ManifestSource[] = [
  {name: 'cdn', url: '/update-manifest.json'},
  {name: 'github-release', url: 'https://github.com/nostra-chat/nostra-chat/releases/latest/download/update-manifest.json'},
  {name: 'ipfs', url: 'https://ipfs.nostra.chat/update-manifest.json'}
];

const SUPPORTED_SCHEMA = 1;

async function fetchOne(source: ManifestSource): Promise<Manifest> {
  const res = await updateTransport.fetch(source.url, {cache: 'no-store'});
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  const m = await res.json() as Manifest;
  if(m.schemaVersion !== SUPPORTED_SCHEMA) {
    throw new Error(`unsupported schemaVersion ${m.schemaVersion}`);
  }
  if(!m.version || !m.swUrl || !m.bundleHashes || !m.bundleHashes[m.swUrl]) {
    throw new Error('malformed manifest');
  }
  return m;
}

function keyFields(m: Manifest): string {
  // Fields that must agree across sources for a valid verdict.
  // Changelog/published intentionally excluded (whitespace/timing differ across mirrors).
  return JSON.stringify({
    version: m.version,
    gitSha: m.gitSha,
    swUrl: m.swUrl,
    swHash: m.bundleHashes[m.swUrl]
  });
}

export async function verifyManifestsAcrossSources(): Promise<IntegrityResult> {
  const results = await Promise.allSettled(MANIFEST_SOURCES.map(fetchOne));

  const sourcesBreakdown: IntegrityResult['sources'] = MANIFEST_SOURCES.map((src, i) => {
    const r = results[i];
    if(r.status === 'fulfilled') {
      const m = r.value;
      return {name: src.name, status: 'ok', version: m.version, gitSha: m.gitSha, swUrl: m.swUrl};
    }
    return {name: src.name, status: 'error', error: String(r.reason?.message || r.reason)};
  });

  const ok = results
    .map((r, i) => r.status === 'fulfilled' ? {source: MANIFEST_SOURCES[i].name, manifest: r.value} : null)
    .filter((x): x is {source: string; manifest: Manifest} => x !== null);

  const checkedAt = Date.now();

  if(ok.length === 0) {
    return {verdict: 'offline', sources: sourcesBreakdown, checkedAt};
  }

  if(ok.length === 1) {
    return {verdict: 'insufficient', sources: sourcesBreakdown, checkedAt};
  }

  // Group by key fields
  const byKey = new Map<string, Manifest>();
  for(const {manifest} of ok) {
    byKey.set(keyFields(manifest), manifest);
  }

  if(byKey.size > 1) {
    return {verdict: 'conflict', sources: sourcesBreakdown, checkedAt};
  }

  const agreed = ok[0].manifest;
  const verdict: IntegrityVerdict = ok.length >= 3 ? 'verified' : 'verified-partial';
  return {verdict, manifest: agreed, sources: sourcesBreakdown, checkedAt};
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `npx vitest run src/tests/update/manifest-verifier.test.ts`

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/update/manifest-verifier.ts src/tests/update/manifest-verifier.test.ts
git commit -m "feat(update): add cross-source manifest verifier with 5 verdicts"
```

## Task 3.5: Implement `update-bootstrap.ts` — Step 0 (first install)

**Files:**
- Create: `src/tests/update/update-bootstrap.test.ts`
- Create: `src/lib/update/update-bootstrap.ts`

- [ ] **Step 1: Write failing test for first install branch**

Create `src/tests/update/update-bootstrap.test.ts`:

```ts
import {describe, it, expect, beforeEach, vi, afterEach} from 'vitest';
import {updateBootstrap, __resetForTest, __getBootGateForTest} from '@lib/update/update-bootstrap';
import {BootGate} from '@lib/update/types';

function mockSW(activeScriptURL: string) {
  const mock = {
    ready: Promise.resolve({
      active: {scriptURL: activeScriptURL},
      waiting: null,
      update: vi.fn(async () => {})
    })
  };
  (global as any).navigator = {
    ...(global as any).navigator,
    serviceWorker: mock
  };
  return mock;
}

describe('updateBootstrap — Step 0 first install', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves baseline to localStorage on first boot', async () => {
    mockSW('https://app.example.com/sw-abc.js');

    await updateBootstrap({skipNetworkChecks: true});

    expect(localStorage.getItem('nostra.update.installedVersion')).toBe('test-version');
    expect(localStorage.getItem('nostra.update.installedSwUrl')).toBe('https://app.example.com/sw-abc.js');
    expect(localStorage.getItem('nostra.update.lastAcceptedVersion')).toBe('test-version');
  });

  it('does not throw on first install', async () => {
    mockSW('https://app.example.com/sw-abc.js');
    await expect(updateBootstrap({skipNetworkChecks: true})).resolves.not.toThrow();
  });
});
```

**Note:** The test uses `BUILD_VERSION = 'test-version'` via vite define replacement — we'll stub this in the next step.

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/tests/update/update-bootstrap.test.ts`

Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the bootstrap stub**

Create `src/lib/update/update-bootstrap.ts`:

```ts
import {BootGate, CompromiseAlertError} from '@lib/update/types';

// Stub for BUILD_VERSION that tests can override
let _buildVersion: string;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  _buildVersion = (require('@lib/update/build-version') as {BUILD_VERSION: string}).BUILD_VERSION;
} catch {
  _buildVersion = 'test-version';
}

const LS = {
  installedVersion: 'nostra.update.installedVersion',
  installedSwUrl: 'nostra.update.installedSwUrl',
  lastAcceptedVersion: 'nostra.update.lastAcceptedVersion',
  lastIntegrityCheck: 'nostra.update.lastIntegrityCheck',
  lastIntegrityResult: 'nostra.update.lastIntegrityResult',
  lastIntegrityDetails: 'nostra.update.lastIntegrityDetails',
  pendingFinalization: 'nostra.update.pendingFinalization',
  pendingManifest: 'nostra.update.pendingManifest'
};

let _bootGate: BootGate = BootGate.LocalChecksOnly;

export interface BootstrapOptions {
  skipNetworkChecks?: boolean;  // for tests and direct-boot scenarios
}

export async function updateBootstrap(opts: BootstrapOptions = {}): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const installedVersion = localStorage.getItem(LS.installedVersion);

  // Step 0: first install detection
  if(!installedVersion) {
    localStorage.setItem(LS.installedVersion, _buildVersion);
    localStorage.setItem(LS.installedSwUrl, reg.active!.scriptURL);
    localStorage.setItem(LS.lastAcceptedVersion, _buildVersion);
    _bootGate = BootGate.AllVerified;
    return;
  }

  // Step 1a: local URL consistency check
  const expectedUrl = localStorage.getItem(LS.installedSwUrl)!;
  if(reg.active!.scriptURL !== expectedUrl) {
    throw new CompromiseAlertError({type: 'sw-url-changed', expected: expectedUrl, got: reg.active!.scriptURL});
  }

  _bootGate = BootGate.LocalChecksOnly;

  if(opts.skipNetworkChecks) {
    _bootGate = BootGate.AllVerified;
    return;
  }

  // Step 1b + Step 2: run async, do not block boot indefinitely
  // (full implementation in subsequent tasks)
  _bootGate = BootGate.AllVerified;
}

// Test helpers
export function __resetForTest(): void {
  _bootGate = BootGate.LocalChecksOnly;
}

export function __getBootGateForTest(): BootGate {
  return _bootGate;
}

export function getBootGate(): BootGate {
  return _bootGate;
}

export function assertBootGateOpen(): void {
  if(_bootGate !== BootGate.AllVerified) {
    throw new Error('updateBootstrap not complete — network-dependent operations forbidden');
  }
}
```

- [ ] **Step 4: Run tests to pass**

Run: `npx vitest run src/tests/update/update-bootstrap.test.ts`

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/update/update-bootstrap.ts src/tests/update/update-bootstrap.test.ts
git commit -m "feat(update): add updateBootstrap Step 0 (first install detection)"
```

## Task 3.6: Add Step 1a URL-change detection test + wire-up

**Files:**
- Modify: `src/tests/update/update-bootstrap.test.ts`
- Modify: `src/lib/update/update-bootstrap.ts` (already implements it — add test)

- [ ] **Step 1: Add test for URL mismatch**

Append to `src/tests/update/update-bootstrap.test.ts`:

```ts
describe('updateBootstrap — Step 1a URL consistency', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetForTest();
    // Seed localStorage as if user already installed
    localStorage.setItem('nostra.update.installedVersion', 'test-version');
    localStorage.setItem('nostra.update.installedSwUrl', 'https://app.example.com/sw-abc.js');
    localStorage.setItem('nostra.update.lastAcceptedVersion', 'test-version');
  });

  it('throws CompromiseAlert when scriptURL differs from installedSwUrl', async () => {
    mockSW('https://app.example.com/sw-evil.js');  // different URL!

    await expect(updateBootstrap({skipNetworkChecks: true})).rejects.toThrow(/sw-url-changed/);
  });

  it('passes when scriptURL matches', async () => {
    mockSW('https://app.example.com/sw-abc.js');

    await expect(updateBootstrap({skipNetworkChecks: true})).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/tests/update/update-bootstrap.test.ts`

Expected: all 4 tests pass (2 from before + 2 new).

- [ ] **Step 3: Commit**

```bash
git add src/tests/update/update-bootstrap.test.ts
git commit -m "test(update): cover Step 1a URL consistency in updateBootstrap"
```

## Task 3.7: Implement Step 1b (`registration.update()` byte check)

**Files:**
- Modify: `src/lib/update/update-bootstrap.ts`
- Modify: `src/tests/update/update-bootstrap.test.ts`

- [ ] **Step 1: Add test for Step 1b**

Append to `src/tests/update/update-bootstrap.test.ts`:

```ts
describe('updateBootstrap — Step 1b registration.update byte check', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetForTest();
    localStorage.setItem('nostra.update.installedVersion', 'test-version');
    localStorage.setItem('nostra.update.installedSwUrl', 'https://app.example.com/sw-abc.js');
    localStorage.setItem('nostra.update.lastAcceptedVersion', 'test-version');
  });

  it('throws CompromiseAlert if waiting SW appears unexpectedly after update()', async () => {
    // Simulate: before update() call, no waiting. After, there's a new waiting.
    const newWaiting = {scriptURL: 'https://app.example.com/sw-abc.js'};
    const reg: any = {
      active: {scriptURL: 'https://app.example.com/sw-abc.js'},
      waiting: null,
      update: vi.fn(async function (this: any) { reg.waiting = newWaiting; })
    };
    (global as any).navigator = {...(global as any).navigator, serviceWorker: {ready: Promise.resolve(reg)}};

    await expect(updateBootstrap({skipManifestCheck: true})).rejects.toThrow(/sw-body-changed-at-same-url/);
  });

  it('does not throw if update() produces no waiting', async () => {
    const reg: any = {
      active: {scriptURL: 'https://app.example.com/sw-abc.js'},
      waiting: null,
      update: vi.fn(async () => {})
    };
    (global as any).navigator = {...(global as any).navigator, serviceWorker: {ready: Promise.resolve(reg)}};

    await expect(updateBootstrap({skipManifestCheck: true})).resolves.not.toThrow();
  });

  it('does not throw if pendingFinalization flag is set (expected waiting)', async () => {
    localStorage.setItem('nostra.update.pendingFinalization', '1');
    const newWaiting = {scriptURL: 'https://app.example.com/sw-abc.js'};
    const reg: any = {
      active: {scriptURL: 'https://app.example.com/sw-abc.js'},
      waiting: null,
      update: vi.fn(async function () { reg.waiting = newWaiting; })
    };
    (global as any).navigator = {...(global as any).navigator, serviceWorker: {ready: Promise.resolve(reg)}};

    await expect(updateBootstrap({skipManifestCheck: true})).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Update BootstrapOptions and implementation**

In `src/lib/update/update-bootstrap.ts`:

Replace `BootstrapOptions`:
```ts
export interface BootstrapOptions {
  skipNetworkChecks?: boolean;     // skips both Step 1b and Step 2
  skipManifestCheck?: boolean;     // skips Step 2 only (used by Step 1b tests)
}
```

Replace the body of `updateBootstrap` after Step 1a (but before final gate set):

```ts
  _bootGate = BootGate.LocalChecksOnly;

  if(opts.skipNetworkChecks) {
    _bootGate = BootGate.AllVerified;
    return;
  }

  // Step 1b: registration.update() — detects same-URL byte changes
  const expectingUpdate = localStorage.getItem(LS.pendingFinalization) === '1';
  const waitingBefore = reg.waiting;
  try {
    await reg.update();
  } catch(err) {
    // Network-level error — ignore, will retry next boot or on 'online' event.
    _bootGate = BootGate.AllVerified;
    return;
  }
  const waitingAfter = reg.waiting;

  if(waitingAfter && waitingAfter !== waitingBefore && !expectingUpdate) {
    throw new CompromiseAlertError({
      type: 'sw-body-changed-at-same-url',
      url: reg.active?.scriptURL,
      waitingUrl: waitingAfter.scriptURL
    });
  }

  if(opts.skipManifestCheck) {
    _bootGate = BootGate.AllVerified;
    return;
  }

  // Step 2: manifest cross-source verification — implemented in next task
  _bootGate = BootGate.AllVerified;
```

- [ ] **Step 3: Run all update tests**

Run: `npx vitest run src/tests/update/`

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/update/update-bootstrap.ts src/tests/update/update-bootstrap.test.ts
git commit -m "feat(update): add Step 1b registration.update() byte-comparison"
```

## Task 3.8: Integrate Step 2 (manifest verification) into bootstrap

**Files:**
- Modify: `src/lib/update/update-bootstrap.ts`
- Modify: `src/tests/update/update-bootstrap.test.ts`
- Modify: `src/lib/rootScope.ts`

- [ ] **Step 1: Add update events to BroadcastEvents**

In `src/lib/rootScope.ts`, find `export type BroadcastEvents = {` and add the following entries anywhere in the object:

```ts
  'update_available': import('@lib/update/types').Manifest,
  'update_state_changed': import('@lib/update/types').UpdateFlowState,
  'update_download_progress': {completed: number; total: number},
  'update_completed': string,
  'update_compromise_detected': import('@lib/update/types').CompromiseReason,
  'update_integrity_check_completed': import('@lib/update/types').IntegrityResult,
```

- [ ] **Step 2: Add test for Step 2**

Append to `src/tests/update/update-bootstrap.test.ts`:

```ts
import * as manifestVerifier from '@lib/update/manifest-verifier';
import rootScope from '@lib/rootScope';

describe('updateBootstrap — Step 2 manifest cross-source verification', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetForTest();
    localStorage.setItem('nostra.update.installedVersion', 'test-version');
    localStorage.setItem('nostra.update.installedSwUrl', 'https://app.example.com/sw-abc.js');
    localStorage.setItem('nostra.update.lastAcceptedVersion', 'test-version');
  });

  it('dispatches update_available when verdict verified and newer version', async () => {
    const reg: any = {
      active: {scriptURL: 'https://app.example.com/sw-abc.js'},
      waiting: null,
      update: vi.fn(async () => {})
    };
    (global as any).navigator = {...(global as any).navigator, serviceWorker: {ready: Promise.resolve(reg)}};

    vi.spyOn(manifestVerifier, 'verifyManifestsAcrossSources').mockResolvedValue({
      verdict: 'verified',
      manifest: {
        schemaVersion: 1, version: '99.0.0', gitSha: 'xxx', published: 'x',
        swUrl: './sw-new.js', bundleHashes: {'./sw-new.js': 'sha256-x'},
        changelog: 'note'
      } as any,
      sources: [], checkedAt: Date.now()
    });

    const spy = vi.spyOn(rootScope, 'dispatchEvent');
    await updateBootstrap();

    const call = spy.mock.calls.find(c => c[0] === 'update_available');
    expect(call).toBeDefined();
    expect(call![1].version).toBe('99.0.0');
  });

  it('writes integrity result to localStorage', async () => {
    const reg: any = {active: {scriptURL: 'https://app.example.com/sw-abc.js'}, waiting: null, update: vi.fn(async () => {})};
    (global as any).navigator = {...(global as any).navigator, serviceWorker: {ready: Promise.resolve(reg)}};

    vi.spyOn(manifestVerifier, 'verifyManifestsAcrossSources').mockResolvedValue({
      verdict: 'offline', sources: [], checkedAt: 12345
    });

    await updateBootstrap();

    expect(localStorage.getItem('nostra.update.lastIntegrityResult')).toBe('offline');
    expect(Number(localStorage.getItem('nostra.update.lastIntegrityCheck'))).toBe(12345);
  });
});
```

- [ ] **Step 3: Implement Step 2 in bootstrap**

In `src/lib/update/update-bootstrap.ts`, replace the final `// Step 2: manifest cross-source verification — implemented in next task` block with:

```ts
  // Step 2: manifest cross-source verification
  const {verifyManifestsAcrossSources} = await import('@lib/update/manifest-verifier');
  const result = await verifyManifestsAcrossSources();

  localStorage.setItem(LS.lastIntegrityCheck, String(result.checkedAt));
  localStorage.setItem(LS.lastIntegrityResult, result.verdict);
  localStorage.setItem(LS.lastIntegrityDetails, JSON.stringify(result.sources));

  _bootGate = BootGate.AllVerified;

  const rootScope = (await import('@lib/rootScope')).default;
  rootScope.dispatchEvent('update_integrity_check_completed', result);

  if(result.manifest && (result.verdict === 'verified' || result.verdict === 'verified-partial')) {
    const installedVer = localStorage.getItem(LS.installedVersion)!;
    if(semverGt(result.manifest.version, installedVer)) {
      rootScope.dispatchEvent('update_available', result.manifest);
    }
  }
}

// Simple semver comparison (a > b). Phase A only cares about "newer", not full semver.
function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for(let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if(x > y) return true;
    if(x < y) return false;
  }
  return false;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/tests/update/`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/update/update-bootstrap.ts src/tests/update/update-bootstrap.test.ts src/lib/rootScope.ts
git commit -m "feat(update): wire Step 2 manifest verification + dispatch update events"
```

## Task 3.9: Wire `updateBootstrap()` into `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add import + invocation at app entry**

At the top of the main async boot IIFE (or equivalent) in `src/index.ts`, before any `apiManagerProxy` or IDB init, add:

```ts
// Phase A controlled updates: integrity checks BEFORE any app state loads.
import {updateBootstrap} from '@lib/update/update-bootstrap';
import {CompromiseAlertError} from '@lib/update/types';

try {
  await updateBootstrap();
} catch(err) {
  if(err instanceof CompromiseAlertError) {
    const {mountCompromiseAlert} = await import('@lib/update/compromise-alert-mount');
    await mountCompromiseAlert(err.reason);
    return;  // abort boot
  }
  throw err;
}
```

The exact insertion point depends on current `src/index.ts` structure — place it as early as possible inside the top-level async boot. If the entry isn't already an async IIFE, wrap the early boot code.

- [ ] **Step 2: Create stub `compromise-alert-mount.ts`**

Create `src/lib/update/compromise-alert-mount.ts`:

```ts
import type {CompromiseReason} from '@lib/update/types';

export async function mountCompromiseAlert(reason: CompromiseReason): Promise<void> {
  // Temporary stub — full implementation in Ship 5 with Solid component.
  // For now, replaces body with a minimal textContent-based alert so
  // integrations can test the code path without the UI.
  document.body.innerHTML = '';
  const el = document.createElement('div');
  el.setAttribute('role', 'alertdialog');
  el.style.cssText = 'position:fixed;inset:0;background:#1a0808;color:#fff;padding:2rem;font-family:sans-serif;z-index:99999';
  el.innerHTML = `<h1 style="color:#ffcc00">⚠️ Possible compromise detected</h1>
    <p>The app has detected inconsistency in its distribution pipeline.</p>
    <pre style="background:#000;padding:1rem;overflow:auto">${JSON.stringify(reason, null, 2)}</pre>
    <button id="nostra-compromise-close" style="padding:0.5rem 1rem;margin-top:1rem">Close application</button>`;
  document.body.appendChild(el);
  document.getElementById('nostra-compromise-close')?.addEventListener('click', () => {
    try { window.close(); } catch {}
    window.location.href = 'about:blank';
  });
}
```

- [ ] **Step 3: Full build to verify**

Run: `pnpm build 2>&1 | tail -20`

Expected: build succeeds.

- [ ] **Step 4: Smoke test in dev server**

Run: `pnpm start`

Open `http://localhost:8080`. App should load normally. Check DevTools console for `[UPDATE]` log entries.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/lib/update/compromise-alert-mount.ts
git commit -m "feat(update): invoke updateBootstrap first in main thread boot"
```

## Task 3.10: Ship 3 milestone — PR

- [ ] **Step 1: PR**

```bash
git push origin <branch>
gh pr create --title "Phase A Ship 3 — bootstrap engine & integrity defenses" --body "Adds updateBootstrap with Steps 0/1a/1b/2 and stub CompromiseAlert. No UI yet; new-version detection dispatches rootScope event that nothing listens to. Ship 3 of 7."
```

---

# Ship 4 — Update flow (download, verify, register, finalize)

**Depends on:** Ship 3 merged.

**Scope:** Implements Phases 3-6 of the update flow. The `update_available` event is wired to a state machine that, on user consent (stubbed here as a direct call; UI in Ship 5), downloads bundle + hash-verifies + registers + handles finalization post-reload.

## Task 4.1: Add `promise-pool.ts` utility

**Files:**
- Create: `src/lib/update/promise-pool.ts`
- Create: `src/tests/update/promise-pool.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/tests/update/promise-pool.test.ts`:

```ts
import {describe, it, expect} from 'vitest';
import {PromisePool} from '@lib/update/promise-pool';

describe('PromisePool', () => {
  it('runs tasks with bounded concurrency', async () => {
    const pool = new PromisePool(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise(r => setTimeout(r, 10));
      concurrent--;
    };

    await Promise.all(Array.from({length: 10}, () => pool.run(task)));
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it('propagates rejection', async () => {
    const pool = new PromisePool(2);
    await expect(pool.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Implement**

Create `src/lib/update/promise-pool.ts`:

```ts
/**
 * Bounded-concurrency promise runner.
 * Used to throttle parallel asset downloads during update to avoid
 * saturating the CDN origin.
 */

export class PromisePool {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if(this.running >= this.limit) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      const next = this.queue.shift();
      if(next) next();
    }
  }
}
```

- [ ] **Step 3: Test passes**

Run: `npx vitest run src/tests/update/promise-pool.test.ts`

Expected: both tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/update/promise-pool.ts src/tests/update/promise-pool.test.ts
git commit -m "feat(update): add PromisePool for concurrency-bounded downloads"
```

## Task 4.2: Add `update-state-machine.ts`

**Files:**
- Create: `src/lib/update/update-state-machine.ts`
- Create: `src/tests/update/update-state-machine.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/tests/update/update-state-machine.test.ts`:

```ts
import {describe, it, expect, beforeEach} from 'vitest';
import {getFlowState, setFlowState, resetFlowState} from '@lib/update/update-state-machine';

describe('update-state-machine', () => {
  beforeEach(() => {
    localStorage.clear();
    resetFlowState();
  });

  it('starts idle', () => {
    expect(getFlowState()).toEqual({kind: 'idle'});
  });

  it('persists available state', () => {
    const manifest = {schemaVersion: 1, version: '0.8.0', gitSha: 'x', published: 'x', swUrl: './sw.js', bundleHashes: {'./sw.js': 'sha256-x'}, changelog: ''};
    setFlowState({kind: 'available', manifest} as any);
    // Simulate reload: reset module memory but keep localStorage
    resetFlowState();
    expect(getFlowState()).toEqual({kind: 'available', manifest});
  });

  it('does not persist transient states', () => {
    const manifest = {schemaVersion: 1, version: '0.8.0', gitSha: 'x', published: 'x', swUrl: './sw.js', bundleHashes: {'./sw.js': 'sha256-x'}, changelog: ''};
    setFlowState({kind: 'downloading', target: manifest, completed: 3, total: 10} as any);
    resetFlowState();
    // downloading is transient — localStorage should not have "downloading"
    const v = getFlowState();
    expect(v.kind).not.toBe('downloading');
  });

  it('persists finalizing and failed', () => {
    const manifest = {schemaVersion: 1, version: '0.8.0', gitSha: 'x', published: 'x', swUrl: './sw.js', bundleHashes: {'./sw.js': 'sha256-x'}, changelog: ''};
    setFlowState({kind: 'finalizing', target: manifest} as any);
    resetFlowState();
    expect(getFlowState().kind).toBe('finalizing');

    setFlowState({kind: 'failed', reason: {type: 'install-timeout'}} as any);
    resetFlowState();
    expect(getFlowState().kind).toBe('failed');
  });
});
```

- [ ] **Step 2: Implement**

Create `src/lib/update/update-state-machine.ts`:

```ts
import type {UpdateFlowState} from '@lib/update/types';

const LS_KEY = 'nostra.update.flowState';

let _state: UpdateFlowState = {kind: 'idle'};

function isPersisted(s: UpdateFlowState): boolean {
  return s.kind === 'available' || s.kind === 'finalizing' || s.kind === 'failed';
}

function loadFromStorage(): UpdateFlowState {
  const raw = localStorage.getItem(LS_KEY);
  if(!raw) return {kind: 'idle'};
  try {
    const parsed = JSON.parse(raw) as UpdateFlowState;
    if(isPersisted(parsed)) return parsed;
  } catch {}
  return {kind: 'idle'};
}

export function getFlowState(): UpdateFlowState {
  return _state;
}

export function setFlowState(next: UpdateFlowState): void {
  _state = next;
  if(isPersisted(next)) {
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  } else {
    localStorage.removeItem(LS_KEY);
  }
  // Fire event so UI can re-render
  import('@lib/rootScope').then(({default: rs}) => rs.dispatchEvent('update_state_changed', next));
}

export function resetFlowState(): void {
  _state = loadFromStorage();
}

// Initialize from storage on import
_state = loadFromStorage();
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/tests/update/update-state-machine.test.ts`

Expected: all 4 pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/update/update-state-machine.ts src/tests/update/update-state-machine.test.ts
git commit -m "feat(update): add update-state-machine with persistent and transient states"
```

## Task 4.3: Implement `update-flow.ts` — download & verify

**Files:**
- Create: `src/lib/update/update-flow.ts`
- Create: `src/tests/update/update-flow.test.ts`

- [ ] **Step 1: Write failing test for downloadAndVerify**

Create `src/tests/update/update-flow.test.ts`:

```ts
import {describe, it, expect, afterEach, beforeEach} from 'vitest';
import {downloadAndVerify} from '@lib/update/update-flow';
import {setUpdateTransport, resetUpdateTransport} from '@lib/update/update-transport';
import {UpdateFlowError} from '@lib/update/types';

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return 'sha256-' + Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

describe('downloadAndVerify', () => {
  afterEach(() => resetUpdateTransport());

  it('returns files when all hashes match', async () => {
    const payloadA = new TextEncoder().encode('file A content').buffer;
    const payloadB = new TextEncoder().encode('file B content').buffer;
    const hashA = await sha256Hex(payloadA);
    const hashB = await sha256Hex(payloadB);

    setUpdateTransport(async (url: any) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if(urlStr.includes('a.js')) return new Response(payloadA) as any;
      if(urlStr.includes('b.js')) return new Response(payloadB) as any;
      throw new Error('no mock');
    });

    const manifest = {
      schemaVersion: 1, version: '1.0', gitSha: 'x', published: 'x', swUrl: './a.js',
      bundleHashes: {'./a.js': hashA, './b.js': hashB}, changelog: ''
    };

    const files = await downloadAndVerify(manifest as any);
    expect(files.size).toBe(2);
    expect(files.get('./a.js')!.byteLength).toBe(payloadA.byteLength);
  });

  it('throws UpdateFlowError on hash mismatch', async () => {
    const payload = new TextEncoder().encode('content').buffer;
    setUpdateTransport(async () => new Response(payload) as any);

    const manifest = {
      schemaVersion: 1, version: '1.0', gitSha: 'x', published: 'x', swUrl: './a.js',
      bundleHashes: {'./a.js': 'sha256-wrong-hash'}, changelog: ''
    };

    await expect(downloadAndVerify(manifest as any)).rejects.toThrow(UpdateFlowError);
  });
});
```

- [ ] **Step 2: Implement `update-flow.ts`**

Create `src/lib/update/update-flow.ts`:

```ts
import type {Manifest} from '@lib/update/types';
import {UpdateFlowError} from '@lib/update/types';
import {updateTransport} from '@lib/update/update-transport';
import {PromisePool} from '@lib/update/promise-pool';
import {setFlowState} from '@lib/update/update-state-machine';

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return 'sha256-' + Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function downloadAndVerify(
  manifest: Manifest,
  opts: {signal?: AbortSignal; onProgress?: (done: number, total: number) => void} = {}
): Promise<Map<string, ArrayBuffer>> {
  const files = new Map<string, ArrayBuffer>();
  const entries = Object.entries(manifest.bundleHashes);
  const pool = new PromisePool(6);
  let completed = 0;

  await Promise.all(entries.map(([path, expectedHash]) => pool.run(async () => {
    const url = new URL(path, location.origin).href;
    const res = await updateTransport.fetch(url, {cache: 'no-store', signal: opts.signal});
    if(!res.ok) {
      throw new UpdateFlowError({type: 'network-error', err: `HTTP ${res.status} for ${path}`});
    }
    const buf = await res.arrayBuffer();
    const actualHash = await sha256Hex(buf);

    if(actualHash !== expectedHash) {
      throw new UpdateFlowError({type: 'hash-mismatch', path, expected: expectedHash, actual: actualHash});
    }

    files.set(path, buf);
    completed++;
    opts.onProgress?.(completed, entries.length);
  })));

  return files;
}

export async function startUpdate(manifest: Manifest, abortController?: AbortController): Promise<void> {
  try {
    setFlowState({kind: 'downloading', target: manifest, completed: 0, total: Object.keys(manifest.bundleHashes).length});

    await downloadAndVerify(manifest, {
      signal: abortController?.signal,
      onProgress: (completed, total) => {
        setFlowState({kind: 'downloading', target: manifest, completed, total});
      }
    });

    setFlowState({kind: 'verifying', target: manifest});

    // Register new SW (Task 4.4)
    await registerNewSw(manifest);

    // Activate (Task 4.4)
    await activateAndReload(manifest);
  } catch(err) {
    if(err instanceof UpdateFlowError) {
      setFlowState({kind: 'failed', reason: err.reason, target: manifest});
    } else {
      setFlowState({kind: 'failed', reason: {type: 'network-error', err: String(err)}, target: manifest});
    }
    throw err;
  }
}

async function registerNewSw(manifest: Manifest): Promise<ServiceWorkerRegistration> {
  localStorage.setItem('nostra.update.pendingFinalization', '1');
  localStorage.setItem('nostra.update.pendingManifest', JSON.stringify(manifest));

  const swUrl = new URL(manifest.swUrl, location.origin).href;
  setFlowState({kind: 'registering', target: manifest});

  let reg: ServiceWorkerRegistration;
  try {
    reg = await navigator.serviceWorker.register(swUrl, {
      type: 'module',
      scope: './',
      updateViaCache: 'all'
    });
  } catch(err) {
    localStorage.removeItem('nostra.update.pendingFinalization');
    localStorage.removeItem('nostra.update.pendingManifest');
    throw new UpdateFlowError({type: 'register-failed', err: String(err)});
  }

  const newSw = reg.installing || reg.waiting || reg.active;
  if(!newSw) throw new UpdateFlowError({type: 'register-failed', err: 'no worker after register'});

  // Wait for 'installed' state
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UpdateFlowError({type: 'install-timeout'})), 60000);
    const check = () => {
      if(newSw.state === 'installed') { clearTimeout(timer); resolve(); return; }
      if(newSw.state === 'redundant') { clearTimeout(timer); reject(new UpdateFlowError({type: 'install-redundant'})); return; }
    };
    check();
    newSw.addEventListener('statechange', check);
  });

  return reg;
}

async function activateAndReload(manifest: Manifest): Promise<void> {
  setFlowState({kind: 'finalizing', target: manifest});

  const reg = await navigator.serviceWorker.getRegistration();
  const waiting = reg?.waiting;
  if(!waiting) {
    // Already active? Force reload.
    window.location.reload();
    return;
  }

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  }, {once: true});

  waiting.postMessage({type: 'SKIP_WAITING'});

  // Fallback reload if controllerchange doesn't fire within 10s
  setTimeout(() => window.location.reload(), 10000);
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/tests/update/update-flow.test.ts`

Expected: 2/2 pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/update/update-flow.ts src/tests/update/update-flow.test.ts
git commit -m "feat(update): add downloadAndVerify, registerNewSw, activateAndReload"
```

## Task 4.4: Add post-reload finalization in updateBootstrap

**Files:**
- Modify: `src/lib/update/update-bootstrap.ts`
- Modify: `src/tests/update/update-bootstrap.test.ts`

- [ ] **Step 1: Add failing test**

Append to `src/tests/update/update-bootstrap.test.ts`:

```ts
describe('updateBootstrap — Phase 6 post-reload finalization', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetForTest();
    localStorage.setItem('nostra.update.installedVersion', '0.7.0');
    localStorage.setItem('nostra.update.installedSwUrl', 'https://app.example.com/sw-old.js');
    localStorage.setItem('nostra.update.lastAcceptedVersion', '0.7.0');
    localStorage.setItem('nostra.update.pendingFinalization', '1');
    localStorage.setItem('nostra.update.pendingManifest', JSON.stringify({
      schemaVersion: 1, version: '0.8.0', gitSha: 'xxx', published: 'x',
      swUrl: './sw-new.js', bundleHashes: {'./sw-new.js': 'sha256-y'},
      changelog: ''
    }));
  });

  it('promotes pending manifest to installed state when active SW matches', async () => {
    // Active SW matches the pending manifest's swUrl
    (global as any).navigator = {...(global as any).navigator, serviceWorker: {
      ready: Promise.resolve({
        active: {scriptURL: 'http://localhost:3000/sw-new.js'},
        waiting: null,
        update: vi.fn(async () => {})
      })
    }};

    // Stub location so `new URL(manifest.swUrl, location.origin)` matches scriptURL
    delete (global as any).location;
    (global as any).location = {origin: 'http://localhost:3000'};

    await updateBootstrap({skipManifestCheck: true});

    expect(localStorage.getItem('nostra.update.installedVersion')).toBe('0.8.0');
    expect(localStorage.getItem('nostra.update.installedSwUrl')).toBe('http://localhost:3000/sw-new.js');
    expect(localStorage.getItem('nostra.update.pendingFinalization')).toBeNull();
    expect(localStorage.getItem('nostra.update.pendingManifest')).toBeNull();
  });
});
```

- [ ] **Step 2: Implement finalization branch**

In `src/lib/update/update-bootstrap.ts`, at the top of `updateBootstrap` (after getting `reg`), before Step 0:

```ts
  // Phase 6: post-reload finalization
  const pendingFinalization = localStorage.getItem(LS.pendingFinalization) === '1';
  if(pendingFinalization) {
    const pendingManifestRaw = localStorage.getItem(LS.pendingManifest);
    if(pendingManifestRaw) {
      try {
        const pendingManifest = JSON.parse(pendingManifestRaw);
        const expectedSwUrl = new URL(pendingManifest.swUrl, location.origin).href;
        if(reg.active?.scriptURL === expectedSwUrl) {
          // Success: promote
          localStorage.setItem(LS.installedVersion, pendingManifest.version);
          localStorage.setItem(LS.installedSwUrl, expectedSwUrl);
          localStorage.setItem(LS.lastAcceptedVersion, pendingManifest.version);

          const rootScope = (await import('@lib/rootScope')).default;
          rootScope.dispatchEvent('update_completed', pendingManifest.version);
        }
      } catch {}
    }
    localStorage.removeItem(LS.pendingFinalization);
    localStorage.removeItem(LS.pendingManifest);
    // Skip Step 1b this boot — waiting is already gone by definition after active promotion
    opts = {...opts, skipManifestCheck: opts.skipManifestCheck};
  }
```

- [ ] **Step 3: Tests pass**

Run: `npx vitest run src/tests/update/update-bootstrap.test.ts`

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/update/update-bootstrap.ts src/tests/update/update-bootstrap.test.ts
git commit -m "feat(update): add Phase 6 post-reload finalization"
```

## Task 4.5: Add retry on `online` event

**Files:**
- Modify: `src/lib/update/update-bootstrap.ts`

- [ ] **Step 1: Export a public re-check function**

In `src/lib/update/update-bootstrap.ts`, add:

```ts
let _networkCheckInFlight = false;

export async function runNetworkChecks(opts: {force?: boolean} = {}): Promise<void> {
  if(_networkCheckInFlight) return;
  if(!opts.force && _bootGate === BootGate.AllVerified) return;

  _networkCheckInFlight = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    // Step 1b
    const expectingUpdate = localStorage.getItem(LS.pendingFinalization) === '1';
    const waitingBefore = reg.waiting;
    try { await reg.update(); } catch {}
    if(reg.waiting && reg.waiting !== waitingBefore && !expectingUpdate) {
      throw new CompromiseAlertError({
        type: 'sw-body-changed-at-same-url',
        url: reg.active?.scriptURL,
        waitingUrl: reg.waiting.scriptURL
      });
    }
    // Step 2
    const {verifyManifestsAcrossSources} = await import('@lib/update/manifest-verifier');
    const result = await verifyManifestsAcrossSources();
    localStorage.setItem(LS.lastIntegrityCheck, String(result.checkedAt));
    localStorage.setItem(LS.lastIntegrityResult, result.verdict);
    localStorage.setItem(LS.lastIntegrityDetails, JSON.stringify(result.sources));

    const rs = (await import('@lib/rootScope')).default;
    rs.dispatchEvent('update_integrity_check_completed', result);

    if(result.manifest && (result.verdict === 'verified' || result.verdict === 'verified-partial')) {
      const installedVer = localStorage.getItem(LS.installedVersion)!;
      if(semverGt(result.manifest.version, installedVer)) {
        rs.dispatchEvent('update_available', result.manifest);
      }
    }

    _bootGate = BootGate.AllVerified;
  } finally {
    _networkCheckInFlight = false;
  }
}

// Retry on reconnect
if(typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    runNetworkChecks().catch(err => {
      console.warn('[UPDATE] retry on online failed:', err);
    });
  });
}
```

Refactor the original inline Step 1b + Step 2 in `updateBootstrap` to delegate to this function (DRY).

- [ ] **Step 2: Run all update tests**

Run: `npx vitest run src/tests/update/`

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/update/update-bootstrap.ts
git commit -m "feat(update): retry network checks on 'online' + expose runNetworkChecks"
```

## Task 4.6: Ship 4 milestone — PR

- [ ] **Step 1: PR**

```bash
git push origin <branch>
gh pr create --title "Phase A Ship 4 — update flow engine" --body "Download, hash-verify, register, activate, finalize. No UI: startUpdate is callable but not hooked to anything user-facing yet. Ship 4 of 7."
```

---

# Ship 5 — UI components (popup, compromise alert, settings)

**Depends on:** Ship 4 merged.

## Task 5.1: Solid `<UpdatePopup>` component

**Files:**
- Create: `src/components/popups/updateAvailable/index.tsx`
- Create: `src/components/popups/updateAvailable/index.module.scss`

- [ ] **Step 1: Study existing popup patterns**

Run: `ls src/components/popups/ | head -20 && grep -l "PopupElement" src/components/popups/*.ts src/components/popups/*.tsx 2>/dev/null | head -3`

Identify a simple popup like `logOut.ts` for structural reference.

- [ ] **Step 2: Create SCSS**

Create `src/components/popups/updateAvailable/index.module.scss`:

```scss
.popup {
  max-width: 500px;
  width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px;
}

.title {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
}

.version {
  font-size: 14px;
  color: var(--secondary-text-color);
  margin: 0;
}

.integrityBadge {
  padding: 12px;
  border-radius: 8px;
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;

  &.verified {
    background: rgba(34, 197, 94, 0.1);
    color: rgb(22, 163, 74);
  }

  &.partial {
    background: rgba(234, 179, 8, 0.1);
    color: rgb(202, 138, 4);
  }

  &.conflict {
    background: rgba(239, 68, 68, 0.1);
    color: rgb(220, 38, 38);
  }
}

.divider {
  height: 1px;
  background: var(--border-color);
}

.changelogContainer {
  max-height: 50vh;
  overflow-y: auto;
  font-size: 14px;
  line-height: 1.5;

  h3, h4 {
    margin-top: 16px;
    margin-bottom: 8px;
    font-size: 15px;
  }

  ul {
    padding-left: 20px;
    margin: 4px 0;
  }
}

.progressBar {
  width: 100%;
  height: 4px;
  background: var(--border-color);
  border-radius: 2px;
  overflow: hidden;

  &::after {
    content: '';
    display: block;
    height: 100%;
    background: var(--primary-color);
    width: var(--progress, 0%);
    transition: width 0.3s ease;
  }
}

.buttons {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}
```

- [ ] **Step 3: Create the Solid component**

Create `src/components/popups/updateAvailable/index.tsx`:

```tsx
import {JSX, createSignal, createEffect, Show, onCleanup} from 'solid-js';
import PopupElement from '@components/popups';
import Button from '@components/button';
import rootScope from '@lib/rootScope';
import classNames from '@helpers/string/classNames';
import type {Manifest, IntegrityResult, UpdateFlowState} from '@lib/update/types';
import {getFlowState, setFlowState} from '@lib/update/update-state-machine';
import {startUpdate} from '@lib/update/update-flow';
import styles from './index.module.scss';

export default class UpdateAvailablePopup extends PopupElement {
  private manifest: Manifest;
  private integrity: IntegrityResult;
  private abortController: AbortController;

  constructor(manifest: Manifest, integrity: IntegrityResult) {
    super('popup-update-available', {
      closable: true,
      withConfirm: false,
      body: true
    });
    this.manifest = manifest;
    this.integrity = integrity;
    this.abortController = new AbortController();
    this.render();
  }

  private render(): void {
    const [state, setState] = createSignal<UpdateFlowState>(getFlowState());

    const listener = (next: UpdateFlowState) => setState(next);
    rootScope.addEventListener('update_state_changed', listener);
    onCleanup(() => rootScope.removeEventListener('update_state_changed', listener));

    const badgeClass = () => {
      if(this.integrity.verdict === 'verified') return styles.verified;
      if(this.integrity.verdict === 'verified-partial') return styles.partial;
      if(this.integrity.verdict === 'conflict') return styles.conflict;
      return '';
    };

    const badgeText = () => {
      const ok = this.integrity.sources.filter(s => s.status === 'ok');
      if(this.integrity.verdict === 'verified') {
        return `✅ Verificato da ${ok.length} sorgenti: ${ok.map(s => s.name).join(', ')}`;
      }
      if(this.integrity.verdict === 'verified-partial') {
        return `⚠️ Verificato parzialmente (${ok.length} di ${this.integrity.sources.length})`;
      }
      if(this.integrity.verdict === 'conflict') {
        return '❌ Incoerenza rilevata tra sorgenti — aggiornamento sconsigliato';
      }
      return '';
    };

    const content: JSX.Element = (
      <div class={styles.popup}>
        <h2 class={styles.title}>Aggiornamento disponibile</h2>
        <p class={styles.version}>versione {this.manifest.version}</p>

        <div class={classNames(styles.integrityBadge, badgeClass())}>
          {badgeText()}
        </div>

        <div class={styles.divider} />

        <h3>Novità in questa versione</h3>
        <div class={styles.changelogContainer} innerHTML={renderChangelog(this.manifest.changelog)} />

        <Show when={state().kind === 'downloading'}>
          <div class={styles.progressBar} style={{'--progress': `${progressPct(state())}%`}} />
          <p style={{'text-align': 'center'}}>Scaricamento {completedOf(state())}/{totalOf(state())} file…</p>
        </Show>

        <Show when={state().kind === 'idle' || state().kind === 'available'}>
          <div class={styles.buttons}>
            <Button text={'Più tardi' as any} onClick={() => this.hide()} />
            <Button
              text={'Aggiorna ora' as any}
              disabled={this.integrity.verdict === 'conflict'}
              onClick={() => {
                setFlowState({kind: 'downloading', target: this.manifest, completed: 0, total: Object.keys(this.manifest.bundleHashes).length});
                startUpdate(this.manifest, this.abortController).catch(err => {
                  console.error('[UPDATE] flow failed', err);
                });
              }}
            />
          </div>
        </Show>
      </div>
    );

    this.body.append(content as any);
  }

  protected onClose(): void {
    this.abortController.abort();
    super.onClose?.();
  }
}

function progressPct(s: UpdateFlowState): number {
  if(s.kind === 'downloading' && s.total > 0) return Math.round((s.completed / s.total) * 100);
  return 0;
}

function completedOf(s: UpdateFlowState): number {
  return s.kind === 'downloading' ? s.completed : 0;
}

function totalOf(s: UpdateFlowState): number {
  return s.kind === 'downloading' ? s.total : 0;
}

function renderChangelog(md: string): string {
  // Minimal safe renderer: headers, lists, inline code, bold/italic.
  // No clickable links (defense in depth against crafted changelog content).
  let html = md
    .replace(/[<>&]/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;'}[c]!))
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Wrap consecutive <li> in <ul>
  html = html.replace(/(<li>.*?<\/li>\n?)+/gs, m => `<ul>${m}</ul>`);
  return html;
}
```

- [ ] **Step 4: Wire the `update_available` event to the popup**

Create/modify `src/lib/update/update-popup-controller.ts`:

```ts
import rootScope from '@lib/rootScope';
import type {Manifest, IntegrityResult} from '@lib/update/types';

let _lastIntegrity: IntegrityResult | undefined;
let _shownForVersion: string | undefined;

rootScope.addEventListener('update_integrity_check_completed', (result: IntegrityResult) => {
  _lastIntegrity = result;
});

rootScope.addEventListener('update_available', async (manifest: Manifest) => {
  if(_shownForVersion === manifest.version) return;
  if(!_lastIntegrity) return;
  _shownForVersion = manifest.version;
  const {default: UpdateAvailablePopup} = await import('@components/popups/updateAvailable');
  new UpdateAvailablePopup(manifest, _lastIntegrity).show();
});
```

Import this from `src/index.ts` once during boot (after `updateBootstrap`):

```ts
await import('@lib/update/update-popup-controller');
```

- [ ] **Step 5: Build + smoke test**

Run: `pnpm build && pnpm start`

Open browser, verify no errors in console.

- [ ] **Step 6: Commit**

```bash
git add src/components/popups/updateAvailable/ src/lib/update/update-popup-controller.ts src/index.ts
git commit -m "feat(update): add UpdateAvailablePopup (Solid) + event-driven controller"
```

## Task 5.2: Solid `<CompromiseAlert>` component

**Files:**
- Create: `src/components/updateCompromise/index.tsx`
- Create: `src/components/updateCompromise/index.module.scss`
- Modify: `src/lib/update/compromise-alert-mount.ts`

- [ ] **Step 1: Create SCSS**

Create `src/components/updateCompromise/index.module.scss`:

```scss
.overlay {
  position: fixed;
  inset: 0;
  background: #1a0808;
  color: #fff;
  z-index: 99999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
}

.content {
  max-width: 640px;
  text-align: center;
}

.icon {
  font-size: 64px;
  color: #fbbf24;
}

.title {
  font-size: 24px;
  font-weight: 600;
  margin: 16px 0;
}

.body {
  font-size: 16px;
  line-height: 1.6;
  color: #fca5a5;
}

.details {
  margin-top: 24px;
  text-align: left;
}

.detailsToggle {
  cursor: pointer;
  color: #fcd34d;
  font-size: 14px;
  user-select: none;
}

.detailsContent {
  background: #000;
  padding: 16px;
  border-radius: 8px;
  margin-top: 8px;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  overflow-x: auto;
}

.todoList {
  text-align: left;
  font-size: 14px;
  margin-top: 24px;

  li {
    margin: 4px 0;
  }
}

.closeButton {
  margin-top: 32px;
  padding: 12px 32px;
  background: #dc2626;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  cursor: pointer;

  &:focus {
    outline: 2px solid #fbbf24;
    outline-offset: 2px;
  }
}
```

- [ ] **Step 2: Create the component**

Create `src/components/updateCompromise/index.tsx`:

```tsx
import {createSignal, Show} from 'solid-js';
import {render} from 'solid-js/web';
import type {CompromiseReason} from '@lib/update/types';
import styles from './index.module.scss';

export function CompromiseAlertView(props: {reason: CompromiseReason}) {
  const [expanded, setExpanded] = createSignal(false);

  const onClose = () => {
    try { window.close(); } catch {}
    window.location.href = 'about:blank';
  };

  return (
    <div class={styles.overlay} role="alertdialog" aria-live="assertive">
      <div class={styles.content}>
        <div class={styles.icon}>⚠️</div>
        <h1 class={styles.title}>Possibile compromissione rilevata</h1>
        <p class={styles.body}>
          Il sistema di distribuzione dell'app sta servendo contenuto diverso da quello previsto —
          possibile compromissione del CDN o interferenza sulla connessione.
          Per sicurezza, l'applicazione è stata bloccata e nessun dato è stato trasmesso.
        </p>

        <div class={styles.details}>
          <div class={styles.detailsToggle} onClick={() => setExpanded(!expanded())}>
            {expanded() ? '▾' : '▸'} Mostra dettagli tecnici
          </div>
          <Show when={expanded()}>
            <pre class={styles.detailsContent}>{JSON.stringify(props.reason, null, 2)}</pre>
          </Show>
        </div>

        <ul class={styles.todoList}>
          <li>Chiudi l'app e riprova più tardi</li>
          <li>Verifica la versione manualmente su github.com/nostra-chat/nostra-chat</li>
          <li>Non inserire password o dati sensibili</li>
        </ul>

        <button
          class={styles.closeButton}
          onClick={onClose}
          ref={el => setTimeout(() => el?.focus(), 0)}
        >
          Chiudi applicazione
        </button>
      </div>
    </div>
  );
}

export function mountCompromiseAlert(reason: CompromiseReason): void {
  document.body.innerHTML = '';
  render(() => <CompromiseAlertView reason={reason} />, document.body);
}
```

- [ ] **Step 3: Replace the stub**

Replace `src/lib/update/compromise-alert-mount.ts` content with:

```ts
import type {CompromiseReason} from '@lib/update/types';

export async function mountCompromiseAlert(reason: CompromiseReason): Promise<void> {
  const {mountCompromiseAlert: mount} = await import('@components/updateCompromise');
  mount(reason);
}
```

- [ ] **Step 4: Build**

Run: `pnpm build 2>&1 | tail -5`

Expected: success.

- [ ] **Step 5: Commit**

```bash
git add src/components/updateCompromise/ src/lib/update/compromise-alert-mount.ts
git commit -m "feat(update): add CompromiseAlert Solid component with full-screen mount"
```

## Task 5.3: Settings panel — `updateSettings.ts`

**Files:**
- Create: `src/components/sidebarLeft/tabs/updateSettings.ts`
- Modify: one parent settings tab to link here (e.g., `src/components/sidebarLeft/tabs/nostraSecurity.ts` or main settings)

- [ ] **Step 1: Create the settings tab**

Create `src/components/sidebarLeft/tabs/updateSettings.ts`:

```ts
/**
 * Settings → Privacy & Security → Updates
 * Shows current version, last integrity check, integrity status, and manual refresh.
 */

import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import Button from '@components/button';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {toast} from '@components/toast';
import type {IntegrityResult} from '@lib/update/types';
import {runNetworkChecks} from '@lib/update/update-bootstrap';

export default class AppUpdateSettingsTab extends SliderSuperTab {
  public init() {
    this.container.classList.add('update-settings');
    this.setTitle('App Updates' as any);

    const statusSection = new SettingSection({
      name: 'Status' as any
    });

    const versionRow = new Row({
      titleLangKey: 'Current version' as any,
      subtitle: localStorage.getItem('nostra.update.installedVersion') || 'unknown',
      clickable: false
    });

    const lastCheckRow = new Row({
      titleLangKey: 'Last check' as any,
      subtitle: this.formatLastCheck(),
      clickable: false
    });

    const statusRow = new Row({
      titleLangKey: 'Integrity status' as any,
      subtitle: this.formatIntegrity(),
      clickable: true
    });
    attachClickEvent(statusRow.container, () => {
      this.showIntegrityDetails();
    }, {listenerSetter: this.listenerSetter});

    statusSection.content.append(versionRow.container, lastCheckRow.container, statusRow.container);

    const actionSection = new SettingSection({});
    const checkBtn = Button('btn-primary btn-transparent primary', {
      text: 'Check for updates' as any
    });
    attachClickEvent(checkBtn, async () => {
      checkBtn.setAttribute('disabled', 'true');
      checkBtn.textContent = 'Checking…';
      try {
        await runNetworkChecks({force: true});
        toast('Check completed' as any);
        // Refresh displayed values
        lastCheckRow.subtitle.textContent = this.formatLastCheck();
        statusRow.subtitle.textContent = this.formatIntegrity();
      } catch(err) {
        toast(`Check failed: ${err}` as any);
      } finally {
        checkBtn.removeAttribute('disabled');
        checkBtn.textContent = 'Check for updates';
      }
    }, {listenerSetter: this.listenerSetter});
    actionSection.content.append(checkBtn);

    this.scrollable.append(statusSection.container, actionSection.container);
  }

  private formatLastCheck(): string {
    const raw = localStorage.getItem('nostra.update.lastIntegrityCheck');
    if(!raw) return 'never';
    const ms = Date.now() - Number(raw);
    const minutes = Math.floor(ms / 60000);
    if(minutes < 1) return 'just now';
    if(minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if(hours < 24) return `${hours} hours ago`;
    const days = Math.floor(hours / 24);
    if(days > 7) return `${days} days ago (outdated)`;
    return `${days} days ago`;
  }

  private formatIntegrity(): string {
    const verdict = localStorage.getItem('nostra.update.lastIntegrityResult');
    if(!verdict) return 'no data';
    const verdictLabels: Record<string, string> = {
      'verified': '✅ Verified (3 sources)',
      'verified-partial': '⚠️ Partially verified',
      'conflict': '❌ Inconsistency detected — tap for details',
      'insufficient': '⚠️ Unable to verify (limited network)',
      'offline': '· Offline'
    };
    return verdictLabels[verdict] || verdict;
  }

  private showIntegrityDetails(): void {
    const raw = localStorage.getItem('nostra.update.lastIntegrityDetails');
    if(!raw) return;
    try {
      const details = JSON.parse(raw);
      toast(`Sources: ${details.map((s: any) => `${s.name}=${s.status}`).join(' · ')}` as any);
    } catch {}
  }
}
```

- [ ] **Step 2: Link from parent tab**

In `src/components/sidebarLeft/tabs/nostraSecurity.ts` (or whichever settings tab hosts privacy options), add a Row:

```ts
import AppUpdateSettingsTab from './updateSettings';

// Inside the init() method, in an appropriate section:
const updatesRow = new Row({
  titleLangKey: 'App Updates' as any,
  icon: 'download',
  clickable: () => {
    this.slider.createTab(AppUpdateSettingsTab).open();
  }
});
protectionSection.content.append(updatesRow.container);
```

Adjust the section/row placement to match the existing UX of `nostraSecurity.ts`.

- [ ] **Step 3: Build and smoke-test**

Run: `pnpm build 2>&1 | tail -5`

Run: `pnpm start`

In the app, navigate to Settings → Nostra Security → App Updates. Click "Check for updates". Verify status text updates.

- [ ] **Step 4: Commit**

```bash
git add src/components/sidebarLeft/tabs/updateSettings.ts src/components/sidebarLeft/tabs/nostraSecurity.ts
git commit -m "feat(update): add Settings → App Updates panel with manual recheck"
```

## Task 5.4: Extend `nostra-cleanup.ts` to clear update state

**Files:**
- Modify: `src/lib/nostra/nostra-cleanup.ts`

- [ ] **Step 1: Add update keys to the cleanup list**

In `src/lib/nostra/nostra-cleanup.ts`, find the `NOSTRA_LS_KEYS` array and append:

```ts
  // Phase A controlled updates
  'nostra.update.installedVersion',
  'nostra.update.installedSwUrl',
  'nostra.update.lastAcceptedVersion',
  'nostra.update.lastIntegrityCheck',
  'nostra.update.lastIntegrityResult',
  'nostra.update.lastIntegrityDetails',
  'nostra.update.pendingFinalization',
  'nostra.update.pendingManifest',
  'nostra.update.flowState'
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/nostra/nostra-cleanup.ts
git commit -m "feat(cleanup): clear Phase A update state on logout / reset"
```

## Task 5.5: Privacy-mode transport wire-up

**Files:**
- Modify: `src/lib/update/update-bootstrap.ts`

- [ ] **Step 1: After PrivacyTransport settles, switch transport**

Add at the top of `updateBootstrap` (after getting `reg` but before Step 0 check):

```ts
  // Defer network ops in privacy mode until Tor bootstraps
  const privacyEnabled = await isPrivacyEnabledSafe();
  if(privacyEnabled) {
    const {waitUntilPrivacySettled, getWebtorFetch} = await import('@lib/update/update-privacy-integration');
    await waitUntilPrivacySettled();
    const torFetch = getWebtorFetch();
    if(torFetch) {
      const {setUpdateTransport} = await import('@lib/update/update-transport');
      setUpdateTransport(torFetch);
    }
  }
```

- [ ] **Step 2: Create the integration module**

Create `src/lib/update/update-privacy-integration.ts`:

```ts
/**
 * Bridge between Phase A update bootstrap and the existing PrivacyTransport / webtor-rs.
 * Keeps the main update module decoupled from Tor specifics.
 */

export async function isPrivacyEnabledSafe(): Promise<boolean> {
  try {
    const mod = await import('@lib/nostra/privacy-transport');
    const pt = (mod as any).default || (mod as any).privacyTransport;
    if(!pt) return false;
    return !!pt.isPrivacyEnabled?.();
  } catch {
    return false;
  }
}

export async function waitUntilPrivacySettled(): Promise<void> {
  try {
    const mod = await import('@lib/nostra/privacy-transport');
    const pt = (mod as any).default || (mod as any).privacyTransport;
    if(pt?.waitUntilSettled) {
      await pt.waitUntilSettled();
    }
  } catch {}
}

export function getWebtorFetch(): ((url: string, init?: RequestInit) => Promise<Response>) | null {
  try {
    const client = (window as any).__nostraTransport?.webtorClient;
    if(client?.fetch) {
      return (url, init) => client.fetch(url, init);
    }
  } catch {}
  return null;
}
```

Adjust the imports to match the actual exports of `privacy-transport.ts` (check its file structure before finalizing).

- [ ] **Step 3: Also add `isPrivacyEnabledSafe` import to update-bootstrap**

Top of `update-bootstrap.ts`:
```ts
import {isPrivacyEnabledSafe} from '@lib/update/update-privacy-integration';
```

- [ ] **Step 4: Build**

Run: `pnpm build 2>&1 | tail -5`

Expected: success.

- [ ] **Step 5: Commit**

```bash
git add src/lib/update/update-bootstrap.ts src/lib/update/update-privacy-integration.ts
git commit -m "feat(update): route network checks through Tor when privacy enabled"
```

## Task 5.6: Ship 5 milestone — PR

- [ ] **Step 1: PR**

```bash
git push origin <branch>
gh pr create --title "Phase A Ship 5 — UI components" --body "UpdatePopup, CompromiseAlert, Settings panel, privacy-mode transport. User-visible change: first update prompt appears on new versions. Ship 5 of 7."
```

---

# Ship 6 — E2E test suite

**Depends on:** Ship 5 merged.

## Task 6.1: Local manifest mock server helper

**Files:**
- Create: `src/tests/e2e/helpers/local-manifest-server.ts`

- [ ] **Step 1: Implement helper**

Create `src/tests/e2e/helpers/local-manifest-server.ts`:

```ts
// @ts-nocheck
import http from 'http';

export class LocalManifestServer {
  private servers: http.Server[] = [];
  private manifests: Map<number, string> = new Map();

  async start(ports: number[] = [7801, 7802, 7803]): Promise<void> {
    for(const port of ports) {
      const server = http.createServer((req, res) => {
        if(req.url?.endsWith('/update-manifest.json')) {
          const body = this.manifests.get(port) || '{}';
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
          });
          res.end(body);
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>(resolve => server.listen(port, resolve));
      this.servers.push(server);
    }
  }

  setManifest(port: number, manifest: any): void {
    this.manifests.set(port, JSON.stringify(manifest));
  }

  async stop(): Promise<void> {
    for(const s of this.servers) {
      await new Promise<void>(r => s.close(() => r()));
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tests/e2e/helpers/local-manifest-server.ts
git commit -m "test(e2e): add LocalManifestServer helper for multi-source mocks"
```

## Task 6.2: URL rewriter init script

**Files:**
- Create: `src/tests/e2e/helpers/rewrite-source-urls.ts`

- [ ] **Step 1: Implement**

Create `src/tests/e2e/helpers/rewrite-source-urls.ts`:

```ts
// @ts-nocheck
import type {BrowserContext} from 'playwright';

export async function rewriteManifestSources(
  context: BrowserContext,
  urls: {cdn: string; github: string; ipfs: string}
): Promise<void> {
  await context.addInitScript((u) => {
    (window as any).__NOSTRA_TEST_MANIFEST_SOURCES__ = [
      {name: 'cdn', url: u.cdn},
      {name: 'github-release', url: u.github},
      {name: 'ipfs', url: u.ipfs}
    ];
  }, urls);
}
```

Also extend `manifest-verifier.ts` to honor the test override:
```ts
// In src/lib/update/manifest-verifier.ts, replace the constant with:
function getSources(): ManifestSource[] {
  const override = (globalThis as any).__NOSTRA_TEST_MANIFEST_SOURCES__;
  if(Array.isArray(override)) return override;
  return MANIFEST_SOURCES;
}
// And use getSources() in place of MANIFEST_SOURCES in verifyManifestsAcrossSources.
```

- [ ] **Step 2: Commit**

```bash
git add src/tests/e2e/helpers/rewrite-source-urls.ts src/lib/update/manifest-verifier.ts
git commit -m "test(e2e): add manifest source override mechanism for tests"
```

## Task 6.3: Write `e2e-update-controlled.ts` scenarios

**Files:**
- Create: `src/tests/e2e/e2e-update-controlled.ts`

- [ ] **Step 1: Create the test file with all 8 scenarios**

Create `src/tests/e2e/e2e-update-controlled.ts`:

```ts
// @ts-nocheck
import {chromium} from 'playwright';
import {LocalManifestServer} from './helpers/local-manifest-server';
import {rewriteManifestSources} from './helpers/rewrite-source-urls';
import {launchOptions} from './helpers/launch-options';

const APP_URL = process.env.APP_URL || process.env.E2E_APP_URL || 'http://localhost:8080';

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n▶ ${name}`);
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch(err) {
    console.error(`✗ ${name}:`, err);
    process.exit(1);
  }
}

async function gotoApp(page: any) {
  await page.goto(APP_URL, {waitUntil: 'load'});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load'});
  await page.waitForTimeout(15000);
}

const validManifest = (over: any = {}) => ({
  schemaVersion: 1, version: '99.0.0', gitSha: 'abc', published: '2026-05-10T12:00:00Z',
  swUrl: './sw-xyz.js',
  bundleHashes: {'./sw-xyz.js': 'sha256-aaa', './index.html': 'sha256-bbb'},
  changelog: '### Test\n- hello', alternateSources: {},
  ...over
});

(async () => {
  const manifestServer = new LocalManifestServer();
  await manifestServer.start([7801, 7802, 7803]);

  try {
    await test('first-install: no popup on fresh browser', async () => {
      const browser = await chromium.launch(launchOptions());
      const ctx = await browser.newContext();
      await rewriteManifestSources(ctx, {
        cdn: 'http://localhost:7801/update-manifest.json',
        github: 'http://localhost:7802/update-manifest.json',
        ipfs: 'http://localhost:7803/update-manifest.json'
      });
      manifestServer.setManifest(7801, validManifest({version: '0.7.1'}));  // same as running
      manifestServer.setManifest(7802, validManifest({version: '0.7.1'}));
      manifestServer.setManifest(7803, validManifest({version: '0.7.1'}));

      const page = await ctx.newPage();
      await gotoApp(page);
      const hasPopup = await page.locator('.popup-update-available').count();
      if(hasPopup > 0) throw new Error('unexpected update popup on first install');
      await browser.close();
    });

    await test('upgrade-available: popup appears when all 3 sources agree on newer version', async () => {
      const browser = await chromium.launch(launchOptions());
      const ctx = await browser.newContext();
      await rewriteManifestSources(ctx, {
        cdn: 'http://localhost:7801/update-manifest.json',
        github: 'http://localhost:7802/update-manifest.json',
        ipfs: 'http://localhost:7803/update-manifest.json'
      });
      manifestServer.setManifest(7801, validManifest());
      manifestServer.setManifest(7802, validManifest());
      manifestServer.setManifest(7803, validManifest());

      const page = await ctx.newPage();
      await gotoApp(page);
      await page.waitForSelector('.popup-update-available', {timeout: 30000});
      const title = await page.textContent('.popup-update-available .title');
      if(!title?.includes('99.0.0')) throw new Error('wrong version in popup: ' + title);
      await browser.close();
    });

    await test('cross-source-conflict: Aggiorna button disabled', async () => {
      const browser = await chromium.launch(launchOptions());
      const ctx = await browser.newContext();
      await rewriteManifestSources(ctx, {
        cdn: 'http://localhost:7801/update-manifest.json',
        github: 'http://localhost:7802/update-manifest.json',
        ipfs: 'http://localhost:7803/update-manifest.json'
      });
      manifestServer.setManifest(7801, validManifest({version: '99.0.0', gitSha: 'good'}));
      manifestServer.setManifest(7802, validManifest({version: '99.0.0', gitSha: 'EVIL'}));
      manifestServer.setManifest(7803, validManifest({version: '99.0.0', gitSha: 'good'}));

      const page = await ctx.newPage();
      await gotoApp(page);
      await page.waitForSelector('.popup-update-available', {timeout: 30000});
      const updateBtn = await page.locator('.popup-update-available button:has-text("Aggiorna ora")').first();
      const isDisabled = await updateBtn.isDisabled();
      if(!isDisabled) throw new Error('expected Update button disabled in conflict');
      await browser.close();
    });

    await test('insufficient: no popup when only 1 source responds', async () => {
      const browser = await chromium.launch(launchOptions());
      const ctx = await browser.newContext();
      await rewriteManifestSources(ctx, {
        cdn: 'http://localhost:7801/update-manifest.json',
        github: 'http://localhost:7802/update-manifest.json',
        ipfs: 'http://localhost:7803/update-manifest.json'
      });
      manifestServer.setManifest(7801, validManifest());
      // 7802 and 7803 don't have manifests set — return {}
      manifestServer.setManifest(7802, {});
      manifestServer.setManifest(7803, {});

      const page = await ctx.newPage();
      await gotoApp(page);
      await page.waitForTimeout(10000);
      const hasPopup = await page.locator('.popup-update-available').count();
      if(hasPopup > 0) throw new Error('popup should be hidden on insufficient verdict');
      await browser.close();
    });
  } finally {
    await manifestServer.stop();
  }

  console.log('\nAll E2E update tests passed.');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add to run-all.sh**

In `src/tests/e2e/run-all.sh`, locate the `TESTS=()` array and add the new file path:

```bash
TESTS+=("src/tests/e2e/e2e-update-controlled.ts")
```

- [ ] **Step 3: Commit**

```bash
git add src/tests/e2e/e2e-update-controlled.ts src/tests/e2e/run-all.sh
git commit -m "test(e2e): add controlled-updates scenario suite (4 scenarios)"
```

## Task 6.4: Run E2E suite

- [ ] **Step 1: Start dev server in background**

Run: `pnpm start &`

- [ ] **Step 2: Run the new E2E tests**

Run: `pnpm test:e2e src/tests/e2e/e2e-update-controlled.ts`

Expected: all 4 tests pass.

- [ ] **Step 3: Run full E2E suite**

Run: `pnpm test:e2e:all`

Expected: no regressions on existing tests; update test passes.

## Task 6.5: Ship 6 milestone — PR

- [ ] **Step 1: PR**

```bash
git push origin <branch>
gh pr create --title "Phase A Ship 6 — E2E test suite" --body "4 scenario coverage: first-install, upgrade-available, conflict, insufficient. Helpers for multi-source mocking. Ship 6 of 7."
```

---

# Ship 7 — Release preparation

**Depends on:** Ship 6 merged.

## Task 7.1: Pre-release manual checklist doc

**Files:**
- Modify: `docs/RELEASE.md`

- [ ] **Step 1: Append Phase A section**

Add a new section to `docs/RELEASE.md`:

```markdown
## Phase A Controlled Updates — Pre-release checklist

Before cutting a release that touches the Phase A update flow, manually verify:

- [ ] First install in fresh Chrome → SW registered, no popup
- [ ] First install in fresh Firefox → idem
- [ ] First install in fresh Safari → idem (verify `updateViaCache` respected)
- [ ] Upgrade in Chrome (current → current+1 simulated via CI) → popup appears with changelog
- [ ] Upgrade in Safari → idem
- [ ] "Più tardi" → close tab → reopen → popup reappears
- [ ] Block nostra.chat in DevTools → verdict falls to verified-partial (2 sources)
- [ ] Go fully offline → no popup
- [ ] Settings → Aggiornamenti → "Verifica aggiornamenti" → spinner → result
- [ ] With Tor enabled → boot does not fetch anything before PrivacyTransport.settled
- [ ] With Tor enabled → after settled, check fires via webtor
- [ ] PWA installed (home screen) → flow identical
- [ ] Mid-download network drop → state recovers, no orphan register
- [ ] Settings dev mode (7-tap on Version) shows technical details
```

- [ ] **Step 2: Commit**

```bash
git add docs/RELEASE.md
git commit -m "docs(release): add Phase A pre-release manual checklist"
```

## Task 7.2: Draft release notes for first Phase A version

**Files:**
- Modify: `CHANGELOG.md` (via release-please PR workflow) — actually, release-please manages this automatically. Instead, ensure the **merge commits** have conventional-commit messages that produce good notes.

- [ ] **Step 1: Verify commit history has clear messages**

Run: `git log --oneline origin/main..HEAD`

Expected: commits have `feat(update):`, `feat(sw):`, `feat(build):` prefixes.

- [ ] **Step 2: Prepare a manual addendum for the release notes**

Create `docs/phase-a-release-note-draft.md`:

```markdown
# v0.8.0 — Phase A: controlled updates

Starting from this release, Nostra.chat no longer auto-updates silently.

**What changed**
- Updates now require your explicit consent via a prompt at app start.
- Each update is cross-verified against 3 independent distribution origins
  (nostra.chat, GitHub Releases, IPFS) before being offered to you.
- A new Settings → Privacy & Security → App Updates panel shows your
  current version, the last integrity check, and a manual recheck button.
- Service Worker no longer silently replaces itself in the background.

**What doesn't change**
- Your data is preserved as usual. No reset, no re-onboarding.
- Security model: see docs/TRUST-MINIMIZED-UPDATES.md for the threat model
  and what Phase A does (and doesn't) protect against.

**Known limits**
- The very first install of this version still happens silently (one-time).
  From this version onward, every subsequent update requires consent.
- Phase A defends against single-CDN compromise. Coordinated compromise
  of all 3 origins simultaneously is addressed by Phase C (maintainer
  cryptographic signatures) — planned for a future release.
```

This draft can be copy-pasted into the release-please PR description when the first Phase A version is cut.

- [ ] **Step 3: Commit**

```bash
git add docs/phase-a-release-note-draft.md
git commit -m "docs: draft Phase A release note template"
```

## Task 7.3: Documentation — update `TRUST-MINIMIZED-UPDATES.md` status

**Files:**
- Modify: `docs/TRUST-MINIMIZED-UPDATES.md`

- [ ] **Step 1: Update status header**

In `docs/TRUST-MINIMIZED-UPDATES.md`, change:
```
> **Status:** Design proposal — not implemented
```

to:
```
> **Status:** Phase A implemented (v0.8.0). Phases B/C/D not yet implemented.
```

And update the rollout plan table by adding a ✅ next to Phase A.

- [ ] **Step 2: Commit**

```bash
git add docs/TRUST-MINIMIZED-UPDATES.md
git commit -m "docs: mark Phase A as implemented in trust-minimized-updates doc"
```

## Task 7.4: Tag release

- [ ] **Step 1: Ensure lint + tsc clean**

Run: `pnpm lint && npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "@vendor" | head`

Expected: no new errors beyond the pre-existing `@vendor/emoji` / `@vendor/bezierEasing` ones per CLAUDE.md.

- [ ] **Step 2: Bump version**

Run: `pnpm version minor`

Expected: updates `package.json` to `0.8.0`, creates tag `v0.8.0`, pushes with `--follow-tags` (per `postversion` script).

- [ ] **Step 3: Monitor deploy**

Run: `gh run watch`

Expected: all jobs succeed. `dist/update-manifest.json` published to Cloudflare, IPFS, GitHub release.

- [ ] **Step 4: Verify manifest accessibility from all 3 origins**

```bash
curl -sI https://nostra.chat/update-manifest.json | head
curl -sI https://github.com/nostra-chat/nostra-chat/releases/latest/download/update-manifest.json | head
curl -sI https://ipfs.nostra.chat/update-manifest.json | head
```

Expected: 200 (or 302 → 200) from all three, `Cache-Control: no-cache`.

## Task 7.5: Final PR + merge to main

- [ ] **Step 1: Open Ship 7 PR**

```bash
git push origin <branch>
gh pr create --title "Phase A Ship 7 — release preparation" --body "Docs update, release notes draft, pre-release checklist. Ready to tag. Ship 7 of 7."
```

- [ ] **Step 2: After merge, monitor first Phase A release**

Watch real telemetry for `update_compromise_detected` events. If any arrive in the first 48h post-release, inspect — likely false positives from deploy sequencing that should be tightened operationally.

---

## Post-ship: SW retention mechanism (deferred)

The spec documented this as deferred to implementation. Before any follow-up release, decide:

**Option A** — Keep all historical `sw-*.js` files in `dist/` forever.
**Option B** — Archive old SWs to a secondary Cloudflare Pages project `legacy-sw-archive`, with 404 fallback routing.
**Option C** — Do nothing special; accept that stale clients 404 on `registration.update()` (graceful no-alarm behavior).

**Recommendation**: start with C (zero effort, acceptable UX). Move to A if 404 rate becomes problematic in telemetry. Avoid B unless scaling pressure demands it.

This decision is a post-Phase-A operational concern and does not block merging Ship 7.
