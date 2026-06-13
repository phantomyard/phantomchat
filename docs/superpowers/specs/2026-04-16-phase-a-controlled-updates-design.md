# Phase A — Controlled Updates (consent + cross-source integrity) — Design

Date: 2026-04-16
Status: Draft
Scope: PWA update distribution — user-controlled updates with cross-source integrity verification

## Goal

Replace the current silent auto-update model of Nostra.chat with a **user-controlled update flow** that:

1. **Never** downloads new application code without explicit user consent.
2. **Never** activates new application code without explicit user consent.
3. Verifies the authenticity of each update against **3 independent distribution origins** before presenting it to the user, defending against single-CDN compromise (Cloudflare, GitHub Pages, or IPFS gateway hijacked or coerced).
4. Detects and blocks post-install tampering on the currently-running Service Worker.
5. Presents the user with the release changelog (rendered inline) and an integrity verdict before asking for consent.

This is **Phase A** of the broader update trust model described in `docs/TRUST-MINIMIZED-UPDATES.md`. It is the UX and infrastructure layer on which future phases (reproducible builds, maintainer signatures, auditor threshold) will plug in.

## Non-goals

- **Cryptographic signature verification.** Phase A relies on cross-source consensus, not maintainer signatures. A coordinated compromise of all 3 sources (or a compromise of the source git repository + release pipeline) defeats this layer. Those attack classes are the scope of Phases B/C/D and are explicitly out of this phase.
- **First-install TOFU protection.** If the user's initial install is delivered by a compromised CDN, everything built on top is compromised. Partial mitigations (IPFS CID install, out-of-band hash verification) remain manual processes for power users; no automated protection here.
- **Source selection for asset downloads.** The user cannot choose which origin to download the bundle from in Phase A — all asset bytes come from the primary CDN (with hash verification against cross-source manifest). This is reserved for Phase A.1 as a non-security extension (privacy + resilience).
- **Rollback to a previous version.** Phase A keeps exactly one approved version in cache at a time: once the user accepts an update, the previous version's assets are deleted. Rationale: IndexedDB schema versions are monotonic; any schema bump in the new version makes the old code unable to open the DB (`VersionError`). Exposing a rollback UI would create a class of subtle data-loss bugs that's not worth the ergonomic win.
- **In-session update prompts.** Updates are only surfaced at cold start. Users keeping a tab open indefinitely are never interrupted mid-session.

## Threat model

### In scope (Phase A defends against)

| Threat | Defended by |
|---|---|
| Silent browser-driven auto-update of SW without user interaction | `updateViaCache: 'all'` + `Cache-Control: immutable` + no `skipWaiting` in install |
| CDN (Cloudflare) compromise serving modified bundle | Cross-source manifest verification; per-file hash check before register |
| CDN serving modified bytes at same SW URL (cache poisoning / URL pinning bypass) | `registration.update()` byte-comparison at boot (Defense 1b) |
| CDN serving modified `index.html` to redirect to malicious chunk URLs | SW intercepts navigation requests, serves cached `index.html` |
| User never approves update and keeps running trusted code | Design intent — user is in control |
| SW auto-activation when all tabs close (spec-default behavior) | No `skipWaiting` / `clients.claim`; user consent required via `SKIP_WAITING` postMessage |
| Compromised SW trying to lie about its own body hash | `registration.update()` bypasses SW fetch-handler by spec; browser does byte-comparison natively |

### Out of scope (Phase A does NOT defend against)

| Threat | Why out of scope | Addressed by |
|---|---|---|
| Coordinated compromise of all 3 distribution origins (Cloudflare + GitHub + IPFS) with consistent malicious manifest | Requires cryptographic signatures outside the bundle | Phase C (maintainer Nostr signatures) |
| Source repository / release pipeline compromise (malicious code at origin) | Verification is cross-source on the *published artifact*, not on the source | Phase C + Phase D (auditor threshold) |
| First-install TOFU: compromised initial download | No pre-existing trust baseline exists | Manual out-of-band verification; Phase B (reproducible builds) makes it feasible |
| SW script storage eviction coinciding with active CDN compromise (very rare) | `registration.update()` has no baseline to compare against after eviction | Phase C |
| Compromised main thread bundle (not SW) | Main bundle is served by SW from cache; attacker must also compromise SW to change main bundle | SW integrity defenses cover this indirectly |

## Architecture overview

