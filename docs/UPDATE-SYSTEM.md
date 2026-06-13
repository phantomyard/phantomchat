# Update System — Operator Runbook

Nostra.chat uses a **consent-gated update system**. Every post-first-install version change requires:

1. A manifest (`update-manifest.json`) signed with **Ed25519** by the release key.
2. Explicit **user consent** via popup.
3. Per-chunk **SHA-256 verification** during download.

Spec: `docs/superpowers/specs/2026-04-21-consent-gated-update-design.md`.
Plan: `docs/superpowers/plans/2026-04-21-consent-gated-update.md`.

## Key lifecycle

### Initial key generation (one-off, performed by maintainer before first signed release)

```bash
pnpm run gen-signing-key
# → signing-private.key (NOT committed, 0600 perms)
# → src/lib/update/signing/trusted-pubkey.generated.ts (COMMITTED)
```

1. Copy the content of `signing-private.key` into GitHub Actions secret `UPDATE_SIGNING_KEY`.
2. Delete the private key from disk: `rm signing-private.key`.
3. Commit `trusted-pubkey.generated.ts` (the baked public key).
4. Release the version containing the baked pubkey — this is the **trust anchor** release. Only updates signed with the corresponding private key will be accepted by clients.

### Release signing (every release, automated via CI)

CI job `deploy-cloudflare` (and similar) in `.github/workflows/deploy.yml` runs `pnpm run sign-manifest` post-build:

```
pnpm build → dist/update-manifest.json (v2 schema, bundleHashes for every asset)
pnpm run sign-manifest → dist/update-manifest.json.sig (64-byte Ed25519, base64)
Deploy both files.
```

Clients probe the manifest + signature from multiple sources (`MANIFEST_SOURCES` in `manifest-verifier.ts`) and verify the Ed25519 signature BEFORE consensus comparison.

### Key rotation

**Planned rotation** (not post-compromise):

1. Locally generate a new keypair:
   ```bash
   pnpm run gen-signing-key
   ```
2. Use the OLD private key to produce a cross-certificate signature over the new public key bytes (helper script can be added; manual Ed25519 sign works).
3. Build the release manifest with a `rotation` field:
   ```json
   "rotation": {
     "newPubkey": "<base64 new pubkey>",
     "newFingerprint": "ed25519:<first 16 hex>",
     "crossCertSig": "<base64 sign(new_pubkey, OLD_priv)>"
   }
   ```
4. Sign the manifest with the OLD private key.
5. Ship. Users' SWs verify the manifest signature with the CURRENT pubkey AND verify the cross-cert. The `updateConsent` popup highlights the rotation.
6. After users accept, the new pubkey is baked into their SW state.
7. Rotate the `UPDATE_SIGNING_KEY` GitHub secret to the new private key.
8. Future releases are signed with the new private key.

**Emergency rotation (old key compromised):** the cross-cert pattern is NOT safe if the attacker has the old key — they could sign their own rotation. Recovery:

1. Publish notice out-of-band: Twitter/Nostr/GitHub README. Ask users to reinstall.
2. Ship a release with a new primary pubkey (no cross-cert). Users who reset their installations (Settings → App Updates → Reset baseline) will install the new pubkey as fresh TOFU.
3. Users who do not reset remain vulnerable to attacker-signed releases until they decline them. The consent popup is the secondary gate.

## Storage

| Namespace | Key / Cache | Purpose |
|-----------|-------------|---------|
| IndexedDB | `nostra-update-state` → `active` → `current` | `{version, keyFingerprint, installedPubkey, at}` — active trust anchor |
| CacheStorage | `shell-v<version>` | The currently-served app-shell |
| CacheStorage | `shell-v<version>-pending` | In-flight update target (atomic swap source) |
| localStorage | `nostra.update.snoozedVersion`, `.snoozedUntil` | Per-version 24h snooze |
| localStorage | `nostra.update.declineCount.<version>` | Declines; triggers staleness banner at 7 |
| localStorage | `nostra.update.lastProbe` | Throttle (12h) |
| localStorage | `nostra.update.first-install-seen` | Suppresses the one-time info banner |
| localStorage | `nostra.update.staleness_snooze` | 24h dismiss for the staleness banner |

## User-facing flows

### First install (TOFU)

A user visiting `nostra.chat` with no SW installed:
1. Browser fetches the index + chunks over HTTPS+HSTS (the TOFU window).
2. SW installs, reads `update-manifest.json`, precaches every asset, SHA-256-verifies each.
3. The `FirstInstallInfo` banner appears once, showing the baked key fingerprint.

### Probe → popup → accept

1. App boot (max once per 12h) or user clicks "Check" in Settings.
2. `probe()` fetches manifest + `.sig` from N sources with `cache: 'no-cache'`.
3. Ed25519 signature verified against the baked/installed pubkey.
4. Consensus across sources for `{version, bundleHashes, swUrl}`.
5. If new version: red dot on hamburger, `update_available` event dispatched.
6. User clicks hamburger update button → `UpdateConsent` popup opens.
7. User accepts → main thread posts `UPDATE_APPROVED` to SW.
8. SW downloads chunks to `shell-v<new>-pending`, verifies each hash, and performs atomic swap on all-match.
9. User reloads → new version served from cache.

