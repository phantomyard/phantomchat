# Codebase Concerns

**Analysis Date:** 2026-03-31

## Tech Debt

**Large monolithic files:**
- Files: `src/components/chat/bubbles.ts` (10,595 lines), `src/lib/appManagers/appMessagesManager.ts` (10,722 lines), `src/components/chat/input.ts` (4,872 lines)
- Issue: These files have grown to unwieldy sizes with complex state management and multiple responsibilities
- Impact: Difficult to test, refactor, or maintain; slow IDE performance; high cognitive load for modifications
- Fix approach: Break into smaller modules with clear boundaries (e.g., separate message rendering, input handling, bubble lifecycle management)

**TODO/FIXME debt (71+ comments):**
- Files scattered throughout codebase: `src/lib/storage.ts:286`, `src/lib/crypto/cryptoMessagePort.ts:29`, `src/lib/richTextProcessor/wrapRichText.ts:182`, `src/lib/appDialogsManager.ts:1915`, `src/lib/calls/groupCallsController.ts:225`, and many more
- Issue: Accumulated unaddressed comments indicating incomplete features, deferred refactorings, and known issues
- Impact: Risk of regressions, unmaintained functionality that breaks silently
- Fix approach: Audit all TODO/FIXME comments, create issues for each, prioritize by impact, track completion

## Known Bugs & Workarounds

**Chromium canvas bug (line 740):**
- Files: `src/lib/appImManager.ts:740-759`
- Problem: Chromium bug #328755781 - canvases become corrupted when page visibility changes
- Symptoms: Visual artifacts on canvas elements (likely affecting chat bubbles, animations, media viewers)
- Current mitigation: Redraw a 1x1 rect on visibility change to reset canvas state
- Risk: Workaround is fragile and may not work in future Chromium versions
- Improvement path: Monitor Chromium bug status; file compatibility tests with each Chromium release

**Safari sticky input focus bug:**
- Files: `src/helpers/dom/fixSafariStickyInputFocusing.ts`, `src/index.ts:158`, `src/components/chat/input.ts:2554`
- Problem: Safari mobile's sticky positioning breaks on input focus with viewport height changes
- Symptoms: Input jumping, viewport flickering on iOS Safari
- Current mitigation: Feature flag `IS_STICKY_INPUT_BUGGED` disabled (set to `false`)
- Risk: Code exists but disabled - indicates incomplete fix or that regression potential remains
- Improvement path: Re-enable with comprehensive iOS Safari testing, potentially use viewport-fit CSS

**Media transcription stubs:**
- Files: `src/components/chat/bubbles.ts:1038`, `src/lib/appManagers/appMessagesManager.ts:9586`
- Problem: Voice transcription logic present but incomplete in UI thread
- Symptoms: Messages may not show transcription status correctly
- Current mitigation: Calls to `transcribeAudio` exist but error handling is minimal (`.catch(noop)`)
- Risk: Silent failures; users don't know transcription failed
- Improvement path: Add proper error UI, user notifications, retry logic

## Fragile Areas

**Chat bubbles rendering (10,595 lines):**
- Files: `src/components/chat/bubbles.ts`
- Why fragile: Single file handles message rendering, animations, interactions, search highlighting, reactions, forwarding, editing, replies, media viewing. Changes to one feature can break others.
- Test coverage: No unit tests for bubbles rendering (test files exist for components but not for this core renderer)
- Safe modification: Always test with different message types (text, media, forwards, replies, grouped messages, service messages) across mobile/desktop viewports
- Risk areas: Group rendering logic (line 228), animation state during renders, scroll position preservation

**Input field with state management (4,872 lines):**
- Files: `src/components/chat/input.ts`
- Why fragile: Handles typing, editing, replies, drafts, suggestions, file uploads, voice messages - all with complex state interdependencies
- Issue comment: Line 3689 has `/* TODO: review this || true WTF? */` - unclear feature flag logic that could be accidentally changed
- Safe modification: Mock `appMessagesManager` and `appChatsManager` fully; test draft persistence independently
- Test coverage: Partial - add/edit peer dialog tested but not core input lifecycle