```
┌──────────────────────────────────────────────────────────────┐
│ RELEASE PIPELINE (CI, per v* tag)                            │
│                                                              │
│   build → emit-update-manifest → publish to 3 sources:       │
│     1. Primary CDN: nostra.chat/update-manifest.json         │
│     2. GitHub release asset                                  │
│     3. IPFS (via ipfs.nostra.chat DNSLink → CID)             │
└──────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│ CLIENT (every boot)                                          │
│                                                              │
│  1. updateBootstrap() runs FIRST, before all app init        │
│  2. Step 1a: local SW URL consistency check                  │
│  3. Step 1b: registration.update() — detect silent tampering │
│  4. Step 2: fetch manifest from 3 sources, cross-verify      │
│  5. If new version + verified → popup prompt                 │
│  6. On consent: download+hash-verify bundle → register new   │
│     SW URL → SKIP_WAITING → reload                           │
└──────────────────────────────────────────────────────────────┘
```

### Core invariant

> The currently running Service Worker is the **only** authority for what bytes reach the browser. A new SW version never executes a single line of code until the user has explicitly consented, and the new bytes have been hash-verified against a manifest cross-verified from 3 independent origins.

## Publication pipeline

### Manifest schema

```json
{
  "schemaVersion": 1,
  "version": "0.8.0",
  "gitSha": "3c3dd8d8...",
  "published": "2026-05-10T12:00:00Z",
  "swUrl": "./sw-xyz789.js",
  "bundleHashes": {
    "./sw-xyz789.js": "sha256-...",
    "./index.html": "sha256-...",
    "./assets/app-abc.js": "sha256-...",
    "...": "..."
  },
  "changelog": "### Added\n- ...\n### Fixed\n- ...",
  "alternateSources": {}
}
```

Fields:
- `schemaVersion` (number): reserved for forward compatibility. Client rejects unknown schemas with a graceful message.
- `version` (string, semver): must match `package.json.version`.
- `gitSha` (string): commit SHA of the release (auditability).
- `published` (ISO 8601): for diagnostics and freshness heuristics.
- `swUrl` (string, relative path): content-hashed SW filename.
- `bundleHashes` (object): `relativePath → "sha256-<hex>"` for every critical file in `dist/`. Used to hash-verify each downloaded asset before registration.
- `changelog` (string): markdown-formatted section from `CHANGELOG.md` for this version.
- `alternateSources` (object): reserved for Phase A.1. Ignored in Phase A.

### Three independent origins

| Origin | URL | Operator |
|---|---|---|
| Primary CDN | `https://nostra.chat/update-manifest.json` | Cloudflare |
| GitHub Release asset | `https://github.com/nostra-chat/nostra-chat/releases/latest/download/update-manifest.json` | Microsoft/GitHub |
| IPFS | `https://ipfs.nostra.chat/update-manifest.json` | Protocol Labs (via Cloudflare Worker DNSLink proxy to `<cid>.ipfs.dweb.link`) |

### CI changes

**New script**: `src/scripts/build/emit-update-manifest.ts`
- Input: built `dist/` directory, `CHANGELOG.md`, `package.json`
- Output: `dist/update-manifest.json`
- Walks `dist/`, excludes `.map`, source maps, and `update-manifest.json` itself, computes SHA-256 of each file.
- Detects SW filename via regex `/^\.\/sw-[a-z0-9]+\.js$/`.
- Extracts changelog section for `package.json.version` via regex `/## \[${VERSION}\].*?\n([\s\S]*?)(?=\n## \[|\n*$)/`.
- Emits manifest with fields above.

**New script**: `src/scripts/build/validate-update-manifest.ts`
- Verifies required fields, version coherence, `swUrl` presence in `bundleHashes`, all dist files covered, gitSha matches `$GITHUB_SHA`.
- Runs in CI post-manifest-emit; failure aborts release.

**`package.json` scripts**:
```json
"build": "vite build && pnpm run emit-manifest && pnpm run validate-manifest",
"emit-manifest": "tsx src/scripts/build/emit-update-manifest.ts",
"validate-manifest": "tsx src/scripts/build/validate-update-manifest.ts dist/update-manifest.json"
```

**`.github/workflows/deploy.yml`**:
- Existing build step includes the manifest via the postbuild chain (no workflow change for Cloudflare/IPFS deploy — they pick it up from `dist/`).
- New step `upload-release-manifest`: uploads `dist/update-manifest.json` as a GitHub Release asset using `softprops/action-gh-release@v2`, tag name `${{ github.ref_name }}`.

### Operational constraints for maintainers

- **Never manually edit** `update-manifest.json`. CI is the only writer.
- **Never modify an already-published `sw-*.js` on the CDN**. Contract: same URL → same bytes forever. If a fix is needed, publish a new version.
- **SW retention**: old `sw-*.js` files SHOULD remain accessible for ≥ 6 months to avoid 404s during `registration.update()` checks on stale clients. Concrete retention mechanism (archive bucket, secondary Cloudflare Pages project, or keep-all-in-dist) is left to implementation; 404 failure mode is non-critical (silent, no false alarm).

