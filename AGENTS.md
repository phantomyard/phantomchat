# AGENTS.md — PhantomChat

Authoritative design rules for anyone (human or AI agent) changing this repo.
For build/test commands, code style, path aliases, and harness specifics see
[`CLAUDE.md`](CLAUDE.md); for subsystem rules see
[`docs/CLAUDE-RULES.md`](docs/CLAUDE-RULES.md). This file is about **how the app
must behave and how it must be architected** — read it before touching the
message send/receive, chat-switch, storage, or worker code.

## HARD RULE — review findings are fixed in the PR, never filed for later

Binding on every agent (Kai, Lena, Omar, Robbie, Atlas, Max, Jake, any other) on every PR. Only the human principal can grant an exception, in writing, on the PR. This rule beats any older habit, template or procedure that says otherwise.

- **Every review finding gets exactly one of two outcomes.** It's either **blocking**, so it gets fixed in this PR before approval, or it's **dropped**, because it isn't worth fixing. Say that in one line or don't mention it. There is no third outcome. "Non-blocking, follow-up", "filed as #NNN", "parked for a later PR" and "tracked separately" are all forbidden.
- **Agents never open an issue without the principal's explicit OK.** This covers reviews, PR descriptions, ticks, pollers and triage. If you find a real bug in existing code outside the PR's scope, ask the principal in chat first, and only open the issue if they say yes.
- **Follow-up PRs can't spawn more follow-ups.** Their findings get fixed in them or dropped.
- **Nits are never blockers and never issues.** That covers style, naming, wording, comment polish and "could be cleaner". Drop them.
- **Don't widen scope during review.** A PR fixes what it says it fixes. A finding that would need a separate change is either blocking, so it gets fixed here, or dropped.
- **Only approve when nothing is left open.** An approval that lists leftovers is not an approval.

Why: review leftovers filed as issues turned every feature into a queue of follow-ups. Each one then needed its own PR and review, which filed more follow-ups. Fix it once, in the PR, or let it go.

## What this repo is

PhantomChat is a **client-side Progressive Web App** for decentralized,
end-to-end-encrypted messaging, forked from Telegram Web K (Solid.js +
TypeScript + Vite). The Telegram MTProto backend is replaced by a **Virtual
MTProto Server** (`src/lib/phantomchat/virtual-mtproto-server.ts`) that
intercepts MTProto calls and serves them from local IndexedDB populated over
**Nostr relays** (NIP-17/44/59 gift-wrap). 100% client-side: no servers we
operate, no accounts — identity is a key the user holds.

### Threading model (know this before you touch a hot path)

| Concern | Where it runs |
|---|---|
| UI (Solid.js), ChatAPI, relay pool, **Virtual MTProto Server** | **Main thread** |
| `appManagers` (appMessagesManager, etc.) | **SharedWorker** (via `apiManagerProxy` MessagePort bridge) |
| NIP-44 / gift-wrap encrypt + Schnorr sign/verify | **Dedicated `nostr-wrap`/`nostr-unwrap` workers** |

The MessagePort bridge is **pipelined and batched** — it is the *good* part.
Crypto is **offloaded to workers** with a cached symmetric-key store. Use these
as the template. The performance problems are not the architecture; they are
hot paths that **violate** it. Don't reintroduce the violations below.

## The golden rule: be allergic to sync and to "waiting on waiting"

> The user's perception of speed is set by the **main thread** and by what their
> own actions are forced to wait on. Optimistic UI first; correctness reconciles
> in the background. If a change makes the user wait on the worker, the network,
> or IndexedDB to see their own action, it is wrong.

## Hard rules (MUST / NEVER)

1. **A user's own action renders optimistically on the main thread — NEVER
   gated on the worker, network, or IndexedDB.** When you send a message, your
   bubble paints from a synchronous main-thread mirror write + a local
   `history_append`; persistence/encryption/publish happen *after*, fire-and-
   forget. Never put an `await` on a worker round-trip *in front of* a paint the
   user is waiting for. (This is why `injectOutgoingBubble` paints first, then
   `void`s `setMessageToStorage`.)

2. **Cache key-lookups in memory; IndexedDB is the COLD tier, not a per-message
   dependency.** Anything read once-per-message (`isBlocked`, `isKnownContact`,
   `getTombstone`, pubkey→peer maps) MUST be served from an in-memory
   `Set`/`Map` invalidated on the (rare) mutation — never re-fetched from IDB on
   every message. Model: `phantomchat-bridge.ts` `pubkeyCache`/`midCache`.

3. **Independent awaits go in `Promise.all`. NEVER `await` inside a `for` loop
   over a batch.** A `for (const x of batch) { await f(x); }` over relays,
   conversations, or messages is a bug unless each step truly depends on the
   previous. Parallelize (bounded if the peer rate-limits).