**App state initialization (157 lines, but critical):**
- Files: `src/index.ts`
- Why fragile: Multiple browser compatibility fixes (favicon hacks, font loading, viewport height, passcode lock) and auth initialization sequenced together
- Issue: Silent error handling - `catch(err) {}` at lines 99 and 118 with no logging
- Safe modification: Log all caught errors; add feature detection tests before each fix
- Risk: Page fails to initialize silently if any step breaks

**Nostra.chat messaging bridge (new code):**
- Files: `src/lib/nostra/chat-api.ts`, `src/lib/nostra/offline-queue.ts`, `src/lib/nostra/nostra-send-bridge.ts`, `src/lib/nostra/nostra-display-bridge.ts`
- Why fragile: New integration between Nostr relay pool, offline queue, identity, and chat UI
- Issue: LRU cache in `nostra-send-bridge.ts` (max 100 entries) could cause virtual peer lookups to fail if many peers are active
- Issue: IndexedDB error handling in `offline-queue.ts` uses `.catch(() => {})` at multiple points
- Issue: No mechanism to detect stale cache entries if peers are deleted
- Safe modification: Add integration tests for peer creation → message send → relay publish flow; test cache eviction
- Risk: Message delivery failures silent if IndexedDB or relay pool state diverges

**Virtual peers database:**
- Files: `src/lib/nostra/virtual-peers-db.ts`
- Why fragile: Single source of truth for peer ID mapping that affects message routing
- Issue: No transaction management for concurrent access - could corrupt peer mappings
- Safe modification: Add mutex/lock for writes; test concurrent peer operations
- Test coverage: Some unit tests exist but no integration tests with actual chat operations

**Message action text rendering:**
- Files: `src/components/wrappers/messageActionTextNewUnsafe.ts` (file name suggests danger)
- Why fragile: Complex conditional rendering of service messages (joins, leaves, settings changes, forum topics, etc.)
- Issue: Uses variable name `TODO_JOIN_OPTIONS` (line 85) - unclear if intentional placeholder or mistake
- Risk: Service messages could display incorrectly, confusing users about what happened in chat
- Safe modification: Create comprehensive test fixtures for each service message type

## Error Handling Gaps

**Silent error swallowing (30+ locations):**
- Pattern: `.catch(noop)` or `.catch(() => {})` or `catch(err) {}`
- Files: `src/helpers/dom/loadFonts.ts:56`, `src/helpers/dom/handleVideoLeak.ts:140`, `src/helpers/dom/safePlay.ts:7`, `src/components/appSearchSuper.ts:190,799`, `src/index.ts:99,118`, and many more
- Impact: Promise rejections disappear silently; impossible to debug failures
- Fix approach: Log all caught errors at minimum; categorize by severity (expected vs. unexpected); surface to telemetry

**Async operations without timeout:**
- Files: `src/lib/nostra/offline-queue.ts`, `src/lib/nostra/chat-api.ts`
- Problem: IndexedDB operations don't have timeout protection
- Impact: If IndexedDB hangs (rare but possible), entire message queue could hang indefinitely
- Fix approach: Add configurable timeouts (default 5s) to all IndexedDB operations

**Relay pool connection failures:**
- Files: `src/lib/nostra/nostr-relay-pool.ts`
- Problem: No maximum retry count; could retry forever and drain battery
- Impact: Degraded message delivery on unstable networks
- Fix approach: Implement exponential backoff with maximum retry count

## Performance Bottlenecks

**Message history loading:**
- Problem: `appMessagesManager.ts` loads entire history slices into memory
- Files: `src/lib/appManagers/appMessagesManager.ts:7366,7933`, `src/lib/storages/dialogs.ts`
- Cause: No pagination or virtual scrolling for message history; all loaded messages kept in RAM
- Impact: Mobile browsers with large chats (1000+ messages) become laggy; memory usage scales with chat size
- Improvement path: Implement message window (keep only visible + buffer); stream older messages to IndexedDB-only mode

**Search index updates:**
- Problem: Search index rebuilt on every message change
- Files: `src/lib/appManagers/appMessagesManager.ts` (many search-related methods)
- Impact: Noticeable lag when sending/receiving messages in large chats
- Improvement path: Use incremental indexing; debounce index updates; offload to service worker

**Dialog list rendering:**
- Problem: All dialogs rendered in single scrollable list even with 1000+ chats
- Files: `src/lib/appDialogsManager.ts`, `src/components/chat/bubbles.ts`
- Impact: Initial page load slow for users with many chats
- Improvement path: Virtual scrolling (already attempted based on TODO comments); investigate incomplete implementation

