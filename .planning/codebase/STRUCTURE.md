# Codebase Structure

**Analysis Date:** 2026-03-31

## Directory Layout

```
nostra/
├── src/                          # Application source code (22MB, 1623 .ts/.tsx files)
│   ├── index.ts                  # Entry point: initialization, state loading, app bootstrap
│   ├── components/               # UI components (28 subdirectories, 200+ .tsx files)
│   │   ├── chat/                 # Chat UI: bubbles, input, topbar, reactions
│   │   ├── popups/               # Modal dialogs: settings, confirmations
│   │   ├── sidebarLeft/          # Chat list, filters, folders sidebar
│   │   ├── sidebarRight/         # Chat info, members, settings sidebar
│   │   ├── mediaEditor/          # Image/video cropping, filters UI
│   │   ├── appNavigationController.ts   # Navigation state machine
│   │   └── ... (20 more feature folders)
│   ├── lib/                      # Business logic and infrastructure
│   │   ├── appManagers/          # 38+ domain managers (messages, chats, users, reactions, etc.)
│   │   │   ├── appMessagesManager.ts        # Message CRUD, history, search, sending
│   │   │   ├── appChatsManager.ts           # Chat metadata, members, permissions
│   │   │   ├── appUsersManager.ts           # User profiles, blocking, privacy
│   │   │   ├── appProfileManager.ts         # User full info, typing indicators
│   │   │   ├── apiManager.ts                # Telegram RPC API invocation
│   │   │   ├── apiUpdatesManager.ts         # Incoming update dispatcher
│   │   │   ├── appReactionsManager.ts       # Emoji reactions
│   │   │   ├── appDownloadManager.ts        # File/media downloads
│   │   │   ├── appGroupCallsManager.ts      # Group calls (voice/video)
│   │   │   ├── appStickersManager.ts        # Sticker packs
│   │   │   └── ... (25+ more managers)
│   │   ├── mtproto/              # Telegram MTProto protocol implementation
│   │   │   ├── dcConfigurator.ts            # Data center discovery
│   │   │   ├── networker.ts                 # Socket connection management
│   │   │   ├── authorizer.ts                # Authentication handshake
│   │   │   └── cryptoMessagePort.ts         # Crypto worker bridge
│   │   ├── nostra/             # Nostra.chat P2P integration (new)
│   │   │   ├── identity.ts                  # Nostr keypair management
│   │   │   ├── chat-api.ts                  # Chat API abstraction layer
│   │   │   ├── offline-queue.ts             # Failed message retry queue
│   │   │   ├── nostr-relay.ts               # Nostr protocol client
│   │   │   ├── nostr-relay-pool.ts          # Multi-relay management
│   │   │   ├── transport.ts                 # WebRTC + DHT tunneling
│   │   │   ├── virtual-peers-db.ts          # P2P contact storage
│   │   │   ├── nostra-send-bridge.ts      # Route messages to P2P layer
│   │   │   ├── nostra-display-bridge.ts   # Receive P2P messages
│   │   │   └── privacy-transport.ts         # Privacy-preserving relay
│   │   ├── storages/             # Persistence layer
│   │   │   ├── dialogs.ts                   # Chat list with pagination
│   │   │   ├── filters.ts                   # Chat folders/filters
│   │   │   ├── peers.ts                     # Users/chats cache
│   │   │   ├── messages.ts                  # History storage (created per chat)
│   │   │   ├── monoforumDialogs.ts          # Forum topic storage
│   │   │   └── ... (more storage modules)
│   │   ├── rootScope.ts          # Global event bus (500+ event types)
│   │   ├── apiManagerProxy.ts    # API interface for multi-account, workers
│   │   ├── appImManager.ts       # Instant messages UI controller
│   │   ├── internalLinkProcessor.ts         # Deep link handling (t.me, tg://)
│   │   ├── langPack.ts           # i18n/localization
│   │   ├── mainWorker/           # SharedWorker for MTProto (background)
│   │   └── ... (30+ more infrastructure files)
│   ├── stores/                   # Solid.js reactive stores (13 stores)
│   │   ├── appSettings.ts        # User preferences reactive store
│   │   ├── appState.ts           # Global app state (auth, notifications, etc.)
│   │   ├── foldersSidebar.ts     # Sidebar collapse state
│   │   ├── fullPeers.ts          # Full user/chat info signal
│   │   ├── peers.ts              # Peer data reconciliation store
│   │   ├── historyStorages.ts    # Message history signal map
│   │   └── ... (7 more stores)
│   ├── pages/                    # Authentication pages and entry points
│   │   ├── page.ts               # Page base class
│   │   ├── pageSignIn.ts         # Phone number entry
│   │   ├── pageAuthCode.ts       # OTP verification
│   │   ├── pageSignUp.ts         # New account creation
│   │   ├── pagePassword.ts       # 2FA password
│   │   ├── pageSignQR.ts         # QR code login
│   │   ├── nostra/             # Nostra.chat entry
│   │   │   └── onboarding.ts     # P2P messaging onboarding
│   │   └── pagesManager.ts       # Page navigation
│   ├── helpers/                  # Pure utility functions (145+ helpers, 18 subdirs)
│   │   ├── dom/                  # DOM manipulation, event handling
│   │   │   ├── fixSafariStickyInputFocusing.ts
│   │   │   ├── blurActiveElement.ts
│   │   │   └── ... (20+ DOM helpers)
│   │   ├── string/               # String formatting, parsing, sanitization
│   │   │   ├── classNames.ts     # CSS class composition
│   │   │   ├── parseUriParams.ts
│   │   │   └── ... (15+ string helpers)
│   │   ├── array/                # Array utilities: sorting, searching, filtering
│   │   ├── object/               # Object utils: deep merge, deep update
│   │   ├── schedulers/           # Debounce, throttle, RAF batching
│   │   │   ├── debounce.ts
│   │   │   ├── doubleRaf.ts      # Two-frame batching
│   │   │   └── pause.ts
│   │   ├── bigInt/               # BigInt math (for Telegram IDs)
│   │   ├── bytes/                # Binary data handling
│   │   ├── canvas/               # Canvas drawing utilities
│   │   ├── crypto/               # Hashing (no crypto, relies on worker)
│   │   ├── date/                 # Date/time formatting
│   │   ├── color.ts              # Color conversion and manipulation
│   │   ├── mediaSize.ts          # Image/video dimensions
│   │   └── ... (9 more helper modules)
│   ├── hooks/                    # Solid.js hooks (custom reactive logic)
│   │   ├── useIsIntersecting.ts  # Intersection Observer hook
│   │   └── ... (2-3 more hooks)
│   ├── config/                   # Configuration and constants
│   │   ├── app.ts                # App constants: API ID, version, domains
│   │   ├── state.ts              # Application state schema (root structure)
│   │   ├── debug.ts              # Debug flags, MOUNT_CLASS_TO for console access
│   │   ├── modes.ts              # Feature flags (test DCs, no-shared-worker, etc.)
│   │   ├── notifications.ts      # Notification badge paths, icons
│   │   └── ... (more config files)
│   ├── environment/              # Browser feature detection (39 modules)
│   │   ├── userAgent.ts          # User agent parsing: IS_MOBILE, IS_SAFARI, etc.
│   │   ├── touchSupport.ts       # Touch event availability
│   │   ├── emojiSupport.ts       # Emoji rendering support detection
│   │   ├── imageMimeTypesSupport.ts
│   │   ├── videoMimeTypesSupport.ts
│   │   └── ... (34 more environment detectors)
│   ├── scss/                     # Global SCSS stylesheets
│   │   ├── style.scss            # Main stylesheet
│   │   ├── variables.scss        # CSS variables (colors, spacing)
│   │   ├── tappable.scss         # Touch-friendly interactions
│   │   └── ... (more style modules)
│   ├── vendor/                   # Vendored dependencies
│   │   ├── solid/                # Custom fork of Solid.js framework
│   │   └── solid-transition-group/  # Solid.js transition animations
│   ├── tests/                    # Test files (Vitest)
│   │   ├── setup.ts              # Test configuration and fixtures
│   │   └── ... (test files colocated with src/)
│   ├── scripts/                  # Build and code generation scripts
│   │   ├── codegen/              # Generate layer.d.ts from TL schema
│   │   ├── build/                # Vite build scripts
│   │   └── ... (build utilities)
│   ├── lang.ts                   # i18n strings (239KB, all localized text)
│   ├── layer.d.ts                # MTProto TL schema (auto-generated, 667KB)
│   ├── types.d.ts                # Utility types (AuthState, WorkerTask, etc.)
│   ├── global.d.ts               # Global interface augmentations
│   ├── countries.ts              # Country codes and names
│   ├── icons.ts                  # Icon sprite definitions
│   └── emoji_test.js             # Emoji support test data
├── vite.config.ts                # Vite build configuration
├── vitest.config.ts              # Vitest test runner config
├── eslint.config.mjs             # ESLint rules (flat config)
├── tsconfig.json                 # TypeScript compiler options
├── pnpm-lock.yaml                # Locked dependency versions
├── package.json                  # Dependencies, scripts, metadata
├── public/                       # Static assets
│   ├── index.html                # HTML entry point
│   ├── manifest.webmanifest      # PWA manifest
│   └── ... (favicons, service worker)
├── .planning/                    # Documentation (this file)
│   └── codebase/                 # Codebase analysis documents
├── dist/                         # Built output (after `pnpm build`)
└── .env.local.example            # Environment template (secrets not tracked)
```