### Cache headers

**`public/_headers` (Cloudflare Pages)**:
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

`max-age=31536000` (1 year) + `immutable` ensures the browser treats hashed SW and asset URLs as permanently valid within the TTL — no revalidation, no silent replacement visible to the browser during the cache window.

**`cloudflare-worker/`**: add a specific rule for `update-manifest.json` to bypass worker-level cache.

## Client-side: bootstrap and integrity defenses

### Module location

- `src/lib/update/update-bootstrap.ts` — top-level bootstrap orchestrator
- `src/lib/update/manifest-verifier.ts` — multi-source fetch + verdict logic
- `src/lib/update/update-state-machine.ts` — state transitions (idle/available/downloading/…)
- `src/lib/update/update-transport.ts` — thin wrapper selecting `fetch` vs `webtorClient.fetch` based on privacy mode

Imported and invoked in `src/index.ts` **before** any IndexedDB/localStorage structured reads or app manager init.

### Persistent state (localStorage)

```ts
interface UpdateState {
  'nostra.update.installedVersion': string;          // e.g. "0.7.0"
  'nostra.update.installedSwUrl': string;            // e.g. "/sw-abc123.js"
  'nostra.update.lastAcceptedVersion': string;
  'nostra.update.lastIntegrityCheck': number;        // ms timestamp
  'nostra.update.lastIntegrityResult': 'verified' | 'verified-partial' | 'conflict' | 'insufficient' | 'offline';
  'nostra.update.lastIntegrityDetails': string;      // JSON breakdown per source
  'nostra.update.pendingFinalization'?: '1';
  'nostra.update.pendingManifest'?: string;          // JSON
}
```

### Boot gate

```ts
enum BootGate {
  LocalChecksOnly,   // Step 1a passed; network checks not yet run
  NetworkPending,    // Network checks in progress
  AllVerified        // All integrity defenses completed successfully
}
```

Invariants:
- `LocalChecksOnly`: app may boot UI, storage, PrivacyTransport; **MUST NOT** interact with `registration.waiting` or invoke update popup.
- `AllVerified`: all operations permitted, including `<UpdatePopup>` rendering if a new version is detected.

Guard function `assertBootGateOpen()` imported by the update state machine to enforce ordering at runtime.

### Step 0 — First install detection

If `installedVersion` is absent in localStorage, this is the user's first boot with Phase A active:
- Save `installedVersion = BUILD_VERSION` (injected at build time into the main bundle)
- Save `installedSwUrl = registration.active.scriptURL` after `navigator.serviceWorker.ready`
- Save `lastAcceptedVersion = BUILD_VERSION`
- No integrity check (no baseline). Boot proceeds. TOFU is acknowledged.

### Step 1a — Local SW URL consistency (always at boot)

```ts
const reg = await navigator.serviceWorker.ready;
if(reg.active.scriptURL !== installedSwUrl) {
  throw new CompromiseAlert('sw-url-changed', {
    expected: installedSwUrl,
    got: reg.active.scriptURL
  });
}
```

Catches the case where a different SW URL has been registered without our consent. Synchronous, no network.

### Step 1b — `registration.update()` byte-check

Runs **after** `PrivacyTransport.waitUntilSettled()` in privacy mode, immediately in direct mode.

```ts
async function defenseB_swIntegrity(
  registration: ServiceWorkerRegistration
): Promise<void> {
  const expectingUpdate = localStorage.getItem('nostra.update.pendingFinalization') === '1';
  const waitingBefore = registration.waiting;

  // registration.update() bypasses the SW fetch handler by spec (SW §9).
  // Browser fetches the script URL directly and compares bytes against the
  // currently-installed SW. If different, a new SW enters 'installing' → 'installed'.
  await registration.update();

  const waitingAfter = registration.waiting;

  if(waitingAfter && waitingAfter !== waitingBefore && !expectingUpdate) {
    // Bytes at our registered SW URL have changed without us initiating an update.
    throw new CompromiseAlert('sw-body-changed-at-same-url', {
      url: registration.active?.scriptURL,
      waitingUrl: waitingAfter.scriptURL
    });
  }

  // Else: either waiting exists because we're finalizing a pending update (OK),
  // or no waiting SW (nothing changed, OK).
}
```

**Rationale**: `registration.update()` uses the browser's native byte-comparison. A compromised SW cannot intercept or lie about this check because SW update requests bypass the active SW's fetch handler (per SW spec §9).

### Step 2 — Manifest cross-source verification