**Avatar image downloads:**
- Files: `src/helpers/dom/renderImageFromUrl.ts:68`
- Issue: Avatar images downloaded synchronously before animation starts (line 68 TODO comment)
- Impact: Visible lag when opening profiles; animations jank
- Improvement path: Pre-load avatars in background; show placeholder during load

**Canvas redraw on visibility change:**
- Files: `src/lib/appImManager.ts:740-759`
- Problem: Every canvas element redrawn on every visibility change (common with browser tab switching)
- Impact: Battery drain on mobile; wasted CPU cycles
- Improvement path: Only redraw canvases that are actually visible; debounce visibility changes

## Scaling Limits

**IndexedDB message storage:**
- Current capacity: Browser IndexedDB quota typically 10-50% of available disk space
- Limit: Users with 100k+ messages hit quota; app fails to cache new messages
- Scaling path: Implement message pruning (oldest messages deleted after 6 months); move stale data to server-side archive
- Risk: No warning when quota is approaching; users face sudden "disk full" errors

**Virtual peers LRU cache:**
- Files: `src/lib/nostra/nostra-send-bridge.ts:27`
- Current capacity: 100 entries
- Limit: Power users with 100+ simultaneous P2P chats will have constant cache misses
- Scaling path: Use WeakMap or implement persistent local cache; profile actual usage patterns
- Risk: Performance degradation is silent (not obvious to user why messages take longer)

**Offline message queue:**
- Files: `src/lib/nostra/offline-queue.ts`
- Current capacity: Unbounded in memory + IndexedDB
- Limit: Power users who queue thousands of messages may run out of IndexedDB quota
- Scaling path: Implement queue size limits; implement message deduplication; discard oldest messages if quota exceeded
- Risk: Data loss if queue exceeds quota without user awareness

**Multi-tab coordination:**
- Files: `src/lib/singleInstance` (referenced in CLAUDE.md)
- Issue: Multiple tabs compete for resources; unclear what happens if quota is exceeded in one tab
- Scaling path: Coordinator tab should manage shared IndexedDB quota; other tabs notify coordinator before writing

## Dependencies at Risk

**Solid.js custom fork:**
- Files: `src/vendor/solid/`
- Risk: Forked from upstream; will not receive fixes/security updates
- Impact: Solid.js bugs become custom problems to fix
- Reason for fork: Likely due to Nostra.chat's specific optimization needs
- Migration plan: Periodically merge upstream changes; eventually contribute optimizations back to Solid.js

**MTProto implementation:**
- Files: `src/lib/mtproto/`, `src/layer.d.ts` (664KB auto-generated)
- Risk: Custom MTProto implementation is security-critical; any bugs in encryption/encoding could leak data
- Current status: Mature (used by web.telegram.org for years) but no external audit mentioned
- Recommendation: Regular security audits; input fuzzing tests; compliance verification with Telegram's protocol spec

**Nostr relay pool (new):**
- Files: `src/lib/nostra/nostr-relay-pool.ts`
- Risk: New code, relay protocol maturity varies by implementation
- Issue: No timeout on relay handshake; no validation of relay responses
- Recommendation: Implement strict timeouts; validate all messages from relays; test with malicious/broken relays

## Security Considerations

**Encryption key handling:**
- Files: `src/lib/nostra/`, `src/lib/crypto/`
- Risk: Private keys for Nostr messaging must never be logged or stored unencrypted
- Current approach: Not fully clear from code review (need to check crypto implementation)
- Recommendation: Audit key storage; use `SecureContext` where available; implement automatic key rotation

**IndexedDB data at rest:**
- Files: `src/lib/encryptedStorageLayer.ts`, `src/lib/nostra/offline-queue.ts`
- Risk: Offline queue stores messages in IndexedDB, which is not encrypted by browser by default
- Current mitigation: `encryptedStorageLayer.ts` exists but unclear if applied to offline queue
- Recommendation: Verify all sensitive data in IndexedDB is encrypted; test with DevTools (data should be unreadable)