### Decline

- 24h snooze for this version.
- After 7 consecutive daily declines: `StalenessBanner` appears, non-dismissable for 24h at a time.

### Failure modes

| Failure | Response |
|---|---|
| Invalid signature | Probe fails silently (console warn only). No popup. Attacker cannot even announce. |
| Chunk hash mismatch during download | Pending cache discarded. Popup: "Update cancelled — integrity check failed." Active cache intact. |
| Network drop | Same as chunk mismatch — atomic all-or-nothing. |
| Quota exceeded | Popup: "Insufficient storage." Old cache intact. |
| Cache-miss on app-shell at runtime | SW returns a 503 HTML recovery page with a [Reinstall] button that wipes caches and unregisters. |
| Downgrade attempt (new version < active without `securityRollback`) | Probe returns `downgrade-rejected`. No popup. |
| Swap transaction fails | Rollback atomic; active intact; popup "Apply failed, retry." |

## Invariants (guarded by tests)

- No automatic `reg.update()` call (grep `src/` — only in comments).
- App-shell fetches served ONLY from cache (navigation + `.js/.css/.wasm/.html/...`) — except `/update-manifest.json*` which always hits network for probe.
- Any unsigned or wrong-key-signed manifest is dropped silently.
- Any chunk mismatch aborts swap; active cache unchanged.
- Monotonic version: newVersion must be > activeVersion (unless `securityRollback: true`).

## Recovery UX

Settings → App Updates → "Reset baseline" wipes `shell-*` caches, unregisters SW, reloads. Triggers fresh TOFU.

## Tests

Unit + integration (Vitest):
- `src/tests/update/verify.test.ts`
- `src/tests/update/trusted-keys.test.ts`
- `src/tests/update/probe.test.ts`
- `src/tests/update/update-state.test.ts`
- `src/tests/update/shell-cache.test.ts`
- `src/tests/update/signed-update-sw.test.ts`

E2E (Playwright):
- `src/tests/e2e/e2e-update-consent-flow.ts`
- `src/tests/e2e/e2e-update-cache-only.ts`

## Build pipeline

```
pnpm build
  → vite build → dist/
  → src/scripts/build/emit-update-manifest.ts
       → dist/update-manifest.json (schemaVersion: 2, bundleHashes of every file)
  → src/scripts/build/validate-update-manifest.ts
       → hard-fails if schema unsound
  → (CI only, if UPDATE_SIGNING_KEY present)
     pnpm run sign-manifest
       → dist/update-manifest.json.sig
```

## Maintainer invariants (don't break these)

Discovered the hard way during smoke testing of v0.12.0. Each invariant exists for a reason; check the listed file before changing.

- **`cache.addAll(paths)` for SW install precache** (`src/lib/serviceWorker/index.service.ts`). 4000+ files cannot be fetched serially within the browser's 30s install budget. NEVER refactor to a `for...of fetch+verify` loop.
- **Sig verify uses raw `manifestText` bytes, not `JSON.stringify(parsed)`** (`src/lib/serviceWorker/signed-update-sw.ts`). postMessage / structured-clone reorders object keys → re-serialized JSON has different bytes than what the server emitted → signature fails. The probe returns `manifestText` and threads it through dispatch → popup → `acceptUpdate` → SW handler.
- **`setActiveVersion` runs in `install`, not `activate`** (`src/lib/serviceWorker/index.service.ts`). Some browser configurations recycle the worker scope between events, dropping `self.__INSTALL_*` globals. Persist directly to IDB during install.
- **Update-flow SW deps are STATIC imports** (`signed-update-sw`, `shell-cache`, `trusted-keys`). Vite chunk splits make `await import('./foo')` inside SW unreliable — chunk fails to load → `swap-failed` with no useful error.
- **`requestCacheStrict` uses `{ignoreSearch: true}`** (`src/lib/serviceWorker/cache.ts`). Vite asset URLs carry cache-buster querystrings (e.g. `site.webmanifest?v=jw3mK7G9Aq`) that don't appear in the cached URL.
- **URL-reserved chars in manifest paths are encoded before fetch** (`signed-update-sw.ts`: `path.replace(/#/g, '%23').replace(/\?/g, '%3F')`). Build excludes `/changelogs/*.md` for the same reason — release notes are embedded in `manifest.changelog` instead.
- **`update_available_signed` listener registers as a module-load side-effect** in `src/lib/update/update-popup-controller.ts`, NOT in `src/index.ts`. This guarantees the listener is alive before `runProbeIfDue()` (called on the same import cycle) dispatches the event. A duplicate listener in `src/index.ts` would overwrite the stash without `manifestText`.
- **`@noble/ed25519` v3 API** — `ed.hashes.sha512 = sha512` (NOT `ed.etc.sha512Sync = ...`), `ed.utils.randomSecretKey()` (NOT `randomPrivateKey`), import sha512 from `@noble/hashes/sha2.js` (NOT `/sha512`). Every file using `ed.signAsync`/`ed.verifyAsync` must set `ed.hashes.sha512 = sha512` at module top.