4. **High-frequency events MUST coalesce; listener bodies stay cheap.**
   `rootScope.dispatchEvent` is **synchronous fan-out** — every listener runs
   inline on the caller's stack. For `phantomchat_new_message` /
   `_delivery_update` / `_reactions_changed` and friends, batch per animation
   frame and let Solid's reactivity schedule the render. Never do heavy
   synchronous work (large list re-render, big `JSON.parse`) inside a listener
   on a high-frequency event.

5. **NEVER call synchronous `localStorage` on a render / scroll / drag /
   per-message path.** `localStorage.*` is synchronous and blocks the main
   thread. Read once into memory at boot; write through a debounced/idle
   flusher. Route through `LocalStorageController`, not raw `localStorage`.

6. **Index what you look up; seek + limit. NEVER `openCursor()`-scan a whole
   store.** History reads seek the `timestamp` index in reverse and stop at the
   limit — they do not "load all rows, sort in JS, slice." Add an index before
   you add a lookup.

7. **Retain expensive DOM; re-attach, don't rebuild.** Switching chats must not
   tear down and re-render the previous chat's bubble DOM from scratch (that is
   why switch-back is laggy). Keep an LRU of recent chat views and re-attach.

8. **Keep heavy crypto in the worker as the default.** The synchronous unwrap
   path is a safety *floor* (1–7s for a backfill burst), not a hot path. Make
   the worker's key-cache warm an **awaitable precondition** of opening
   subscriptions/backfill so the sync fallback is essentially never hit.

9. **Do not break the message-identity invariants.** The identity triple
   (`eventId`/`mid`/`twebPeerId`/`timestamp`) is immutable after creation; rows
   key on the 64-hex `eventId`. ChatAPI.sendText is the single authoritative
   persister. Optimistic renders dedupe by `fullMid`. Touching the send/receive
   dedup or delivery-tick (✓→✓✓) paths requires a regression test — these have
   bitten us before (duplicate rows, wrong-size `['e']` tags, lingering ticks).

10. **Desktop app (Electron): permissions stay default-deny, binary versions identify their
   own release.** Grant a new Chromium permission only by adding it to
   `electron/permissions.ts` (app-origin only, with a test). The desktop
   release version is `1.1.<github.run_number>` from its own manual, main-only workflow;
   PWA releases are independent and never required to release Electron. The embedded Stable frontend retains its pinned release
   version; its source promotion is independent of the desktop binary update ring
   (see `docs/RELEASE-CHANNELS.md`).

11. **A cross-device sync write is not fire-and-forget.** A delete/rename that
   publishes to the shared kind-30078 blob must retry until the relay confirms
   (`CrdtSync.publishWithRetry`) and must log loudly when it gives up — a
   silently dropped publish is an invisible cross-device outage (deleted
   contacts resurrected for days, #155). Cosmetic writes (kind-0 profile
   refreshes) must NEVER bump the CRDT clock: `updatedAt` moves only on a real
   payload change, or a stale live entry outranks the tombstone. Reconcile runs
   periodically, not only at boot — long-running devices must see siblings'
   deletes.

12. **A fresh `updatedAt` NEVER resurrects a durable delete — only a
   `deliberateAddAt` stamp can (#180).** Automatic paths (profile refresh,
   message-path persistence, stale pre-#180 clients whose service worker
   never updated) mint CURRENT timestamps without user intent, so the CRDT
   merge (`mergeEntry`) lets a live entry clear a tombstone only when it
   carries `deliberateAddAt > tombstone.updatedAt`. The stamp is minted
   ONLY at user-gesture add paths (addP2PContact `deliberate: true`,
   GroupAPI.createGroup) — never in storeMapping, handleGroupCreate, or sync
   restores — and live/live merges max-forward it (order-independent across
   three-device folds). Contacts/groups snapshots publish v2 and still READ
   v1 (`acceptedVersions`); once v2 lands on a relay, v1 clients freeze out
   (unknown version = never apply, never overwrite) — that quarantine is
   deliberate: the stale client IS the resurrection poison source.

13. **Every stored-row → tweb-message builder MUST derive media via
   `storedRowMedia` (phantomchat-media-shape.ts), and `setMessageToStorage`
   never lets a media-less copy clobber a cached media-bearing mid (2026-10-05
   restart regression).** tweb does NOT re-fetch a cached history window, so a
   media-less overwrite of an already-cached mid renders the bubble as an
   empty `is-message-empty` shell forever — even though the phantomchat store
   row still carries its `fileMetadata` (media is only ever *added* in this
   app; no edit path removes it, so carrying cached media forward is always
   correct). The builders hit so far: getDialogs top message (1:1 + group),
   searchMessages, delivery-ui `refreshDialogPreview`, message-handler
   `buildClearedDialogFromStore`. New builder? Use `storedRowMedia` — never
   hand-roll `createTwebMessage` over a stored row without it.

