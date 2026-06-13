# Trust-Minimized Update Distribution

> **Status:** Phase A implemented (Ships 1-6 merged). Phases B/C/D not yet implemented.
> **Target:** Post-v1, multi-phase rollout
> **Owner:** TBD

## Problem

Nostra.chat is a PWA served from multiple mirrors (Cloudflare, GitHub Pages, IPFS).
A Service Worker auto-updates the app in the background. This is the standard PWA
model, but it has a serious weakness for a privacy-focused, censorship-resistant
messenger: **the user has no way to know whether a new release was backdoored**
between publication and their browser fetching it.

Concrete threat scenarios:

- **Maintainer under legal pressure**: a state actor compels the maintainer to
  ship a version that exfiltrates keys or messages.
- **CI/infrastructure compromise**: an attacker with write access to the GitHub
  Actions token or the Cloudflare API token pushes a modified build without
  going through the source repository.
- **CDN hijack**: an attacker compromises DNS or the hosting provider and serves
  a modified bundle only to targeted users.
- **Supply-chain attack**: a malicious dependency bumps silently in a transitive
  `pnpm` package and ships to production.

End-to-end encryption does not defend against any of these: the attacker does
not need to read the ciphertext on the wire, they just need the client code to
hand them the plaintext or the private key.

## Goal

When a new version is available, the user should be able to answer
**before installing it**:

1. *Does the new build actually come from the public git repository?*
2. *Has the code been reviewed by people I trust?*
3. *Do I want to update now, or keep running the version I already trust?*

The answer must be enforceable by the client itself, not just by a website claim.

## Non-goals

- **Preventing a targeted attack on the very first install.** If the user's
  initial download is compromised, everything built on top of it is compromised
  too (TOFU problem). This proposal only hardens subsequent updates.
- **Replacing reviewer judgment with automation.** Audits are performed by
  humans; this system only enforces that their signatures are present and valid
  before the update is surfaced.
- **Forcing users to wait for N signatures.** The user remains in control — the
  system provides information, the user decides.

## Proposed design

The design borrows from three well-known systems and adapts them to a PWA:

| Borrowed from | What it contributes |
|---|---|
| **The Update Framework (TUF)** | Threshold signing and role separation between publishers and reviewers |
| **Sigstore / Cosign** | Transparency-log backed artifact signing |
| **Reproducible builds (Guix, NixOS)** | Multiple independent builders produce the same artifact hash from the same source |

The Nostr protocol provides the publication and discovery layer naturally: signed
events (kind TBD) are a perfect fit for audit attestations, and relays already
give us redundant global distribution.

### Step 1 — User-controlled update prompt (baseline)

Regardless of anything else below, the Service Worker should **never auto-activate**
a new version. Instead:

1. The SW fetches the new bundle as today.
2. When `registration.waiting` is populated, the main thread shows a banner:
   `"Version X.Y.Z is available — Update now / Later"`.
3. `skipWaiting()` is called only on explicit user consent.
4. A "What's new" link opens the `CHANGELOG.md` for the new version.

This step has **no cryptographic content** but already reflects the principle:
no silent updates. It can ship immediately and independently of everything else.

### Step 2 — Reproducible builds

The release pipeline must produce a **deterministic artifact** from a git SHA:

- Pinned `pnpm` lockfile with strict integrity checks.
- Build environment pinned (Node version, pnpm version, OS).
- Deterministic flags for Vite / Rollup (no build timestamps, stable module IDs,
  stable chunk names).
- No post-build steps that inject timestamps, environment variables, or random
  values.
- Output: a single tarball (or directory) whose **SHA-256** (or IPFS CID) is a
  function of the source tree only.

Verification: any third party should be able to run
`git clone && git checkout <sha> && pnpm install --frozen-lockfile && pnpm build:release`
and obtain byte-identical output.

This is the **hard prerequisite** for everything that follows. Without it, the
entire signature layer is meaningless (different builders would disagree on the
"correct" hash for the same source).