```ts
const MANIFEST_SOURCES = [
  {name: 'cdn', url: '/update-manifest.json'},
  {name: 'github-release', url: 'https://github.com/nostra-chat/nostra-chat/releases/latest/download/update-manifest.json'},
  {name: 'ipfs', url: 'https://ipfs.nostra.chat/update-manifest.json'}
];

const fetched = await Promise.allSettled(
  MANIFEST_SOURCES.map(s => transport.fetchManifest(s.url).then(m => ({source: s.name, manifest: m})))
);

const successful = fetched
  .filter((r): r is PromiseFulfilledResult<{source: string, manifest: Manifest}> => r.status === 'fulfilled')
  .map(r => r.value);
```

**Verdict logic**:

| Condition | Verdict | UI effect |
|---|---|---|
| 3/3 successful AND all agree on `{version, gitSha, swUrl, bundleHashes.swUrl}` | `verified` | Popup allowed, "Verified by 3 sources" badge |
| 2/3 successful AND both agree; 1 offline | `verified-partial` | Popup allowed, "Verified by 2 of 3" warning badge |
| ≥2 successful but disagreement on any key field | `conflict` | Popup allowed in conflict mode, Update button disabled, details shown |
| 1/3 successful | `insufficient` | Popup hidden; retry on `online` event or next boot |
| 0/3 successful | `offline` | No popup, no warning |

Comparison scope is limited to a well-defined subset of fields (`version`, `gitSha`, `swUrl`, hash of SW file in `bundleHashes`). Other fields (`changelog`, `published`) may legitimately differ across mirrors due to whitespace/encoding and are not part of the agreement check.

**Staleness rule**: if one source returns an older `version` while others return a newer one, proceed with the newer version but log the stale source in diagnostics. Not a conflict.

### Step 3 — `assertBootGateOpen()` + dispatch

After Steps 1a, 1b, and 2 complete without raising `CompromiseAlert`:
- `bootGate = AllVerified`
- Write `lastIntegrityCheck`, `lastIntegrityResult`, `lastIntegrityDetails` to localStorage.
- If verdict is `verified` (or `verified-partial`) AND `manifest.version > installedVersion` → dispatch `update_available` event with the manifest.

### Transport selection

```ts
const transport = {
  fetch: isPrivacyEnabled()
    ? (url: string, init?: RequestInit) => webtorClient.fetch(url, init)
    : fetch.bind(globalThis)
};
```

In privacy mode, all update-related network operations (manifest fetch, bundle download) route through the existing Tor transport to avoid IP leakage to CDN/GitHub/IPFS gateways.

### Retry on reconnect

```ts
window.addEventListener('online', () => {
  if(bootGate !== BootGate.AllVerified) {
    runNetworkChecks();  // one-shot, self-guarded
  }
});
```

Covers the offline-at-boot case: app starts with `LocalChecksOnly`, network returns, check fires once.

## Update flow (state machine)

### States

```ts
type UpdateFlowState =
  | {kind: 'idle'}
  | {kind: 'available', manifest: Manifest}                          // persisted
  | {kind: 'downloading', target: Manifest, progress: number}        // transient
  | {kind: 'verifying', target: Manifest}                            // transient
  | {kind: 'registering', target: Manifest}                          // transient
  | {kind: 'finalizing', target: Manifest}                           // persisted
  | {kind: 'failed', reason: FailureReason, target?: Manifest};      // persisted
```

Only `idle`, `available`, `finalizing`, `failed` survive app restarts. Transient states reset to `available` if interrupted.

### Phase 1 — Detection

At end of bootstrap, if verdict is `verified` or `verified-partial` and `manifest.version > installedVersion`:
- Set state `available`, persist manifest.
- Dispatch `update_available`.

### Phase 2 — Consent

`<UpdatePopup>` listens on `update_available` and persistent state. User clicks:
- **"Aggiorna ora"** → transition to `downloading`.
- **"Più tardi"** / ESC / backdrop click → close popup, state remains `available`. Re-prompted at next cold start (no snooze).

### Phase 3 — Download & hash verification

```ts
async function downloadAndVerify(manifest: Manifest): Promise<Map<string, ArrayBuffer>> {
  const files = new Map<string, ArrayBuffer>();
  const entries = Object.entries(manifest.bundleHashes);
  const pool = new PromisePool(6);

  await Promise.all(entries.map(([path, expectedHash]) => pool.run(async () => {
    const url = new URL(path, location.origin).href;
    const buf = await transport.fetch(url, {cache: 'no-store', signal: abortController.signal})
      .then(r => r.arrayBuffer());
    const actualHash = 'sha256-' + await sha256Hex(buf);

    if(actualHash !== expectedHash) {
      throw new UpdateError('hash-mismatch', {path, expected: expectedHash, actual: actualHash});
    }

    files.set(path, buf);
    setUpdateProgress(files.size / entries.length);
  })));

  return files;
}
```