14. **Linux package installs self-update THROUGH the package manager, never
   around it.** The deb/rpm targets must keep electron-builder's
   `package-type` + `app-update.yml` in `resources/` (electron-updater 6.6+
   reads package-type to pick DebUpdater/RpmUpdater), the capability resolver
   (`electron/updateCapability.ts`) may only mark a package install 'auto'
   when a graphical privilege agent (pkexec/gksudo/kdesudo/beesu, or root) is
   EXECUTABLE on PATH — a non-executable file with the right name does not
   count, and plain `sudo` cannot prompt from a desktop app — and
   `latest-linux.yml` must carry the .deb AND the .rpm (CI asserts both, plus
   the package-type file inside both packages). A feed without the package
   payload, or a package without package-type, breaks every package-managed
   install's update path silently.

15. **A group conversation has EXACTLY ONE store key: `group:<groupId>`.** Every
   message-store call for a group — `saveMessage` / `getMessages` /
   `countUnread` / `setReadCursor` / `getReadCursor` / `getTombstone` — and
   every dialog/history reader (`getDialogs` group branch, `getGroupHistory`,
   `resolveConversation`) MUST use it. The bare `<groupId>` key is legacy-only
   (rows written before #207); readers must tolerate it and migrate it forward
   (`MessageStore.rekeyConversation`), never write it anew. A bare-key write
   splits a group's rows and read cursor so a fully-read dialog reappears
   unread after every restart.

16. **Receive paths need PERSISTENT replay dedup, not just an in-memory set.**
   Relays re-deliver kind-1059 gift-wraps (24h TTL) on every reconnect/boot, so
   an in-session `Set` is empty exactly when replays arrive. Before save /
   render / dispatch, gate on `store.hasSeenEventId(id) ||
   await store.getByEventId(id)` (see `chat-api-receive.ts` step 7b for the DM
   path and `GroupAPI.handleIncomingGroupMessage` for the group path). A
   replayed already-read message must not re-bump unread; an own-message echo
   must never dispatch `unreadCount: 1`.

## Settings screens: one design (MUST)

Decision Model and Voice Models were built by two agents, one each, and they came
out looking like two different apps. Every settings screen, and every model setting
in particular, follows the rules below. Reviewers reject a diff that breaks them.

1. **Build from the app's own components, never raw HTML controls.** Use
   `SliderSuperTab` + `SettingSection` (with a caption that says what the screen
   does, in plain words), `Row` for navigation and toggles (`CheckboxField
   {toggle: true}`), `InputField` for text and keys, `createListPicker` for any
   choice, and `Button('btn-primary btn-color-primary')` for the action. NEVER use
   `<select>`, `<fieldset>`/`<legend>`, a bare `<input type=checkbox>` or inline
   `className = 'btn-primary'` buttons. The pickers exist because native selects are
   unusable on a phone.
2. **Model settings use the kit** (`src/components/sidebarLeft/tabs/phantomchatModelKit.ts`),
   always in this order: Enabled toggle Row, Provider, (Base URL), API key + key
   note, Model(s), status line, Test and Apply. The Provider list comes from the
   engine (`*.providers()`): the Pi providers that serve that model type. Voice has
   ONE Enabled switch, ONE provider and ONE key for both TTS and STT, a model
   picker per direction, and NO voice picker (only providers serving both
   directions are listed). A new model setting goes under
   **Settings > Specialized Models** as one more row, not as a new top-level row.
3. **No "Load models" button.** Models load when the key or base URL field is
   left (blur), when the provider changes and a stored key fits, and on open when
   a key is stored. The saved choice shows on open with no network call.
4. **Keys are write-only.** A key field is a password field, cleared after save
   and on close. It never shows the stored key: a stored key shows as dots in the
   placeholder (`showStoredKey`). The note under it says
   "Key saved. Leave empty to keep it." when one is stored, or why it cannot be
   kept. Main owns keys (safeStorage), and the page learns only `hasKey`. A stored
   key is reused only for the same provider and endpoint.
5. **No standing "Active" badge; one status line per form.** A badge shown on
   open said "Active" before anything was chosen. The button tests instead:
   **Test and Apply** (Decision Model, Embeddings) or **Test and Save** (Voice
   Models, which applies nothing). The status line (`role="status"`) says what
   happened in short plain sentences ("Key rejected (HTTP 401)", "Not applied: ..."), then
   `appliedLine()`: "On: applied to 2 personas; failed: aria (disk full)". Errors
   go in the status line, not in alerts or toasts.
6. **Stale answers never win.** Every async check carries a generation counter.
   A provider switch, a new key or a save bumps it, and an older answer is dropped,
   failures included.
7. **No catalogue means a typed model id**, through the kit's model chooser
   ("Other: type a model ID"). Never a dead empty picker.
8. **Ask before a disruptive save.** A save that re-embeds every note (Embeddings
   turned on, or a new provider, endpoint or model) asks Confirm/Cancel first and
   says memory search by meaning is unavailable until it finishes.
9. **Validate before saving.** The button checks the key in use (typed or
   stored) and the model the way the TUI does, and saves nothing on a rejection.
   Decision Model and Embeddings then apply to every persona of the bundled engine
   (= every Provider contact; npub Phantoms and humans are never touched) one by
   one, name the ones that failed, and new personas inherit the setting. Voice
   Models applies to nobody: it gates the Voice ID picker on Provider contacts'
   Edit pane, and a contact gets voice (TTS and STT together) when a Voice ID is
   picked there; only those personas are updated when the setting changes.
10. **Test ids follow `<screen>-<field>`** (e.g. `embeddings-key`), and pickers
   derive theirs (`-value`, `-option-<v>`). Tests drive the form the way a user does:
   blur, pick, Save.
10. **Copy.** Sentence case and plain words ("assistants", "Key saved"). Name
    things the way the TUI does. No jargon in captions, and no ellipsis characters:
    use `...`.

## Review checklist (reject a diff that does any of these on a hot path)

- An `await` of a worker/IDB/network call placed *before* a paint or input echo.
- `for (… of …) { await … }` over a batch with no inter-item dependency.
- `localStorage.getItem/setItem` in a render/scroll/drag/per-message path.
- A new per-message IDB read with no in-memory cache.
- `store.openCursor()` without an index + `limit`.
- Heavy synchronous work inside a `rootScope` listener for a high-frequency event.
- A `dispatchEvent` per message where one coalesced dispatch per frame would do.

## Measuring (prove the win)

Latency is verified live via CDP against the prod PWA (recipe + reader at
`/tmp/cdp-phantomchat.mjs`; see the team's CDP notes). Baselines from the
2026-06 audit: idle send→bubble ~40 ms but **up to 25 s under incoming load**
(the bubble was *waiting on the saturated worker*, not computing); chat-switch
first bubble ~400 ms with a 222 ms main-thread long-task. Re-measure after any
hot-path change and put the numbers in the PR.

## Session note — 2026-10-03 (PR: one-PR sweep #186/#187/#188)

- `addP2PContact(deliberate)` writes the stamp ATOMICALLY with the mapping
  (`storeMapping({deliberateAddAt})`) and clears the guards AFTER. Never
  reorder back to clear-then-store: a failed stamp write must abort the add
  with the delete fact intact (#186).
- `storeMapping` opts gained `deliberateAddAt` — it bypasses BOTH tombstone
  guards and max-forwards over an existing proof. Automatic paths must never
  pass it.
- NEW group ids bind the admin: `<64-hex adminPubkey><32-hex random>` (96
  hex). `boundGroupAdmin()` is the receiver-side source of truth for
  group_create/group_delete on bound ids; legacy 32-hex ids keep pre-#188
  behavior (documented limitation, see the issue). NEVER trust
  `payload.adminPubkey` when a binding exists (#188).
- `sync-crdt.ts` must stay TEXT: no literal NUL bytes in string literals —
  use the `\u0000` escape (runtime-identical, keeps GitHub diffs readable).

## Session note — 2026-10-09 (PR: group unread after restart, #207)

- The live group receive path (`GroupAPI.handleIncomingGroupMessage`) now has a
  persistent replay dedup gate before the membership-authorized render, matching
  `chat-api-receive.ts` step 7b. Replays of already-persisted rumors are dropped
  before `handleGroupIncoming`, so they neither re-render nor re-bump unread.
- `handleGroupIncoming` builds its dialog from `isOutgoing`: own echoes dispatch
  `unreadCount: 0` with the read marker at `mid`; only genuinely new incoming
  messages use `unreadCount: 1` / `readInboxMaxId: mid - 1`.
- Canonical group conversation key is `group:<groupId>` everywhere (rule 15):
  `writeGroupCreateServiceMessage` (was bare), `getDialogs` group branch and
  `phantomchat-message-handler.ts` `resolveConversation` (was bare) now use it.
  The getDialogs group branch reads the REAL `getReadCursor` + `countUnread`
  instead of forcing both markers to `mid`, with the noIdsDialogs all-zero
  fallback preserved. Legacy bare-key rows are tolerated and migrated via
  `MessageStore.rekeyConversation`.
- Live repro: the `phantomchat:0aea…` conversation (Phantom Yard), the busiest
  group inside the relay replay window.
