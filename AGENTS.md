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