Rules:
- Per-file timeout: 30s.
- On any hash mismatch: abort entire update, state → `failed` with `hash-mismatch` reason. User-visible alert.
- On abort: files are not persisted to any cache; browser's HTTP cache may retain them (acceptable — bytes are already verified matching the legitimate manifest).
- Downloads run with concurrency 6 to balance throughput and origin load.

### Phase 4 — Register

```ts
localStorage.setItem('nostra.update.pendingFinalization', '1');
localStorage.setItem('nostra.update.pendingManifest', JSON.stringify(manifest));

const swUrl = new URL(manifest.swUrl, location.origin).href;

const reg = await navigator.serviceWorker.register(swUrl, {
  type: 'module',
  scope: './',
  updateViaCache: 'all'
});

const newSw = reg.installing || reg.waiting || reg.active;

await waitForState(newSw, 'installed', 60000); // throws on timeout or 'redundant'
```

Error handling:
- `install-timeout` (60s): state → `failed`.
- `install-redundant`: state → `failed`, user can retry.
- `register()` throw (CSP, scope mismatch, 404): state → `failed`, clean up `pendingFinalization`.

### Phase 5 — Activation + reload

```ts
const waitingSw = reg.waiting!;

navigator.serviceWorker.addEventListener('controllerchange', () => {
  window.location.reload();
}, {once: true});

waitingSw.postMessage({type: 'SKIP_WAITING'});

// Fallback: force reload if controllerchange doesn't fire within 10s
setTimeout(() => window.location.reload(), 10000);
```

In the new SW (`src/lib/serviceWorker/index.service.ts`):
```ts
ctx.addEventListener('message', (e) => {
  if(e.data?.type === 'SKIP_WAITING') {
    ctx.skipWaiting();
  }
});
```

`ctx.clients.claim()` remains **removed** — the reload handles transition, multi-tab coordination is avoided.

### Phase 6 — Post-reload finalization

On boot, if `pendingFinalization === '1'`:

```ts
const pendingManifest = JSON.parse(localStorage.getItem('nostra.update.pendingManifest')!);
const reg = await navigator.serviceWorker.ready;
const expectedSwUrl = new URL(pendingManifest.swUrl, location.origin).href;

if(reg.active.scriptURL === expectedSwUrl) {
  localStorage.setItem('nostra.update.installedVersion', pendingManifest.version);
  localStorage.setItem('nostra.update.installedSwUrl', expectedSwUrl);
  localStorage.setItem('nostra.update.lastAcceptedVersion', pendingManifest.version);
  rootScope.dispatchEvent('update_completed', pendingManifest.version);
} else {
  // Recover: runtime state is authoritative
  recoverInstalledStateFromRuntime();
}

localStorage.removeItem('nostra.update.pendingFinalization');
localStorage.removeItem('nostra.update.pendingManifest');

// Skip Defense 1b this boot: waiting SW absence is expected post-finalization
skipDefense1b = true;
```

### Mid-flow interruption recovery

| State at interruption | Next boot detection | Action |
|---|---|---|
| `available`, user didn't click | `available` in localStorage | Re-render popup; re-verify manifest (verdict may have changed) |
| Mid-`downloading` | No persisted state | Normal boot → Step 2 → if `manifest.version > installed`, re-show popup |
| Mid-`registering` (register returned, skipWaiting not sent) | `pendingFinalization=1`, `active.scriptURL` = old, `registration.waiting` = new SW | Branch "resume pending": send SKIP_WAITING directly, skip popup, Phase 5 |
| `finalizing`, reload not completed | `pendingFinalization=1`, `active.scriptURL` = new | Normal Phase 6 |

## Service Worker changes

File: `src/lib/serviceWorker/index.service.ts`

### Install event

```ts
ctx.addEventListener('install', (event) => {
  log('installing');
  event.waitUntil((async () => {
    const cache = await ctx.caches.open(CACHE_ASSETS_NAME);
    await cache.addAll([
      './',
      './index.html'
    ]);
    // NO skipWaiting() — new SW stays in waiting until user consent
  })());
});
```

### Activate event

```ts
ctx.addEventListener('activate', (event) => {
  log('activating', ctx);
  event.waitUntil((async () => {
    // Clear old asset cache — only reached when user has explicitly consented
    // to activation (or via migration from v0.6.x, which is the one-time silent
    // migration event)
    await ctx.caches.delete(CACHE_ASSETS_NAME);
    log('cleared assets cache');
    // NO clients.claim() — reload handled by main thread
  })());
});
```

### Fetch handler

Add navigation intercept to prevent a compromised CDN from swapping `index.html` independently of the SW script (the SW itself would serve stale cached HTML, blocking the attack):

