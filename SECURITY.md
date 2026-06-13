# Security Policy

## ⚠️ Current security status

Nostra.chat is **alpha software**. It has **not been independently audited** by
any third party. While the project builds on well-studied primitives (NIP-44,
NIP-17, NIP-59, BIP-39, AES-GCM, PBKDF2), the integration and the surrounding
code are new and may contain vulnerabilities.

**Do not rely on Nostra.chat for communications where a compromise would put
your physical safety, freedom, or life at risk.** For those threat models,
prefer mature, audited tools such as [Signal](https://signal.org/) or
[Session](https://getsession.org/).

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public
GitHub issue for security bugs.

**Preferred channel — Nostr DM** (end-to-end encrypted via NIP-17):

```
npub1zxn3hul7dsaex9l5a8l8scflxzruxh3v9gvvvgcmtdus7aqenmrskmtyqz
```

Use any NIP-17 capable client (including Nostra.chat itself) to send a DM.

**Alternative channel — GitHub Security Advisory**:

1. Go to <https://github.com/nostra-chat/nostra-chat/security/advisories/new>
2. Fill in the form — this creates a private advisory visible only to
   maintainers.

### What to include in your report

- A clear description of the vulnerability and its impact.
- Concrete reproduction steps, if possible including a minimal PoC.
- The commit hash or release version affected.
- Your suggested fix, if you have one.
- Whether you want to be credited publicly (name, handle, or anonymous).

### What to expect

- An acknowledgement within **72 hours**.
- An initial assessment within **7 days**.
- For confirmed vulnerabilities, a coordinated disclosure timeline agreed
  between you and the maintainers, typically **30–90 days** depending on
  severity and complexity of the fix.
- Public credit in the release notes unless you request otherwise.

## Scope

**In scope:**

- Vulnerabilities in the Nostra.chat source code (`src/`) that compromise
  confidentiality, integrity, or availability of user data or identity keys.
- Vulnerabilities in the build or release pipeline that could be used to ship
  malicious code to users.
- Cryptographic implementation flaws.
- Side-channel leaks that reveal identity keys, message content, or contact
  graphs.

**Out of scope:**

- Issues in upstream Nostr relays themselves — report those to the relay
  operator.
- Issues in the Telegram Web K fork that only affect the unused MTProto code
  path (Nostra.chat has MTProto fully disabled — see
  `src/lib/nostra/virtual-mtproto-server.ts`).
- Issues that require a fully compromised endpoint (malicious browser extension,
  keylogger, OS-level malware). No client-side E2E messenger defends against
  this threat model, and we make no claim to.
- Social engineering attacks against users.
- Denial of service against individual relays unless they cascade into a
  broader security issue.

## Known limitations

We acknowledge these limitations openly. Reports about them are welcome but
will not be treated as new vulnerabilities unless they expose a concrete,
unknown attack:

- **No reproducible builds yet.** Users must currently trust that the build
  served from the mirrors matches the public git history. See
  [docs/TRUST-MINIMIZED-UPDATES.md](docs/TRUST-MINIMIZED-UPDATES.md) for the
  planned mitigation.
- **No independent audit.** Code has been reviewed by the maintainers only.
- **Browser storage is only as strong as the user's device.** IndexedDB
  encryption (AES-GCM with PBKDF2-derived key) protects against casual access
  but not against a sophisticated attacker with physical device access or a
  running malicious process.
- **Relay operators see metadata timing and IP addresses unless Tor is on.**
  With Tor off, relay operators can correlate connection times across users,
  even though message content and recipients are gift-wrapped.

## Safe harbor

Good-faith security research conducted in accordance with this policy will not
result in legal action from the maintainers. Do not access, modify, or destroy
data that does not belong to you; do not degrade service for other users; and
do not publicly disclose vulnerabilities before the agreed disclosure date.
