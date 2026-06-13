# Consent-Gated Update System — Design Spec

**Date**: 2026-04-21
**Status**: Design approved, pending implementation
**Supersedes**: Parts of `2026-04-16-phase-a-controlled-updates-design.md` (the integrity-verify subsystem stays; the update-activation flow is replaced)
**Phase**: Single phase (covers lock-down + consent flow end-to-end)

## 1. Problem

Today the app silently runs new code. When a new release is deployed, the browser fetches fresh `index.html` + chunks on the next reload (network-first path in the Service Worker). The update popup is advisory — it tells the user "an update was installed" after the fact. Declining has no effect on what's already running. Forensic trace:

1. `App.version` in the hamburger menu (`src/components/sidebarLeft/index.ts:1764`) displays the NEW version immediately after a reload, because `BUILD_VERSION` is the compile-time constant of the currently-running bundle.
2. `snap.installedVersion` in Settings → App Updates shows the OLD version, because it's only written to `localStorage['nostra.update.installedVersion']` after the integrity-pin bootstrap in `src/lib/update/update-bootstrap.ts:81-83`.
3. The two disagreeing values are the visible symptom of the invisible problem: **the gate fires after code execution, not before download**.

## 2. Threat Model

**Assumed attacker capabilities**:
- Persistent MITM between user and server (compromised CDN, network-level interception, misissued certificate within HSTS window, compromised reverse proxy).
- Ability to serve arbitrary bytes for any HTTPS request to `nostra.chat` (or its CDN origins).