```ts
const onFetch = (event: FetchEvent): void => {
  // Intercept navigation requests to serve cached index.html
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

  // Existing asset intercept (unchanged)
  if(
    import.meta.env.PROD &&
    !IS_SAFARI &&
    event.request.url.indexOf(location.origin + '/') === 0 &&
    event.request.url.match(/\.(js|css|jpe?g|json|wasm|png|mp3|svg|tgs|ico|woff2?|ttf|webmanifest?)(?:\?.*)?$/)
  ) {
    return event.respondWith(requestCache(event));
  }

  // ... rest of handler unchanged (stream, download, share, hls, etc.)
};
```

### Message handler

```ts
ctx.addEventListener('message', (e) => {
  if(e.data?.type === 'SKIP_WAITING') {
    ctx.skipWaiting();
  }
});
```

### SW registration in `apiManagerProxy.ts`

```ts
navigator.serviceWorker.register(ServiceWorkerURL, {
  type: 'module',
  scope: './',
  updateViaCache: 'all'  // added
});
```

## UI components

### `<UpdatePopup>`

**Location**: `src/components/popups/updateAvailable/index.tsx` + `index.module.scss`

Uses the existing `PopupElement` infrastructure for modal animation, focus trap, ESC handling, and scroll lock.

**States**: `idle` / `downloading` / `verifying` / `registering` / `error`.

**Layout (idle)**: title + version, integrity badge, scrollable changelog (markdown rendered with restricted HTML: `h3`/`h4`/`ul`/`li`/`code`/`strong`/`em`; external links disabled), buttons `Aggiorna ora` / `Più tardi`, help link `Cos'è questo?`.

**Integrity badge states**:
- `verified` (3/3): green ✅, lists source names
- `verified-partial` (2/3): yellow ⚠️, lists reachable sources, "Aggiorna" enabled with caveat
- `conflict`: red ❌, button disabled by default, advanced option `[Mostra opzioni avanzate]` reveals a disabled-then-confirm "Aggiorna comunque" path
- `offline`/`insufficient`: popup not rendered

**Interactions**:
- "Più tardi" / ESC / backdrop: closes popup, state `available` persists, re-shown next cold start.
- "Aggiorna ora": state transitions to `downloading`, UI updates with progress bar.
- Cancel during download: confirm dialog, abort fetches via `AbortController`, revert to `available`.

**Changelog rendering**: `marked` library (or a minimal regex-based renderer) with sanitized output. No clickable external links (defense in depth against malicious changelog content — attacker controlling manifest could inject crafted links).

### `<CompromiseAlert>`

**Location**: `src/components/updateCompromise/index.tsx` + `index.module.scss`

Not a popup — a full-screen replacement view. Mounted directly by `updateBootstrap()` before any other app component.

**Behavior**: replaces `document.body` content, aborts boot, provides technical details accordion, single button "Chiudi applicazione" invoking `window.close()` with `about:blank` fallback.

**Accessibility**: `role="alertdialog"`, `aria-live="assertive"`, focus forced on close button, ESC does nothing (deliberate).

**Persistence**: not persisted. Re-check runs at next app open. Transient issues (network glitch during `registration.update()`) self-resolve; genuine compromise persists across reopens.

### Settings panel

**Location**: new tab in `Impostazioni → Privacy & Sicurezza → Aggiornamenti`.

File: `src/components/sidebarLeft/tabs/privacySecurity/updates.ts` (style consistent with existing settings tabs).

**Rows**:
- Versione attuale: `installedVersion`
- Ultimo controllo: relative time since `lastIntegrityCheck`
- Stato integrità: badge reflecting `lastIntegrityResult`, clickable for breakdown
- Bottone "Verifica aggiornamenti" → fires `runNetworkChecks({force: true})`
- Link "Cos'è il controllo d'integrità?" → expandable explanation + external doc link

**Stale warning**: if `now - lastIntegrityCheck > 7 days`, append `(controllo obsoleto)` in red.

**Developer mode** (hidden behind 7-tap on "Versione attuale"): full SW URL, last integrity breakdown as JSON, buttons "Forza re-registrazione SW", "Dump stato update", "Reset stato update".

### i18n strings

~30 new keys in `src/lang.ts` covering all states: `Update.Available.*`, `Update.Integrity.*`, `Update.Downloading.*`, `Update.Error.*`, `Update.Compromise.*`, `Update.Settings.*`. Both Italian and English.

### Events

Typed in `BroadcastEvents` (rootScope.ts):

```ts
{
  update_available: Manifest;
  update_state_changed: UpdateFlowState;
  update_download_progress: {completed: number, total: number};
  update_completed: string;
  update_compromise_detected: CompromiseReason;
  update_integrity_check_completed: IntegrityResult;
}
```