### Step 3 — Release attestations as Nostr events

The maintainer publishes, for every release, a Nostr event containing:

```json
{
  "kind": 30078,
  "tags": [
    ["d", "release:v0.3.0"],
    ["git-sha", "abc123..."],
    ["git-tag", "v0.3.0"],
    ["cid", "bafy..."],
    ["sha256", "..."],
    ["changelog-url", "https://github.com/nostra-chat/nostra-chat/releases/tag/v0.3.0"]
  ],
  "content": "<optional human-readable release notes>"
}
```

(Exact kind number to be proposed or chosen from the parameterized-replaceable
range; the design does not depend on a specific value.)

This event is **signed by the maintainer's Nostr pubkey** and published to the
same relay set as regular messages. It acts as the canonical "this release
exists" assertion.

### Step 4 — Audit attestations as Nostr events

Each auditor — an independent reviewer who verified a given release — publishes
their own Nostr event:

```json
{
  "kind": 30079,
  "tags": [
    ["d", "audit:v0.3.0"],
    ["git-sha", "abc123..."],
    ["cid", "bafy..."],
    ["result", "pass"],
    ["scope", "full" | "diff-only"],
    ["review-url", "https://example.org/audit-reports/nostra-chat-v0.3.0.pdf"]
  ],
  "content": "<auditor's comments>"
}
```

Signed by the **auditor's** Nostr pubkey, not the maintainer's. An auditor
claiming "pass" is asserting: *I independently reproduced the build, checked
the diff from the previous release, and found nothing malicious.*

Auditors are real humans (security researchers, community members with enough
reputation to stake) who voluntarily commit to reviewing each release.
Bootstrapping the auditor set is a **social problem**, not a technical one —
but the protocol is ready when they exist.

### Step 5 — User-configured trust policy

The client stores, in IndexedDB:

```ts
interface UpdatePolicy {
  requireMaintainerSignature: boolean;  // default: true
  trustedAuditors: {pubkey: string, name?: string}[];
  requiredAuditorCount: number;         // default: 0 initially, raise later
  blockUntilSatisfied: boolean;         // soft-warn vs hard-block
}
```

The default policy on a fresh install is **permissive**: it checks the
maintainer signature but does not require auditors. Users who care add their
trusted auditor pubkeys manually (pasted from the project website, scanned from
a QR, or imported from a friend via Nostr DM).

### Step 6 — Client-side verification flow

When a new Service Worker is ready to install:

1. Fetch the release attestation event for the candidate version.
2. Verify the maintainer signature.
3. Verify that the release event's `cid` / `sha256` matches the actual bundle
   the SW has downloaded. **If not, refuse to activate.**
4. Fetch audit attestations for the same `git-sha` and count valid signatures
   from the user's trusted auditor set.
5. Show the user:
   ```
   Version 0.3.0 is available

   Published: 2026-05-10 by maintainer <npub1...>  ✓ signature valid
   Audited by:
     - Alice (npub1a...)     ✓ pass, full review
     - Bob (npub1b...)       ✓ pass, diff-only
     - Carol (npub1c...)     ✗ not yet audited

   You require 2 of 3 audits — threshold met ✓

   [What changed]  [Update now]  [Later]
   ```
6. If threshold is not met and `blockUntilSatisfied` is true, hide the "Update
   now" button and show a "Waiting for audits" state.

### Step 7 — Key compromise / rotation

Auditor key rotation is handled via Nostr's standard mechanism: the auditor
publishes a "this key is deprecated" event signed by both old and new keys.
The client UI shows a warning when a trusted auditor has rotated keys and asks
the user to re-confirm.

Maintainer key compromise is harder: a compromised maintainer key can sign a
malicious release attestation. Mitigations:
- The client refuses releases whose `git-sha` is not reachable from the
  public `main` branch (requires GitHub/git fetch, or a separate trusted git
  mirror).
- Auditor signatures act as a check: a compromised maintainer cannot forge
  signatures from *other* people.
