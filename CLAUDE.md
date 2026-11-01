# CLAUDE.md — PhantomChat.chat

## Project Overview

**PhantomChat.chat** is a decentralized messaging client (https://phantomchat.chat/) built with Solid.js and TypeScript. Forked from Telegram Web K, it replaces the Telegram backend with peer-to-peer encrypted chat over Nostr relays. The codebase is large (~100k+ lines excluding vendor), mature, and highly performance-oriented. License: GPL v3.

## Tech Stack

| Layer | Technology |
|---|---|
| UI Framework | Solid.js (custom fork in `src/vendor/solid/`) |
| Language | TypeScript 5.7 |
| Build | Vite 5 |
| CSS | SCSS (sass) |
| Testing | Vitest (unit) + Playwright (E2E) |
| Package Manager | pnpm 9 |
| Protocol | Nostr (NIP-06, NIP-17, NIP-44, NIP-59, NIP-65) |
| Storage | IndexedDB + CacheStorage + localStorage |
| Workers | SharedWorker + ServiceWorker |

## Development

```bash
pnpm install
pnpm start          # Dev server on :8080
pnpm build          # Combined pinned Stable + candidate Preview → dist/
pnpm test           # Run tests (Vitest)
pnpm test:phantomchat:quick  # Critical P2P tests only (~160 tests in <2s)
pnpm test:phantomchat        # Full P2P test suite
pnpm lint           # ESLint on src/**/*.{ts,tsx}
```

**Pre-commit hook:** husky + lint-staged runs `eslint` on staged `src/**/*.{ts,tsx}` files. Do NOT use `--no-verify` — fix the lint error instead.

**Debug query params:** `?test=1` (test DCs), `?debug=1` (verbose logging), `?noSharedWorker=1` (disable shared worker).

**Build/test gotchas:**
- `pnpm test run <file>` (NOT `pnpm test <file>`) for one-shot vitest — `pnpm test` opens watch mode that hangs subagents and CI.
- The channel builder runs each source tree with `NODE_ENV=production` and `vite build --mode production` — without these, `import.meta.env.PROD` evaluates to `false` in main bundle and entire prod-only blocks (banners, listeners) silently disappear from output. Don't strip these flags from `package.json` `build` script.
- `pnpm preview` rebuilds and serves on `:8080`. Vite preview's SPA fallback returns `index.html` for any unmatched URL — including URL-encoded paths to existing files (e.g. `%23` not decoded). This hides production bugs; test URL-sensitive behavior against a real static server (Cloudflare Pages preview), not `vite preview`.

**Dev-mode gotchas (`pnpm start` only, do NOT fight them):**
- `resetLocalData.ts` lazy-imports `confirmationPopup` and `clearAllExceptSeed`. Static imports pull in `popups/index` → `popups/peer`, causing a circular-init race: `ReferenceError: Cannot access 'PopupPeer' before initialization`.
- **Multi-instance rootScope**: HMR/dynamic imports can create separate `rootScope` instances. Listeners registered on one won't receive dispatches on another. Before adding defenses for a "missing listener" bug, verify the listeners actually exist on the rootScope the app dispatches on. Production builds don't hit this.
- **Boot splash (`index.html` + `src/index.ts`)**: the inline splash is revealed until `window.__hideBootSplash()` is called. Do NOT add a MutationObserver for `#auth-pages` / `#main-columns` / `#page-chats` — those IDs are shipped as static wireframe wrappers by the tweb fork, so the observer fires on the first microtask and tears the splash down before paint (0.14.0 ship bug). The authoritative signal is the explicit call in `src/index.ts` after `preventCrossTabDynamicImportDeadlock`. A 120s safety timer force-removes the splash if the main bundle throws before reaching the hook.
- Regression coverage: `src/tests/e2e/e2e-dev-boot-smoke.ts` asserts the dev server boots without TDZ or the compromise banner.

## Directory Structure

```
src/
├── components/       # Solid.js UI components (.tsx)
│   ├── chat/         # Chat bubbles, topbar, sidebars
│   ├── popups/       # Modal/popup components
│   ├── mediaEditor/  # Media editing UI
│   └── ...           # 200+ feature folders
├── lib/
│   ├── appManagers/  # 55+ domain managers (chats, users, messages, etc.)
│   ├── phantomchat/       # P2P messaging (Virtual MTProto server, sync, ChatAPI, relay pool, crypto)
│   ├── mtproto/      # MTProto protocol implementation
│   ├── storages/     # IndexedDB/localStorage wrappers
│   ├── rootScope.ts  # Global event emitter & app context
│   └── mainWorker/   # Background worker logic
├── stores/           # Solid.js reactive stores (13 stores)
├── helpers/          # 145+ utility functions
├── hooks/            # Solid.js hooks
├── pages/            # Auth pages (login, signup, etc.)
├── config/           # App constants, state schema, emoji, currencies
├── environment/      # Browser feature detection (39 modules)
├── scss/             # Global stylesheets
├── vendor/           # Third-party forks (solid, solid-transition-group)
├── scripts/          # Build & codegen scripts
└── tests/            # Test files
```

## Path Aliases

Always use these aliases instead of relative paths:

```typescript
@components/*   → src/components/
@helpers/*      → src/helpers/
@hooks/*        → src/hooks/
@stores/*       → src/stores/
@lib/*          → src/lib/
@appManagers/*  → src/lib/appManagers/
@environment/*  → src/environment/
@config/*       → src/config/
@vendor/*       → src/vendor/
@richTextProcessor/* → src/lib/richTextProcessor/
@customEmoji/*  → src/lib/customEmoji/
@rlottie/*      → src/lib/rlottie/
@layer          → src/layer.d.ts    (MTProto API types)
@types          → src/types.d.ts    (utility types)
@/*             → src/

// Solid.js resolves to the custom fork:
solid-js        → src/vendor/solid
solid-js/web    → src/vendor/solid/web
solid-js/store  → src/vendor/solid/store
```

## Code Style (enforced by ESLint)

- **Indent**: 2 spaces (no tabs)
- **Quotes**: single quotes; template literals allowed
- **Line endings**: Unix (LF); file must end with newline
- **No trailing spaces**
- **Comma dangle**: never (`{a: 1, b: 2}` not `{a: 1, b: 2,}`)
- **Object/array spacing**: no spaces inside `{}` or `[]` (`{a: 1}` not `{ a: 1 }`)
- **Keyword spacing**: no space after `if`, `for`, `while`, `switch`, `catch` (`if(condition)` not `if (condition)`)
- **Function paren**: no space before paren — `function foo()` not `function foo ()`
- **No `return await`**: use `return promise` directly
- **Max 2 consecutive blank lines**
- **`prefer-const`** with destructuring: `all`
- **Ternary operators**: `?` / `:` go at END of line, not start of next: `condition ?\n  value1 :\n  value2` — never `condition\n  ? value1`

## TypeScript Notes

- `strict: true` but `strictNullChecks: false` and `strictPropertyInitialization: false`
- `useDefineForClassFields: false` — important for class field behavior
- `jsxImportSource: solid-js` — JSX is Solid.js, not React
- MTProto types live in `src/layer.d.ts` (664KB, auto-generated); import from `@layer`
- Utility types (AuthState, WorkerTask, etc.) live in `src/types.d.ts`; import from `@types`

## Key Patterns

- **Solid components** live in `.tsx` files. Props typed inline. Use `classNames()` from `@helpers/string/classNames` for class composition. JSX resolves to the custom Solid fork — NO React imports, NO React patterns.
- **Scoped styles**: `.module.scss` next to the component, imported as `styles` (e.g. `<div class={styles.wrap}>`). Global styles in `src/scss/`. BEM-like naming. CSS variables drive theming.
- **Stores** in `src/stores/` use `createRoot` + `createSignal`, subscribe to `rootScope` events at module top-level, and export a hook returning the signal getter.
- **App managers** in `src/lib/appManagers/` subclass `AppManager` and init in their `after()` hook. They run Worker-side, communicate via `rootScope` events, and are accessed as `rootScope.managers.appSomethingManager`.
- **Global bus**: `rootScope` from `@lib/rootScope` is the event emitter and context. Events typed in `BroadcastEvents` — no `as any` casts.

## Important Files

| File | Purpose |
|---|---|
| `src/index.ts` | App entry point, account/auth init |
| `src/lang.ts` | All i18n strings (232KB) |
| `src/layer.d.ts` | MTProto API types (auto-generated, 664KB) |
| `src/types.d.ts` | Utility/app types |
| `src/global.d.ts` | Global interface augmentations |
| `src/config/state.ts` | Application state schema |
| `src/config/app.ts` | App constants |
| `src/lib/rootScope.ts` | Global event emitter |
| `vite.config.ts` | Build configuration |
| `eslint.config.mjs` | ESLint flat config |
| `src/lib/phantomchat/virtual-mtproto-server.ts` | Virtual MTProto Server — intercepts MTProto calls, returns native responses |
| `src/lib/phantomchat/phantomchat-sync.ts` | Incoming message persistence + event dispatch |
| `src/lib/phantomchat/phantomchat-peer-mapper.ts` | Creates tweb-native User/Chat/Message/Dialog objects |
| `src/lib/phantomchat/chat-api.ts` | ChatAPI — relay pool, gift-wrap, send/receive |
| `src/lib/phantomchat/nostr-relay-pool.ts` | Multi-relay connection pool |
| `src/lib/apiManagerProxy.ts` | Main-thread proxy to Worker managers |
| `docs/ARCHITECTURE.md` | Deep architecture notes (Tor, Vitest/E2E quirks, profile sync, Phase A) |
| `docs/RELEASE.md` | Release pipeline reference |

## What NOT to Do

- Do not add `eslint-disable` without a reason
- Do not use `return await` (rule enforced)
- Do not use spaces inside `{}` for objects or `[]` for arrays
- Do not use `if (` with a space — use `if(`
- Do not import from `react` or use React patterns — this is Solid.js
- Do not use relative `../../` imports when an alias exists
- Do not use `var` — use `const`/`let`
- Do not add trailing commas in arrays/objects
- Do not save screenshots/images in the project root — use `/tmp/`. `.gitignore` blocks `*.png` at root.
- Do not assume a component is mounted just because the file exists — grep for imports (`MessageRequests.tsx` existed but was never mounted).
- Do not assume a `rootScope.dispatchEvent('foo')` is wired — grep for listeners before relying on it.
- Do not edit `package.json` version manually to ship a release — the deployed version is `1.0.<build_number>`, set by CI from `github.run_number`. The `package.json` value (`1.0.0`) is only the local/dev fallback.
- Do not open two Claude Code instances in the same working directory — use `git worktree add ../phantomchat-wt/<name> -b <branch> main`, one Claude per worktree.
- Do not remove the `!public/recorder.min.js` exception in `.gitignore` — it's a third-party UMD imported statically from `src/components/chat/input.ts`.
- Do NOT narrow the `lint` / `lint-staged` globs back to `src/**/*.ts` — must be `src/**/*.{ts,tsx}`. Solid components live in `.tsx` files; the narrow glob lets indent/formatting errors reach CI where `vite-plugin-checker` catches them, blocking release.

- **Don't drop a group's old dialog row before its new one lands.** `relocateGroupDialog` is make-before-break and rejects only while the group is still where it was; history, dialog row and record must end on one peer id. Pass `offsetDate: 0` when pushing a PhantomChat dialog: `pushDialog` otherwise drops the row silently while the target folder is unloaded.
- **Don't persist a group `peerId` that wasn't derived locally.** Session evidence is a one-way ratchet (`intendedGroupKind`), and classic and session peer ranges never overlap, so a session-range id can only come from a session. Sync upserts re-derive `peerId` from the class before saving.

## Release & Deployment

- **Web application channels:** Stable `/` and Preview `/preview/index.html` share identity and IndexedDB. Read [docs/RELEASE-CHANNELS.md](docs/RELEASE-CHANNELS.md) for the compatibility gate and artifact promotion contract.
- **CI** runs typechecks and tests on PRs. A merge to main also builds and publishes PWA Preview. It never builds Electron.
- **Actions names:** `ci.yml` = "PR checks — automatic on every PR"; `deploy.yml` = "PWA 1. Build + deploy to Preview — automatic on merge"; `pwa-promote.yml` = "PWA 2. Promote Preview to Stable — manual"; `app-release.yml` = "Electron 1. Build + deploy to Preview — manual" (runs from main only); `app-promote.yml` = "Electron 2. Promote Preview to Stable — manual". Do not rename these files: versions come from each workflow's run number. Blank promotion input selects the newest successfully published Preview for that product.
- PWA versions use `1.0.<deploy run_number>`; desktop versions independently use `1.1.<app-release run_number>`. Do not hand-edit `package.json` to ship.
- PWA archives remain draft releases forever, outside Electron's public update feed. No bare tags. See [docs/RELEASE.md](docs/RELEASE.md).
- Andrew owns manual publication/promotion. A merge publishes PWA Preview only; it never authorizes Electron Preview or any Stable promotion.

## Architecture Notes

Subsystem rules — Worker context, Virtual MTProto / MessagePort bridge + middleware rules table, message receive pipeline, delivery tracker, logout & cleanup, UI components, PhantomChat module architecture, background push, MTProto intercept, bug fuzzer, bubble rendering — live in [`docs/CLAUDE-RULES.md`](docs/CLAUDE-RULES.md). Read it before touching any of those areas.

For deep architecture narrative (Tor runtime, Vitest/E2E quirks, profile sync internals, profile tab layout, Blossom upload) see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). For fuzz status / open findings / per-phase closure log see [`docs/FUZZ-FINDINGS.md`](docs/FUZZ-FINDINGS.md).