## Migration strategy

### The one silent update

Phase A's initial release (v0.7.0 in this design's framing) requires **exactly one final silent update** to land:

1. Existing users run v0.6.x with the current SW that calls `skipWaiting()` in install.
2. Browser detects new `sw-*.js` in periodic check, starts installing v0.7.0.
3. v0.7.0's install handler does **not** call `skipWaiting()` (Phase A behavior).
4. v0.6.x remains active; v0.7.0 stays in `waiting`.
5. When all tabs close, browser auto-promotes v0.7.0 to active (spec default). **This is the final silent activation.**
6. Next user boot: `updateBootstrap()` finds no `installedVersion` in localStorage → first-install branch → saves baseline, boot proceeds, no popup.
7. From this point on, all future updates follow Phase A flow.

**Force-trigger**: v0.7.0 main bundle calls `registration.update()` once at boot to accelerate migration for browsers that defer their own periodic update checks.

**Release notes**: v0.7.0 changelog explicitly notes: "Starting from this version, app updates require your explicit consent."

### Edge cases

- **Offline users**: migrate whenever they come online, same flow. Skipping intermediate versions is harmless.
- **Tabs held open indefinitely**: v0.7.0 stays in waiting until all tabs close. User's choice; no forced eviction.
- **Reset Local Data**: `nostra-cleanup.ts` extended to remove `nostra.update.*` keys. Post-reset, treated as first install.
- **Logout**: same as reset — update state cleared.

## Security analysis

### Attack → defense map (post-fixes)

| Attack | Defense | Verdict |
|---|---|---|
| CDN (Cloudflare) compromised, serves malicious SW at new URL | Cross-source manifest verification; hash check pre-register | ✅ Blocked |
| CDN compromised, serves modified bytes at SAME registered SW URL | `registration.update()` byte-comparison at boot (Defense 1b) | ✅ Blocked |
| CDN compromised, modifies `index.html` to load malicious chunk URLs | SW intercepts navigation, serves cached `index.html` | ✅ Blocked |
| CDN serves malicious manifest pointing to malicious SW | Cross-source disagreement triggers `conflict` verdict | ✅ Blocked (requires ≥ 2 source compromise) |
| Browser auto-activates new SW silently (all tabs close) | No `skipWaiting`/`clients.claim`; browser activation still happens, but new SW serves nothing until user approval via `SKIP_WAITING` message | ✅ Blocked — wait state persists until explicit consent |
| Old SW retired from server (404) | Non-malicious scenario; `registration.update()` rejects silently, no false alarm | ✅ Handled gracefully |
| Compromised SW attempts to intercept its own integrity check | `registration.update()` bypasses SW fetch handler by spec | ✅ Blocked |

### Residual risks (documented, out of Phase A scope)

1. **Coordinated compromise of all 3 distribution origins** with consistent malicious manifest. Requires attacking Cloudflare + GitHub + Protocol Labs in sync, or compelling all three via independent legal processes. Addressed by Phase C (maintainer Nostr signatures).

2. **Source repository compromise** (malicious code at origin): cross-source verification on the published artifact doesn't help if the artifact itself is malicious-but-consistent. Addressed by Phase C + D (auditor threshold).

3. **First-install TOFU**: the very first installation has no trust baseline. Compromised initial download → everything built on top is compromised. Addressed by manual out-of-band verification (reproducible builds in Phase B enable this).

4. **SW storage eviction + active CDN compromise**: if the browser evicts the SW script body (rare — SW storage guarantees exceed HTTP cache) while the CDN serves malicious bytes, `registration.update()` has no baseline to compare and may install the malicious version. Very low probability; mitigated only by Phase C.

5. **Malicious changelog content**: if all 3 manifest sources agree but the changelog has attacker-crafted content, the inline renderer could be a vector. Mitigation: sanitized markdown rendering (allowlist of safe tags, no clickable external links).

## Testing strategy

### Unit (Vitest)

- `update-bootstrap.test.ts`: first install, URL consistency, finalization paths, Tor-mode deferral
- `manifest-verifier.test.ts`: all 5 verdicts (verified, verified-partial, conflict, insufficient, offline), stale source handling, unknown schema
- `update-state-machine.test.ts`: all state transitions, persistence across restarts
- `compromise-alert.test.ts`: rendering, focus trap, ESC non-dismissal

Target: ≥ 80% branch coverage on `src/lib/update/*`.

### Integration (Vitest + MSW or manual mock)

- Full upgrade flow (available → download → verify → register → finalize)
- Compromise detection via `registration.update()` mock
- Cross-source conflict
- Retry on `online` event
- Settings manual check

