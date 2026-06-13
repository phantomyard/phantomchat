# Technology Stack

**Analysis Date:** 2026-03-31

## Languages

**Primary:**
- TypeScript 5.7 - All source code in `src/` is written in TypeScript with strict type checking
- SCSS (Sass) 1.69.6 - Styling for UI components using `.module.scss` pattern for scoped styles

**Secondary:**
- JavaScript (Node.js) - Build scripts and dev tooling in `src/scripts/`, `vite.config.ts`, `eslint.config.mjs`
- HTML - Template files processed by `vite-plugin-handlebars` for dynamic title/description

## Runtime

**Environment:**
- Browser (ES2015+ target, ES2020 module output)
- Web Workers (SharedWorker, ServiceWorker, dedicated Workers)
- Node.js 18+ - For build scripts and development server

**Package Manager:**
- pnpm 9.15.3 - Lockfile: `pnpm-lock.yaml` (enforced via `preinstall` script in `package.json`)

## Frameworks

**Core:**
- Solid.js 1.9.11 - Reactive UI framework (custom fork in `src/vendor/solid/` used for production)
- @solid-primitives/transition-group 1.0.3 - Animation utilities for Solid components

**Build/Dev:**
- Vite 5.2.10 - Dev server and production bundler (`vite.config.ts`)
  - vite-plugin-solid 2.8.0 - JSX compilation for Solid.js
  - vite-plugin-handlebars 1.6.0 - HTML template processing for manifest metadata
  - rollup-plugin-visualizer 5.12.0 - Bundle analysis (`whybundled` command)
  - @vitejs/plugin-basic-ssl 1.1.0 - HTTPS support for dev server

**Testing:**
- Vitest 0.34.6 - Test runner with jsdom environment
  - @playwright/test 1.58.2 - E2E testing framework (integration tests)
  - fake-indexeddb 6.2.5 - In-memory IndexedDB for tests

**Code Quality:**
- ESLint 9.20.0 with @typescript-eslint plugins - TypeScript linting
- autoprefixer 10.4.16 - CSS vendor prefixing (PostCSS plugin in vite.config.ts)

## Key Dependencies

**Critical:**
- Solid.js - Custom fork in `src/vendor/solid/` (built from custom modifications, resolves as alias in tsconfig)
- solid-transition-group - Transition management, forked in `src/vendor/solid-transition-group/`

**Cryptography:**
- @noble/secp256k1 3.0.0 - ECDSA signature verification for Nostr relay protocol (NIP-04 encryption)
- @cryptography/aes 0.1.1 - AES encryption (MTProto crypto)
- @cryptography/sha1 0.2.0 - SHA-1 hashing (MTProto key derivation)
- @cryptography/sha256 0.2.0 - SHA-256 hashing (identity seed derivation)
- @peculiar/webcrypto 1.4.3 - Web Crypto API polyfill for secure random/KDF

**Protocol & Networking:**
- Custom MTProto implementation in `src/lib/mtproto/` - Telegram's binary protocol
- Custom Nostr relay client in `src/lib/nostra/nostr-relay.ts` - NIP-04 encrypted messages
- Custom privacy transport in `src/lib/nostra/privacy-transport.ts` - Tor/Webtor abstraction

**Media & Compression:**
- hls.js 1.5.18 - HLS streaming for video playback
- mp4-muxer 5.1.3 - MP4 video encoding/container support
- fflate 0.8.2 - DEFLATE compression/decompression
- fast-png 6.2.0 - PNG encoding for image processing
- mime 3.0.0 - MIME type detection for files

**Utilities:**
- emoji-regex 10.6.0 - Unicode emoji detection and parsing
- big-integer 1.6.52 - Arbitrary precision arithmetic (DH key computation)
- qr-code-styling 1.5.0 - QR code generation for login
- tinyld 1.3.4 - Language detection for RTL text handling
- punycode 2.3.1 - Internationalized domain name encoding
- bezier-easing 3.0.0 - Animation easing functions
- prismjs 1.29.0 - Syntax highlighting for code display
- browserslist 4.22.2 - Browser compatibility targeting

**Development Utilities:**
- @babel/cli 7.23.4, @babel/preset-env 7.23.7, @babel/preset-typescript 7.23.3 - Babel transpilation
- @types/chrome 0.0.183 - Chrome extension API types (for PWA)
- @types/dom-webcodecs 0.1.13 - WebCodecs API types
- @types/express 4.17.21, @types/prismjs 1.26.3 - Third-party type definitions
- typescript-eslint 8.24.0 - TypeScript ESLint parser and plugin
- jsdom 22.1.0 - DOM implementation for test environment
- globals 15.14.0 - Global variable definitions
- csstype 3.1.3 - CSS type definitions
- vite-plugin-checker 0.8.0 - TypeScript type checking during dev

**Server (Development):**
- Express.js 4.18.2 - HTTP server for `serve` command
- compression 1.7.4 - Gzip compression middleware
- http-proxy 1.18.1 - Proxy middleware for reverse proxying
- node-ssh 13.1.0 - SSH client (deployment automation)

## Configuration

**Environment:**
- `.env.local.example` (copied to `.env.local` on first dev startup) - Development configuration
- `src/langPackLocalVersion.ts` - Language pack version tracking (copied from `.example.ts` on startup)
- Variables loaded via import, not process.env - app is standalone, no server-side config

**Build:**
- `vite.config.ts` - Primary Vite build configuration
  - TypeScript compilation targets ES2015 (execution) / ES2020 (modules)
  - Source maps enabled for debugging
  - CSS DevSourcemap enabled for SCSS debugging
- `tsconfig.json` - TypeScript compiler options
  - Path aliases: `@components/`, `@helpers/`, `@lib/`, `@layer`, `@types` etc.
  - JSX resolution: `jsxImportSource: solid-js`
  - Strict mode enabled except `strictNullChecks: false` and `strictPropertyInitialization: false`
- `eslint.config.mjs` - Flat ESLint config enforcing style rules
- `.prettierrc` - Code formatter (if present)

**Manifest & Assets:**
- `site.webmanifest` and `site_apple.webmanifest` - PWA manifest (selected via `IS_APPLE` at runtime)
- `public/` directory - Static assets (favicons, WASM modules, WebTor WASM, Tor WASM)

## Platform Requirements

**Development:**
- Node.js 18+ (pnpm requires this)
- pnpm 9.15.3+ (enforced by `preinstall` script)
- Modern browser with ES2015+ support
- Chrome extension APIs for PWA support (optional)

**Production:**
- Modern browser with ES2015+ support
- Web Worker support (SharedWorker or dedicated Worker)
- IndexedDB + localStorage for state persistence
- Service Worker for offline functionality and push notifications
- WebRTC (for Snowflake Tor bridge in webtor-rs)
- SubtleCrypto API (Web Crypto standard)
- Deployed to web server or CDN (static files in `dist/`)

---

*Stack analysis: 2026-03-31*
