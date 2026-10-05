# AGENTS.md — PhantomChat

Authoritative design rules for anyone (human or AI agent) changing this repo.
For build/test commands, code style, path aliases, and harness specifics see
[`CLAUDE.md`](CLAUDE.md); for subsystem rules see
[`docs/CLAUDE-RULES.md`](docs/CLAUDE-RULES.md). This file is about **how the app
must behave and how it must be architected** — read it before touching the
message send/receive, chat-switch, storage, or worker code.

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

10. **Desktop app (Electron): permissions stay default-deny, versions stay in
   sync with the PWA.** Grant a new Chromium permission only by adding it to
   `electron/permissions.ts` (app-origin only, with a test). The desktop
   release version is the PWA deploy run number for the same commit
   (`app-release.yml` "Resolve version"); never version it from its own
   `github.run_number`.

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
