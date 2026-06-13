# Contributing to Nostra.chat

Thank you for your interest in contributing. Nostra.chat is an early-stage
privacy-focused project and every improvement — code, docs, translations,
bug reports, design — is welcome.

## Ways to contribute

- **Report a bug** — open a [GitHub issue](https://github.com/nostra-chat/nostra-chat/issues/new/choose)
  with clear reproduction steps, browser info, and what you expected vs what
  happened. **Do not report security vulnerabilities in public issues** —
  see [SECURITY.md](SECURITY.md).
- **Suggest a feature** — open an issue labelled `enhancement`. Describe the
  use case and the threat model, not just the UI change.
- **Write code** — see "Development workflow" below.
- **Improve documentation** — typos, clarifications, translations of
  user-facing strings, README improvements. Small doc PRs are very welcome
  and reviewed quickly.
- **Test releases** — install the PWA, use it with a friend, report anything
  that surprises you.

## Development workflow

### 1. Fork & clone

```bash
git clone git@github.com:<your-username>/nostra-chat.git
cd nostra-chat
pnpm install
```

### 2. Create a branch

Name it descriptively:

```bash
git checkout -b feat/chat-reactions
git checkout -b fix/relay-reconnect-loop
git checkout -b docs/security-policy
```

Do not commit directly to `main` in your fork if you plan to submit a PR —
a feature branch keeps the history clean and makes review easier.

### 3. Make your changes

- Keep commits focused. One logical change per commit.
- Follow the style rules enforced by ESLint — run `pnpm lint` before
  committing. The project CLAUDE.md documents the non-obvious style choices
  (no space after `if`, ternary operators at end of line, no spaces inside
  braces, etc.).
- Add or update tests when you touch behavior — `pnpm test` for unit tests,
  `pnpm test:nostra:quick` for the fast P2P suite.

### 4. Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/) so the
release tool can generate the changelog automatically:

```
feat(chat): add emoji reactions to message bubbles
fix(relay): handle empty NIP-65 relay list gracefully
docs(readme): clarify IPFS gateway usage
build: pin pnpm version in GitHub Actions
style: fix indentation in mesh-manager.ts
test(e2e): add bidirectional media delivery test
chore: update dependencies
```

Types:

- `feat` — new user-facing feature
- `fix` — bug fix
- `docs` — documentation only
- `style` — formatting, no code change
- `refactor` — code change that neither fixes a bug nor adds a feature
- `test` — adding or fixing tests
- `build` — build system or external dependencies
- `ci` — CI configuration
- `chore` — other maintenance

Add `!` after the type or a `BREAKING CHANGE:` footer when the change is
backwards-incompatible:

```
feat(storage)!: migrate IndexedDB schema to v2

BREAKING CHANGE: users on v0.2.x will need to re-import their identity.
```

### 5. Open a pull request

- Target the `main` branch.
- Fill in the PR description: what the change does, why it's needed, how
  you tested it, and screenshots if UI is affected.
- Link related issues with `Closes #123` in the description.
- Expect a review within a few days. Small PRs are reviewed faster than
  large ones — if you are changing more than a few hundred lines, consider
  splitting.

### 6. Review & merge

- Address review comments by pushing new commits to the same branch — do
  not force-push during active review, it makes re-review harder.
- PRs are merged via **squash and merge** so the `main` history stays
  linear and each merge corresponds to one logical change.
- After merge, delete your branch.

## Style & code conventions

Full details are in [CLAUDE.md](CLAUDE.md). The highlights:

- **Indent:** 2 spaces, no tabs.
- **Quotes:** single quotes, template literals allowed.
- **No space** after `if`, `for`, `while`, `switch`, `catch` — `if(cond)`,
  not `if (cond)`.
- **No spaces** inside braces or brackets — `{a: 1}` not `{ a: 1 }`.
- **Ternary operators:** `?` and `:` go at the **end** of the line.
- **No `return await`** — return the promise directly.
- **Path aliases:** always use `@components/*`, `@lib/*`, `@helpers/*`,
  etc. Never `../../..` relative imports when an alias exists.
- **No comments** that explain what well-named code already says. Comments
  are for non-obvious *why*, not narration.
- **This is Solid.js, not React** — no `useState`, no JSX event delegation
  assumptions, no React idioms.

## Testing your changes

```bash
pnpm lint                   # ESLint
npx tsc --noEmit            # TypeScript check
pnpm test                   # Vitest unit tests
pnpm test:nostra:quick      # Fast P2P suite (~2s)
pnpm test:e2e:all           # Playwright E2E (slow, needs Docker for local relay)
```

Run at least `pnpm lint`, `pnpm test`, and `pnpm test:nostra:quick` before
opening a PR. The full E2E suite runs in CI on every push to `main`.

## Areas that need help

If you're looking for somewhere to start:

- **Tor UI improvements** — circuit dashboard, per-relay latency, toggle.
- **Internationalization** — translating user-facing strings in `src/lang.ts`.
- **Reproducible builds** — making the Vite output deterministic. See
  [docs/TRUST-MINIMIZED-UPDATES.md](docs/TRUST-MINIMIZED-UPDATES.md).
- **Cross-browser testing** — especially Safari / iOS, where the
  SharedWorker and Service Worker behave differently.
- **Accessibility** — keyboard navigation, ARIA labels, screen reader
  compatibility.

## Code of conduct

Be kind, be patient, assume good faith, and remember that contributors come
from many backgrounds and timezones. Personal attacks, harassment, or
discrimination are not tolerated. Maintainers reserve the right to remove
comments and block users who violate this policy.

## License

By contributing to Nostra.chat, you agree that your contributions will be
licensed under the same [GPL v3](LICENSE) license that covers the project.
