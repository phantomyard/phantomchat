# Phase 1: Build Pipeline & Distribution - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

Production build working with all vendor stubs replaced, TypeScript checker re-enabled, and PWA deployable from multiple mirrors (Cloudflare Pages, GitHub Pages, IPFS) for censorship resistance. No new features — this phase makes the existing codebase shippable.

</domain>

<decisions>
## Implementation Decisions

### Vendor Stubs Strategy
- Prioritize stubs critical for v1 messaging UX; non-critical stubs (opus audio decoder, libwebp image decoder) can remain as graceful no-ops since v1 is relay-only text/media (no WebRTC audio/video streaming)
- Critical stubs to replace: emoji (needed for chat), solid-transition-group (UI polish), fastBlur (media display), bezierEasing (animations), convertPunycode (domain handling), prism (code blocks)
- opus.ts and libwebp-0.2.0.ts: keep as stubs with proper no-op behavior (return empty data) — these are needed for voice messages and WebP decoding which are v2 concerns

### Emoji Approach
- Claude's discretion — decide between native OS emoji or bundled emoji set based on what tweb currently expects and what gives best cross-platform consistency with minimal bundle size

### Animation/Transitions
- Claude's discretion — balance between full solid-transition-group reimplementation vs lightweight CSS-only transitions. Aim for Telegram-like polish where it matters (chat transitions, panel slides) without over-engineering

### IPFS Distribution
- Gateway HTTP links (https://ipfs.io/ipfs/CID...) as primary access for all users
- Claude's discretion on pinning approach — Fleek (managed) vs self-pin, whichever is more practical for automated deploys

### Mirror Strategy
- Three mirrors at launch: Cloudflare Pages, GitHub Pages, IPFS gateway
- No VPS mirror in Phase 1 (VPS is for future self-hosted option)
- Claude's discretion on CI/CD approach — GitHub Actions preferred for automation (push to main → build → deploy all mirrors)

### TypeScript Checker
- Claude's discretion — re-enable TypeScript checker gradually, fixing critical errors and using targeted suppressions for vendor-related issues. Goal: checker passes in CI, no silent type errors in Nostra.chat source code

### Build Configuration
- Vite base path must be `./` (relative) — already partially configured (`base: ''`), needs verification
- `copyPublicDir: true` already set (M005/S04 fix)
- Source maps enabled for production debugging
- No absolute origin-specific URLs in build output

### Claude's Discretion
- Emoji implementation approach (native vs bundled)
- Solid-transition-group: full reimplementation vs CSS-only
- IPFS pinning service choice (Fleek vs manual)
- CI/CD pipeline design (GitHub Actions workflow)
- TypeScript error remediation strategy
- Which vendor stubs get real implementations vs improved no-ops
- Build optimization settings

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Service Worker** (`src/lib/serviceWorker/index.service.ts`): Fully implemented with caching, push notifications, stream handling. Already registered via `apiManagerProxy.ts`
- **PWA Manifest** (`public/site.webmanifest`): Complete Nostra.chat-branded manifest with icons (36x36 to 512x512), `start_url: "./"`, `display: "standalone"`
- **Vite config** (`vite.config.ts`): Mature build config with plugins, aliases, worker format. `copyPublicDir: true` already set

### Established Patterns
- **Vendor alias**: `@vendor/*` → `src/vendor/` — all vendor imports go through this alias
- **WASM modules**: Expected at `public/tor-wasm/` and `public/webtor/` — aliased in vite.config.ts
- **vite-plugin-checker**: Currently `typescript: false`, ESLint enabled with flat config
- **Build pipeline**: `pnpm run generate-changelog && vite build`

### Integration Points
- Vendor stubs are imported via `@vendor/*` aliases throughout the codebase
- Service worker registered in `apiManagerProxy.ts` lines 654-709
- Manifest linked dynamically in `index.html` via `<link rel="manifest" id="manifest">`
- Build output goes to `dist/` directory

</code_context>

<specifics>
## Specific Ideas

- User wants IPFS access both via HTTP gateway (for anyone) and decentralized domain (for power users)
- Censorship resistance is a core value — the same build must work from any origin without modification
- Three mirrors (Cloudflare Pages, GitHub Pages, IPFS) provide redundancy against domain seizure

</specifics>

<deferred>
## Deferred Ideas

- ENS/HNS decentralized domain for IPFS — requires Ethereum wallet + gas fees, too complex for Phase 1. Defer to future phase.

</deferred>

---

*Phase: 01-build-pipeline-distribution*
*Context gathered: 2026-04-01*