**NOT assumed** (out of scope):
- Attacker with the release signing private key (that's the event we want to survive with the consent popup as secondary defense).
- Attacker with root on the user's device (game over at OS level).
- Attacker controlling all three manifest sources AND social channels (maintainer Twitter/Nostr/GitHub) simultaneously (stacked assumptions beyond practical defenses).

**Security properties we target**:
- **P1**: After first install, no new code from the network executes in the user's PWA without the user clicking "Accept" on an update popup.
- **P2**: A manifest with invalid Ed25519 signature never triggers a popup (silent ignore, logged).
- **P3**: A downloaded bundle with any chunk hash mismatch never enters the active cache.
- **P4**: A failed update leaves the previous version fully functional.
- **P5**: Rotating the signing key requires either cross-certification by the prior key OR manual recovery (documented out-of-band).
- **P6**: First install (TOFU) is protected by HTTPS + HSTS + implicit consent; a post-install info banner educates the user on the trust model.

## 3. Architecture

### 3.1 Trust model

```
Trust anchor: Ed25519 public key baked into the active SW (src/lib/update/signing/trusted-keys.ts)

Update authorized ⇔ (manifest signed by trusted key) ∧ (user accepts popup) ∧ (all chunk hashes verified)
```

No single factor is sufficient. The three gates are independent and all mandatory post-first-install.

### 3.2 Steady-state invariants

| # | Invariant | Enforced by |
|---|-----------|-------------|
| I1 | All app-shell fetches served cache-only; no network fallback | `src/lib/serviceWorker/cache.ts` rewrite |
| I2 | No automatic `reg.update()` calls | Removal of `src/lib/update/update-bootstrap.ts:150` |
| I3 | `SKIP_WAITING` sent only after signature + consent + chunk verify | New flow in `src/lib/update/update-flow.ts` |
| I4 | Atomic cache swap (all chunks verified → atomic rename; any failure → pending discarded) | `src/lib/serviceWorker/shell-cache.ts` |
| I5 | Runtime data (Nostr WSS, Blossom, avatars) passes through network | Unchanged behavior; not app-shell |
| I6 | Precache at install covers every asset emitted by `pnpm build` | `src/scripts/build-precache-manifest.mjs` |

### 3.3 Trust chain over time

```
[First install — TOFU window]
  HTTPS + HSTS + implicit consent ("I typed nostra.chat")
    → SW v1 installs, bakes pubkey P1
    → post-install info banner shows fingerprint(P1)
      ↓
[Update N — manifest signed with P1]
    SW v1 verifies signature → user clicks Accept → swap → SW v2 active
      ↓
[Update M — may include key rotation]
    Manifest signed with P_old; contains rotation = { newPubkey: P_new, crossCertSig: sign(P_new, P_old_priv) }
    SW verifies both → popup highlights key change → user consents → swap
    New SW bakes P_new as trust anchor
```

Compromise of `P_old` does not mean immediate game-over: users still need to click Accept; the maintainer has a time window to publish a compromise notice out-of-band (Twitter/Nostr/GitHub); aware users can decline.

## 4. Components

### 4.1 New files

| Path | Role |
|---|---|
| `src/lib/serviceWorker/shell-cache.ts` | Helper for `shell-v<N>` and `shell-v<N>-pending` caches; atomic swap; orphan GC |
| `src/lib/serviceWorker/signed-update-sw.ts` | SW-side handler for `UPDATE_APPROVED` message: download chunks, verify hashes, swap |
| `src/lib/update/signing/verify.ts` | Ed25519 signature verify wrapper around `@noble/ed25519` |
| `src/lib/update/signing/trusted-keys.ts` | Baked pubkey constant + cross-cert verification logic |
| `src/lib/update/probe.ts` | Multi-source probe of signed manifest; consensus logic |
| `src/lib/update/update-state.ts` | State machine: `idle → checking → update-available → accepted → downloading → verifying → swapping → done` (+ `failed` state) |
| `src/components/popups/updateConsent/index.tsx` | New consent popup (version + commit + fingerprint + release notes) |
| `src/components/banners/stalenessBanner.ts` | Persistent banner after 7 consecutive daily declines |
| `src/components/banners/firstInstallInfo.ts` | One-time post-first-install info (fingerprint + trust model) |
| `src/scripts/build-precache-manifest.mjs` | Post-build: generate `dist/update-manifest.json` with all hashes |
| `src/scripts/sign-manifest.mjs` | CI: sign `update-manifest.json` with `UPDATE_SIGNING_KEY` env secret |
| `docs/UPDATE-SYSTEM.md` | Operational docs (release signing, key rotation, recovery) |

### 4.2 Modified files

| Path | Change |
|---|---|
| `src/lib/serviceWorker/cache.ts` | `requestCache` → cache-only for app-shell; no network fallback; no backfill |
| `src/lib/serviceWorker/index.service.ts` | Install event precaches full asset list from precache manifest; fetch handler intercepts navigation requests (`/`, `/index.html`); new `message` handler for `UPDATE_APPROVED` |
| `src/lib/update/update-bootstrap.ts` | Remove `reg.update()` call (line 150); keep drift check as diagnostic |
| `src/lib/update/manifest-verifier.ts` | Signature verify becomes first step; consensus multi-source becomes secondary layer |
| `src/lib/update/update-flow.ts` | Accept path: postMessage to SW, no main-thread download |
| `src/lib/update/update-popup-controller.ts` | Swap old popup for `updateConsent`; wire staleness banner |
| `src/components/popups/updateAvailable/index.tsx` | Replaced by `updateConsent` component (remove old file) |
| `src/lib/apiManagerProxy.ts:681` | Verify `updateViaCache: 'all'` stays |
| `src/index.ts:405-420` | `updateBootstrap` stays but becomes probe+diagnostic only, no gate |
| `vite.config.ts` | Integrate `build-precache-manifest.mjs` as post-build hook |
| `.github/workflows/deploy.yml` | Sign step post-build using `UPDATE_SIGNING_KEY` secret |
| `docs/ARCHITECTURE.md` | Update "Phase A update system" section to reference this new design |

### 4.3 New dependencies

- `@noble/ed25519` (~15 kB, zero deps, audit-friendly).
- `@noble/hashes` (likely already transitively present via `@noble/secp256k1` used for Nostr) — synchronous SHA-256 for in-SW verify.

### 4.4 Removed / deprecated

- `update-baseline.ts`: kept as diagnostic only (Settings → App Updates display). No longer a gate.
- Current `MANIFEST_SOURCES` and consensus logic: **kept** but layered under signature verification.

## 5. Manifest schema

```json
{
  "version": "0.13.0",
  "gitSha": "abc1234",
  "releaseTimestamp": "2026-04-21T14:00:00Z",
  "swUrl": "/sw.js",
  "signingKeyFingerprint": "ed25519:aBcDeF123...",
  "securityRelease": false,
  "securityRollback": false,
  "bundleHashes": {
    "index.html": "sha256-...",
    "assets/index-abc123.js": "sha256-...",
    "assets/styles-def456.css": "sha256-...",
    "sw.js": "sha256-..."
  },
  "rotation": null
}
```

Rotation object (when present):
```json
"rotation": {
  "newPubkey": "base64(32 bytes)",
  "newFingerprint": "ed25519:xYz...",
  "crossCertSig": "base64(sign(newPubkey, oldPrivKey))"
}
```

Signature stored separately in `update-manifest.json.sig` (48 bytes Ed25519, base64-encoded). Manifest itself is JSON — signature covers `sha256(canonicalize(manifest))`.

## 6. Data flows

### 6.1 First install (TOFU)

```
1. User → https://nostra.chat (no SW)
2. Browser GET / → server returns index.html + chunks (HTTPS+HSTS protected)
3. App loads, registers SW with { updateViaCache: 'all' }
4. SW install event:
   a. Fetch /update-manifest.json + .sig
   b. Verify signature with baked pubkey
   c. Verify consensus across 3 sources (CDN / GitHub Pages / IPFS)
   d. For each asset in bundleHashes: fetch → SHA-256 → compare → cache.put() in 'shell-v<VERSION>'
   e. Any mismatch → abort install → SW not activated
   f. On success: IDB { active-version: VERSION, installed-pubkey-fingerprint: P1 }
5. SW activate → clients.claim()
6. Main thread shows firstInstallInfo banner with fingerprint(P1)
7. Thereafter: all shell fetches served cache-only
```

### 6.2 Probe (hybrid cadence)

```
Trigger: app boot (throttled, ≥12h since last probe) OR user clicks "Check now"

1. probe.ts:
   a. Fetch manifest from primary source (network, no-cache)
   b. Verify Ed25519 signature with trusted-keys.ts
      invalid? → console.warn, exit silently
   c. Fetch from 2 secondary sources, verify each signature
   d. Consensus: ≥2/3 agree on { version, swHash, bundleHashes } → accepted manifest
2. Compare manifest.version with active-version (IDB)
   equal? → exit, no-op
   different AND > active? → update-state → 'update-available'
3. UI reflects 'update-available':
   a. Red dot on hamburger menu
   b. Settings → App Updates entry highlighted
   c. NO modal popup (respects hybrid UX)
4. User clicks dot / Settings entry → trigger flow 6.3
```

### 6.3 Accept

```
1. User clicks "Update now" → updateConsent popup shown:
   - Current version → new version
   - Git commit with link
   - Release date
   - Signing key fingerprint (with ✓ if matches installed)
   - [View on GitHub] [Release notes] [Accept] [Ignore]
2. User → Accept
3. Main thread → postMessage(SW, 'UPDATE_APPROVED', { manifest, signature, sources })
4. SW re-verifies signature (defense in depth), re-verifies consensus
5. SW: caches.open('shell-v<NEW>-pending')
6. For each asset in bundleHashes:
   a. fetch(asset, { cache: 'no-cache' })
   b. Compute SHA-256(response.clone())
   c. Compare with bundleHashes[asset]
      mismatch? → abort (flow 6.5)
   d. cache.put() in pending
   e. Progress → postMessage main → popup shows X/N
7. All chunks OK → state → 'verified'
8. SW atomic swap:
   a. IDB transaction:
      - active-version: NEW
      - previous-version: OLD
      - rotation-log: append { from: OLD, to: NEW, timestamp, keyFingerprint }
      - if rotation: installed-pubkey-fingerprint: P_new
   b. Rename cache: pending → active (via copy + delete old; browsers don't support true rename)
   c. caches.delete('shell-v<OLD>') after tick
9. SW postMessage main 'UPDATE_APPLIED'
10. Main: popup "Update applied, reload now" → user triggers location.reload()
11. Reload: SW serves from new 'shell-v<NEW>' cache
```

### 6.4 Decline

```
1. User → Ignore
2. Main: localStorage
   - nostra.update.snoozedVersion = VERSION
   - nostra.update.snoozedUntil = now + 24h
   - nostra.update.declineCount[VERSION]++
3. Popup closed. Red dot stays visible.
4. Nothing downloaded. Cache intact.
5. After 24h: probe re-evaluates; same VERSION → popup reappears next trigger.
6. After declineCount[VERSION] ≥ 7:
   stalenessBanner activates → persistent, non-dismissable top banner:
   "You're on a stale version (v0.12.0, 7 days old). Security patches available in v0.13.0. [Update] [Dismiss for 24h]"
```

### 6.5 Failure recovery

| Scenario | Response |
|---|---|
| Manifest signature invalid | Probe fails silently; console log; no popup |
| Consensus mismatched (3/3 disagree) | Abort probe; log discrepancy; no popup |
| Consensus 2/3 agree | Use majority; log minority; proceed |
| Chunk SHA-256 mismatch during download | Abort; `caches.delete(pending)`; popup: "Update cancelled — integrity check failed. Retry or contact maintainer." |
| Network drop mid-download | Same as mismatch — atomic all-or-nothing |
| Quota exceeded | Abort; dedicated UI: "Insufficient storage. Free at least N MB and retry." |
| Tab closed mid-download | SW continues; if active-version ≠ pending-version at next boot → orphan GC cleans pending |
| IDB swap transaction fails | Rollback atomic; active cache untouched; log; popup: "Apply failed, retry." |
| Shell asset cache-miss at runtime | 503 with embedded recovery HTML + [Reinstall] button |

### 6.6 Key rotation

```
1. Maintainer generates new keypair off-band (P2_pub, P2_priv)
2. Prepares manifest v_next:
   - bundleHashes for new release
   - rotation: { newPubkey: P2_pub, crossCertSig: sign(P2_pub, P1_priv) }
   - Signs whole manifest with P1_priv
3. Release → users receive via normal probe
4. SW v1:
   a. Verifies manifest signature with P1_pub → OK
   b. Detects rotation field → verifies crossCertSig = sign(P2_pub, P1_priv)
   c. updateConsent popup highlights: "This update rotates the signing key from P1 to P2. [Details] [Accept] [Ignore]"
5. User accepts → swap → new SW bakes P2_pub as trust anchor
6. Future updates signed with P2_priv → SW v2 verifies with P2_pub
```

**Emergency rotation without cross-cert** (old key compromised): documented out-of-band recovery in `docs/UPDATE-SYSTEM.md`. Users must reinstall manually (wipe cache + SW). Accepted as rare + publicized separately.

## 7. Build pipeline

```
pnpm build
  ↓
vite build → dist/
  ↓
node src/scripts/build-precache-manifest.mjs
  → walks dist/
  → computes SHA-256 for every file
  → writes dist/update-manifest.json with:
     { version, gitSha, swUrl, swHash, bundleHashes, ... }
  ↓
(CI release job only)
node src/scripts/sign-manifest.mjs
  → reads UPDATE_SIGNING_KEY from env
  → writes dist/update-manifest.json.sig (Ed25519 signature)
  ↓
deploy dist/ (includes manifest + .sig)
```

### 7.1 CI secret management

`UPDATE_SIGNING_KEY` (Ed25519 private key, base64-encoded) stored as GitHub Actions secret. Access restricted to release workflow (`deploy.yml`). Rotation procedure documented in `docs/UPDATE-SYSTEM.md`.

### 7.2 Key generation

One-off setup: generate keypair locally via `node src/scripts/gen-signing-key.mjs` (new script, one-shot use, not committed to CI). Output:
- `signing-pubkey.ts` (committed) — baked into SW
- `signing-private.key` (NOT committed; copied into GitHub secret, then deleted from disk)

## 8. Migration plan

The release that introduces this system (target: `v0.12.0`) is the **last unsigned update**, shipped via the current mechanism. Once v0.12.0 installs:
- New SW takes over → cache-only → baked pubkey → signed-probe active.
- All future updates (v0.12.1+) require signed manifest + user consent.

Users stuck on v0.11.x continue receiving old-style updates until they accept v0.12.0. No user is locked out.

## 9. Testing

### 9.1 Unit tests (Vitest)

- `verify.test.ts`: Ed25519 round-trip, bad-sig rejection, wrong-key rejection
- `trusted-keys.test.ts`: cross-cert valid/invalid/missing; fingerprint calculation
- `probe.test.ts`: consensus 3/3, 2/3, 1/3, all-mismatch, bad-sig handling
- `shell-cache.test.ts`: atomic swap, orphan GC, concurrency protection
- `signed-update-sw.test.ts`: download + verify + swap with mocked fetch
- `update-state.test.ts`: state machine transitions, invalid transitions

### 9.2 Integration tests

- First install: SW registration, precache populated, fingerprint stored
- Probe lifecycle: throttle, trigger, consensus outcomes
- Accept E2E: mock manifest + signature + chunks → atomic swap → new version active
- Decline persistence: 24h snooze, localStorage correctness
- Staleness banner: 7-day decline simulation
- Cache-only invariant: network blocked, app still boots
- Rotation accept: cross-cert valid path
- Downgrade rejection: older-version manifest ignored (unless securityRollback)

### 9.3 E2E tests (Playwright)

| Test | Scenario |
|---|---|
| `e2e-update-first-install.ts` | Fresh browser → visit → SW install → fingerprint banner shown |
| `e2e-update-consent-flow.ts` | Update available → click dot → popup → accept → reload → new version |
| `e2e-update-decline-flow.ts` | Decline → mock 24h elapsed → popup reappears |
| `e2e-update-mitm-signature.ts` | Bad signature → silent ignore → console log |
| `e2e-update-cache-only.ts` | Network blocked post-install → reload → app loads |
| `e2e-update-chunk-mismatch.ts` | Bad chunk hash → abort → old cache intact |
| `e2e-update-rotation.ts` | Rotation manifest accepted → next manifest verified with new key |
| `e2e-update-staleness-banner.ts` | 7 declines → banner appears, non-dismissable |

### 9.4 Regression

New smoke `e2e-boot-cache-only.ts` added to critical path — boot works fully offline post-install. Guards against regressions that reintroduce network fetches in shell paths.

### 9.5 Manual verification (pre-release)

1. Dry-run CI signing with test key
2. Deploy to staging
3. DevTools → Application → Service Workers: verify SW active, cache `shell-vX` present
4. Push v0.12.1 to staging with signed manifest → user sees dot → accept → reload → v0.12.1 active
5. Network Offline mode → reload → app boots
6. Application → Clear storage → verify recovery banner
7. Release with rotation field → user sees key-change popup

## 10. Out of scope (future work)

- **Multi-sig** (require N-of-M signatures): documented as possible future hardening; not this phase.
- **Transparency log** (Sigstore Rekor-style): possible future hardening.
- **Mandatory delay before popup** (security release held back N hours for community vetting): possible future.
- **Third-party security review**: recommended before v1.0; tracked separately.

## 11. Success criteria

- [ ] P1–P6 security properties verified via tests
- [ ] After accepting v0.12.0, no network fetch for `index.html`, JS chunks, CSS, WASM, or SW script on subsequent boots (DevTools Network panel shows 0 shell requests)
- [ ] Declining an update leaves `active-version` and all `shell-v<N>` caches untouched
- [ ] Manifest with tampered signature triggers zero UI notification
- [ ] Chunk with mismatched hash aborts the update atomically
- [ ] Key rotation flow end-to-end works on staging
- [ ] Release pipeline (CI) produces signed manifest without maintainer manual steps
- [ ] All existing E2E tests continue to pass
- [ ] `pnpm test:nostra:quick` passes in <2s
- [ ] No regression in first-paint time for existing users (post-v0.12.0)

## 12. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Bug in SW install path bricks boot | Medium | High | Comprehensive unit + integration tests; manual staging verification; recovery escape hatch (Reset baseline) |
| Precache list incomplete, some asset missing | Medium | Medium | Build script walks `dist/` exhaustively; integration test that blocks network and asserts full app boot |
| Signing key accidentally committed | Low | Critical | Pre-commit hook to block `*.key` files; CI secret scanning |
| User confused by consent popup frequency | Medium | Low | Hybrid UX (red dot, not modal); 24h snooze; clear copy |
| Key rotation UX confuses users | Low | Medium | Clear popup copy showing old → new fingerprint; `docs/UPDATE-SYSTEM.md` user-facing section |
| Third-party dependency (`@noble/ed25519`) has supply-chain compromise | Low | Critical | Pinned version + integrity hash in lockfile; periodic audit |

## 13. Open questions

None at design time. Any issues surfaced during implementation are logged as deviations in the plan execution.