## Directory Purposes

**src/components/**
- Purpose: All UI components (views, dialogs, controls)
- Contains: .tsx files (Solid.js), .module.scss (scoped styles), .ts utility files
- Key subdirs: `chat/` (message bubbles, input), `sidebarLeft/` (chat list), `sidebarRight/` (info panel), `popups/` (modals)

**src/lib/appManagers/**
- Purpose: Domain business logic (AppManager subclasses)
- Contains: One manager per domain (messages, chats, users, reactions, stickers, etc.)
- Pattern: Each extends AppManager, has API methods and event handlers

**src/lib/mtproto/**
- Purpose: Telegram protocol implementation (socket, crypto, RPC)
- Contains: Connection management, message serialization, auth flow
- Critical: `dcConfigurator.ts` (find data centers), `networker.ts` (TCP socket), `authorizer.ts` (DH auth)

**src/lib/nostra/**
- Purpose: P2P messaging layer integration (new)
- Contains: Identity (keypair), Nostr relay client, Chat API abstraction, offline queue
- Integration: Bridges tweb's Telegram API to decentralized P2P routing

**src/lib/storages/**
- Purpose: IndexedDB persistence layer
- Contains: Storage schema classes (DialogsStorage, FiltersStorage, PeersStorage, etc.)
- Pattern: Lazy-load on first access, cache in memory, persist on updates

**src/pages/**
- Purpose: Authentication flow pages
- Contains: Login page, phone input, OTP verification, QR code, 2FA password
- Pattern: Extend Page base class, manage form state and validation

**src/stores/**
- Purpose: Reactive signal stores (Solid.js)
- Contains: createSignal pairs wrapped in rootScope listeners
- Pattern: Export hook (useHookName) that returns signal, updates on events

**src/config/**
- Purpose: Configuration constants and schema
- Contains: API credentials, app version, feature flags, notification settings
- Critical: `app.ts` (API ID/hash, version), `state.ts` (state schema), `debug.ts` (debug flags)

**src/environment/**
- Purpose: Browser capability detection
- Contains: User agent parsing, feature detection modules
- Used by: Feature gates, CSS class application, polyfill selection

**src/helpers/**
- Purpose: Reusable pure utility functions
- Contains: 145+ helpers across 18 subdirectories
- Examples: `classNames()` for CSS composition, `debounce()` for event throttling, `copy()` for deep cloning

**src/scss/**
- Purpose: Global stylesheets
- Contains: CSS variables (theming), global classes, responsive utilities
- Pattern: BEM-like naming, component styles in .module.scss

**src/vendor/**
- Purpose: Forked dependencies
- Contains: Custom Solid.js build, solid-transition-group
- Critical: `solid/` is custom fork (used instead of npm solid-js)

## Key File Locations

**Entry Points:**
- `src/index.ts`: Main app initialization, bootstrap, app state loading
- `src/pages/pageSignIn.ts`: Authentication entry (if not logged in)
- `src/lib/nostra/identity.ts`: P2P identity setup (called from index.ts)

**Configuration:**
- `src/config/app.ts`: API credentials, app constants
- `src/config/state.ts`: Root application state schema
- `src/config/debug.ts`: Debug flags, console access (MOUNT_CLASS_TO)
- `vite.config.ts`: Build configuration, path aliases
- `src/lang.ts`: All i18n strings (239KB file)

**Core Infrastructure:**
- `src/lib/rootScope.ts`: Global event bus (500+ event types)
- `src/lib/apiManagerProxy.ts`: API interface for multi-account support
- `src/lib/appImManager.ts`: Instant messages UI controller
- `src/lib/mainWorker/`: SharedWorker for background MTProto

**Domain Managers:**
- `src/lib/appManagers/appMessagesManager.ts`: Messages (362KB, largest manager)
- `src/lib/appManagers/appChatsManager.ts`: Chat metadata and permissions
- `src/lib/appManagers/appUsersManager.ts`: User profiles and contacts
- `src/lib/appManagers/apiManager.ts`: Telegram RPC API invocation
- `src/lib/appManagers/apiUpdatesManager.ts`: Process incoming updates

**Storage Layer:**
- `src/lib/storages/dialogs.ts`: Chat list with pagination
- `src/lib/storages/peers.ts`: Users/chats cache
- `src/lib/storages/messages.ts`: Message history (created per chat)
- `src/lib/storages/filters.ts`: Chat folder definitions

**P2P Integration (Nostra.chat):**
- `src/lib/nostra/chat-api.ts`: Chat API abstraction for P2P
- `src/lib/nostra/nostr-relay.ts`: Nostr protocol client
- `src/lib/nostra/offline-queue.ts`: Failed message retry queue
- `src/lib/nostra/virtual-peers-db.ts`: P2P contact storage
- `src/lib/nostra/nostra-send-bridge.ts`: Route to P2P layer
- `src/lib/nostra/nostra-display-bridge.ts`: Receive P2P messages

**Reactive Stores:**
- `src/stores/appState.ts`: Global app state (auth, notifications)
- `src/stores/appSettings.ts`: User preferences
- `src/stores/historyStorages.ts`: Message history signal map
- `src/stores/peers.ts`: Peer reconciliation store

**Testing:**
- `vitest.config.ts`: Test configuration
- `src/tests/setup.ts`: Test environment setup
- Test files colocated with source (e.g., `src/helpers/string/__tests__/`)

## Naming Conventions

**Files:**
- Components: `PascalCase.tsx` if exported as default, camelCase.ts for internal utilities
  - Example: `src/components/chat/bubbles/service.tsx` (exported), `src/components/appSearch.ts` (utility)
- Managers: `app[Domain]Manager.ts`
  - Example: `appMessagesManager.ts`, `appChatsManager.ts`
- Stores: `camelCaseName.ts`
  - Example: `foldersSidebar.ts`, `historyStorages.ts`
- Styles: `[name].module.scss` for scoped, `[name].scss` for global
  - Example: `src/components/chat/bubbles/service.module.scss`
- Helpers: `camelCaseName.ts` or `folder/camelCaseName.ts`
  - Example: `src/helpers/dom/blurActiveElement.ts`, `src/helpers/array/forEachReverse.ts`

**Directories:**
- Components: `camelCase` or `camelCaseFolder/`
  - Example: `sidebarLeft/`, `emoticonsDropdown/`, `chat/`
- Managers: `appManagers/`
- Helpers: `helpers/[category]/`
  - Example: `helpers/dom/`, `helpers/string/`, `helpers/array/`
- Stores: `stores/` (flat)
- Config: `config/`

**TypeScript Naming:**
- Types: `PascalCase` or use alias from `@layer`
  - Example: `type MyDialog = Dialog`, `interface AppConfig {}`
- Functions: `camelCase`
  - Example: `getDialogKey()`, `sendText()`, `createHistoryStorage()`
- Constants: `UPPER_SNAKE_CASE`
  - Example: `MESSAGES_ALBUM_MAX_SIZE`, `FOLDER_ID_ALL`
- Private fields: `_camelCase` (convention, no true private in JS)
  - Example: `_middleware`, `_subscriptions`

## Where to Add New Code

**New Feature (e.g., polls):**
- Primary logic: `src/lib/appManagers/appPollsManager.ts` (AppManager subclass)
- UI component: `src/components/poll.ts` or `src/components/popups/pollResult.tsx`
- Tests: `src/lib/appManagers/__tests__/appPollsManager.test.ts`
- Helpers (if shared): `src/helpers/polls/` (new subdir)
- i18n: Add string keys to `src/lang.ts`
- RPC types: Already in `src/layer.d.ts` (auto-generated)

**New Component/Dialog:**
- Implementation: `src/components/[name]/` (new dir) or `src/components/[name].tsx`
- Styles: `src/components/[name]/index.module.scss`
- Call from UI: Import and use in parent component
- Stores (if reactive): Export store hook from `src/stores/[name].ts`

**New Utility/Helper:**
- Shared helpers: `src/helpers/[category]/[name].ts`
- If pure function: No dependencies on managers or stores
- If math/string: Add to appropriate category subdirectory
- If DOM: Add to `src/helpers/dom/`
- If array/object: Add to `src/helpers/array/` or `src/helpers/object/`

**P2P Message Routing:**
- Detect virtual peer: Check `isVirtualPeer(peerId)` in `appMessagesManager.sendText()`
- Route to Chat API: Call `sendTextViaChatAPI()` from `src/lib/nostra/nostra-send-bridge.ts`
- Nostr publishing: Handled by `chat-api.ts`, publishes to relay pool
- Receive side: `nostra-display-bridge.ts` listens to relays, calls `appMessagesManager.addToHistory()`

**New Manager:**
- Extend AppManager: `export class App[Domain]Manager extends AppManager {}`
- Implement lifecycle: `protected after() { /* set up subscriptions */ }`
- Inject dependencies: Via constructor (handled by ManagersManager)
- Export: Add to `managers.d.ts` interface
- Register: Added automatically by `createProxiedManagersForAccount()`

## Special Directories

**src/lib/mainWorker/**
- Purpose: SharedWorker implementation (runs in background)
- Generated: Yes (code runs in worker thread, not main thread)
- Committed: Yes (checked in)
- Contains: MTProto message handling, crypto delegation

**src/lib/mtproto/**
- Purpose: Telegram protocol implementation
- Generated: No (hand-written)
- Committed: Yes
- Critical: Data center configuration, network socket, crypto auth

**src/vendor/**
- Purpose: Forked npm packages (custom builds)
- Generated: Yes (built from solid-js source)
- Committed: Yes (committed as dist)
- Update: Manual, requires rebuild

**dist/**
- Purpose: Production build output
- Generated: Yes (output of `pnpm build`)
- Committed: No (.gitignored)
- Contents: Bundled HTML, CSS, JS, service worker

**node_modules/**
- Purpose: npm dependencies
- Generated: Yes (by pnpm install)
- Committed: No (.gitignored)
- Lock: `pnpm-lock.yaml` (committed for reproducibility)

---

*Structure analysis: 2026-03-31*