**XSS in rich text:**
- Files: `src/lib/richTextProcessor/wrapRichText.ts`, `src/components/wrappers/messageActionTextNewUnsafe.ts` (file name suggests concerns)
- Risk: User-provided message text rendered as HTML; entity parsing is critical
- Current approach: Uses `setInnerHTML` with entity parsing; has `setDirection` safety wrapper
- Recommendation: Regular security review of entity parsing; fuzzing with malicious message payloads; consider using plain text rendering for untrusted sources

**Replay attack in Nostr messaging:**
- Files: `src/lib/nostra/nostr-relay.ts`
- Risk: Nostr messages include timestamps; older messages could be replayed
- Recommendation: Implement nonce tracking; reject messages older than tolerance window; verify relay ordering

**CSRF/XSRF in web view operations:**
- Files: `src/lib/appImManager.ts:815-1014` (bot web view handling)
- Risk: Bot web views can request user data/actions; must validate origin
- Current mitigation: Uses `confirmedWebViews` state to track which bots user approved
- Recommendation: Verify origin checks are strict; test with cross-origin bot URLs

## Test Coverage Gaps

**Bubbles rendering:**
- What's not tested: Message rendering lifecycle, animation coordination, search highlighting, media loading, reaction animations
- Files: `src/components/chat/bubbles.ts`
- Risk: Changes to rendering logic break silently; users experience visual glitches
- Priority: High - core UI feature
- Approach: Create component tests for each message type; snapshot tests for message structure

**Input field state machine:**
- What's not tested: Draft persistence across tab switch, edit/reply mode transitions, file upload error handling, voice message recording cancellation
- Files: `src/components/chat/input.ts`
- Risk: Edge cases in message editing break without warning
- Priority: High - affects message sending reliability
- Approach: Unit tests for state transitions; integration tests with appMessagesManager

**Offline queue flushing:**
- What's not tested: Queue ordering, deduplication, error recovery, quota exhaustion, recovery from IndexedDB errors
- Files: `src/lib/nostra/offline-queue.ts`
- Risk: Message loss or duplication on network recovery
- Priority: High - data integrity issue
- Approach: Integration tests with simulated network failures; chaos testing with IndexedDB errors

**Virtual peer lifecycle:**
- What's not tested: Peer creation → message send → display → deletion flow; concurrent peer operations
- Files: `src/lib/nostra/virtual-peers-db.ts`, `src/lib/nostra/nostra-send-bridge.ts`
- Risk: Orphaned peers, stale mappings, message routing to wrong peer
- Priority: High - new feature, limited test coverage
- Approach: End-to-end tests; concurrent stress tests

**Relay pool failover:**
- What's not tested: Relay connection failures, timeout handling, fallback to secondary relays, recovery
- Files: `src/lib/nostra/nostr-relay-pool.ts`
- Risk: Message delivery failures on unstable networks
- Priority: Medium - reliability feature
- Approach: Inject network failures; test timeout behavior; verify fallover works

**MTProto compatibility:**
- What's not tested: Updated MTProto protocol versions, new API methods, backward compatibility
- Files: `src/layer.d.ts`, `src/lib/mtproto/`
- Risk: Server API changes break client
- Priority: Medium - managed by Telegram
- Approach: Property-based testing of message encoding/decoding; compatibility matrix tests

## Missing Critical Features

**User presence indicators (draft state):**
- Problem: No indication if peer is online/typing in Nostr-based chats
- Blocks: Can't show "typing" indicators, last-seen status
- Workaround: Users must infer from message timestamps
- Priority: Medium - improves UX significantly
- Implementation path: Extend Nostr protocol with heartbeat messages; implement typing detection

**Message read receipts:**
- Problem: No way to know if message was read by recipient in Nostr chats
- Blocks: Can't implement read confirmations, "seen at" timestamps
- Workaround: None - users must assume message reached recipient
- Priority: High - expected feature in modern chat apps
- Implementation path: Add receipt event type to Nostr relay; track delivery and read status

**Message search in P2P chats:**
- Problem: Search likely doesn't work across Nostr messages (not stored in Telegram index)
- Blocks: Can't search P2P message history
- Priority: Medium - nice-to-have feature
- Implementation path: Build local search index of Nostr messages; sync with server index

**Typing indicators:**
- Problem: No indication when peer is typing in Nostr chats
- Blocks: Reduces interactive feel of chat
- Priority: Low - nice-to-have feature
- Implementation path: Broadcast "typing" events via relay; display with timeout

---

*Concerns audit: 2026-03-31*