### E2E (Playwright)

New file: `src/tests/e2e/e2e-update-controlled.ts`, added to `TESTS` array in `src/tests/e2e/run-all.sh`.

Scenarios: first-install, upgrade-available (happy path), cross-source-conflict, compromise-same-url, Tor defer, offline retry, settings manual check, migration from v0.6.x.

Helper modules:
- `src/tests/e2e/helpers/local-manifest-server.ts`: serves configurable manifests on 3 localhost ports.
- `src/tests/e2e/helpers/rewrite-source-urls.ts`: injects localhost URLs via `addInitScript` before page load.

### Security scenario tests

- Malicious-SW-intercept-attempt (proves `registration.update()` bypass works as spec'd)
- Hash-verification-detects-tampering
- Partial-download-interruption recovery
- Pending-finalization-recovery from corrupted state

### Manual pre-release checklist

Document in `docs/RELEASE.md` or sibling: browser matrix (Chrome/Firefox/Safari), PWA-installed instance, Tor on/off, offline mode, settings interactions, dev mode.

## Rollout plan

| Phase | Content | Blocks on |
|---|---|---|
| **Ship 1 — Build tooling** | `emit-update-manifest.ts`, `validate-update-manifest.ts`, CI step, cache headers | None; isolated, testable |
| **Ship 2 — SW lifecycle changes** | Remove `skipWaiting`/`clients.claim`, add navigation intercept, SKIP_WAITING handler, `updateViaCache: 'all'` registration | Ship 1 merged |
| **Ship 3 — Bootstrap engine** | `update-bootstrap.ts`, Defenses 1a/1b/2, boot gate, state persistence | Ship 2 merged |
| **Ship 4 — Update state machine + transport** | Download/verify/register/finalize flow, retry logic | Ship 3 merged |
| **Ship 5 — UI components** | `<UpdatePopup>`, `<CompromiseAlert>`, Settings panel, i18n strings | Ship 4 merged |
| **Ship 6 — E2E test suite** | Playwright tests, helper infrastructure | Ship 5 merged |
| **Ship 7 — Release Phase A** | Tag v0.7.0, migration notice in release notes | Ship 6 green |

Each ship is an atomic PR. Feature flag: none required — the changes are backward-compatible and self-activating on first boot with no `installedVersion` in localStorage.

## Open questions / future work

- **Phase A.1**: user-selectable asset source (primary CDN / IPFS / GitHub) for privacy and resilience. Manifest schema already includes `alternateSources` field (ignored in A).
- **Phase B**: reproducible builds. Prerequisite for Phase C.
- **Phase C**: maintainer Nostr signatures on manifest. Integrates as a new required field in manifest schema (bumps `schemaVersion` to 2); Phase A clients reject schema 2 gracefully.
- **Phase D**: auditor threshold signatures. Social + technical prerequisite.
- **SW retention mechanism**: concrete implementation left to Ship 7. Options documented under *Publication pipeline → Operational constraints for maintainers*; decision deferred to implementation.
- **Telemetry**: optional Sentry-style reporting of `CompromiseAlert` renders would help distinguish real attacks from operational bugs. Opt-in, deferred.
- **Browser compatibility**: Safari's `updateViaCache` behavior should be empirically verified. Fallback logic needed if non-compliant.

## References

- `docs/TRUST-MINIMIZED-UPDATES.md` — parent design for full update trust model
- W3C Service Worker Spec §9 (Update algorithm): https://w3c.github.io/ServiceWorker/#update-algorithm
- Cache-Control `immutable`: RFC 8246
- Keep a Changelog: https://keepachangelog.com/
- release-please: https://github.com/googleapis/release-please

## Related files (entry points for implementation)

- `src/index.ts` — add `await updateBootstrap()` first
- `src/lib/update/*` — new module (does not yet exist)
- `src/lib/serviceWorker/index.service.ts` — SW lifecycle changes
- `src/lib/apiManagerProxy.ts:671` — `register()` options update
- `src/components/popups/updateAvailable/` — new component
- `src/components/updateCompromise/` — new component
- `src/components/sidebarLeft/tabs/privacySecurity/updates.ts` — new settings tab
- `src/scripts/build/emit-update-manifest.ts` — new build script
- `src/scripts/build/validate-update-manifest.ts` — new CI script
- `.github/workflows/deploy.yml` — add release-asset upload step
- `public/_headers` — cache headers
- `cloudflare-worker/` — manifest cache bypass rule
- `src/lang.ts` — i18n entries
- `src/lib/rootScope.ts` — `BroadcastEvents` additions
- `src/lib/nostra/nostra-cleanup.ts` — extend to clear update state on reset