- For extreme threat models, the client can require **M of M publisher
  signatures**, where the publisher role is itself split (maintainer +
  community co-signer).

## The TOFU problem (honest caveat)

The verification above happens inside the currently running PWA. If that PWA
is already compromised, it can lie about signatures. This is the fundamental
first-install problem of any self-updating system, and there is no purely
software solution.

Partial mitigations:

- **Install from IPFS CID**: the first install, if done via a content-addressed
  URL (e.g. `https://dweb.link/ipfs/<cid>/`), is content-verified against the
  CID the user typed or scanned. The user must then rely on an out-of-band
  channel (published on the project website, in release notes, in a signed
  tweet/Nostr event by the maintainer) to know the "correct" CID for a given
  version.
- **Second device verification**: a simple CLI tool or browser extension can
  cross-check the running PWA's signature state against the user's expected
  policy, outside the PWA's own code.
- **Reproducible build validation by the user**: users with enough technical
  skill can clone, build, and compare hashes themselves. This is the escape
  hatch that makes the whole system non-vacuous: even if we cannot automate
  it for most users, the *possibility* exists.

## Rollout plan

| Phase | What ships | Blocks on |
|---|---|---|
| **Phase A — Baseline** ✅ | Step 1 (user-controlled update prompt) + cross-source manifest verification + SW integrity defenses. No crypto. | **Implemented.** See `docs/superpowers/specs/2026-04-16-phase-a-controlled-updates-design.md`. |
| **Phase B — Reproducibility** | Step 2 (deterministic build pipeline). Document how to reproduce, publish official build hashes alongside each release. | Engineering investment, build infra changes. |
| **Phase C — Maintainer signatures** | Step 3 + partial Step 6 (verify maintainer signature before activating update). | Phase B. Maintainer Nostr publishing workflow. |
| **Phase D — Audit layer** | Steps 4, 5, 6, 7 fully. Threshold signing, auditor set configuration, UI for audit state. | Phase C. **Having real human auditors committed to reviewing releases.** This is a social prerequisite, not a technical one. |

Each phase is independently valuable: stopping at Phase C already defeats CDN
hijack and domain takeover. Phase D is what defeats maintainer compromise.

## Open questions

- **Which Nostr kind numbers?** Need to check what's already used in the wild
  and either pick unused ones or propose a NIP.
- **Where do users discover trusted auditor keys?** A hardcoded list in the
  client is a single point of failure; a fully self-serve model defeats the
  purpose. A hybrid with "recommended" auditors the user can audit themselves
  is probably correct.
- **How often should the client re-check?** Every SW update? Every app launch?
  Relays are cheap but not free.
- **Relationship with browser code signing proposals?** The W3C has intermittent
  discussions about PWA code signing; if one lands, it may subsume parts of
  this design.
- **Legal exposure for auditors.** Publicly signing "this code is safe" might
  create liability in some jurisdictions. A clear "best-effort, no warranty"
  statement in the attestation's `content` field mitigates but does not
  eliminate this.

## References

- [The Update Framework (TUF)](https://theupdateframework.io/)
- [Sigstore](https://www.sigstore.dev/)
- [Reproducible Builds project](https://reproducible-builds.org/)
- [NIP-01 — Basic protocol flow](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-33 — Parameterized replaceable events](https://github.com/nostr-protocol/nips/blob/master/33.md)
- [W3C Discussion — PWA code signing (various threads)](https://github.com/w3c/manifest/)

## Related work in the Nostra.chat codebase

This document is a **design proposal only**. No code has been written for it.
When implementation begins, entry points will likely be:

- `src/lib/serviceWorker/` — intercept SW update lifecycle
- `src/lib/nostra/chat-api.ts` — reuse existing relay pool for attestation fetch
- `src/components/popups/` — update prompt UI
- `src/config/state.ts` — persist `UpdatePolicy`
- A new module `src/lib/nostra/update-verifier.ts` for the core verification logic
