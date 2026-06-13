# Background Push Notifications — Design

Date: 2026-04-26 (revised after Damus probe)
Status: Approved (revised architecture — self-host modular relay)
Owner: nostra-chat
Related: shipped local-foreground notifications fix in v0.21.2 (`fix(nostra): wire incoming P2P/group messages to desktop notifications`)
Server repo: https://github.com/nostra-chat/nostr-webpush-relay (AGPL-3.0)
Research: `docs/superpowers/research/2026-04-26-damus-push-relay-api.md`, `docs/superpowers/research/2026-04-26-nostr-webpush-options-survey.md`

> **Architecture pivot (2026-04-26)**: original design assumed `notify.damus.io` could serve as the Web Push relay. Probing revealed it is APNS-only (iOS native). The Nostr ecosystem has zero existing Web Push relays. Revised design self-hosts a minimal modular relay (Node.js, ~300 LOC, open source, AGPL-3.0) on the project owner's existing VPS, fronted by Cloudflare for IP masking + DDoS. The push relay endpoint is configurable from Settings so any user can run their own.

## Problem

Local notifications now fire when the tab is open and the chat is not focused (v0.21.2). When the tab/PWA is **closed** or fully backgrounded, no notification arrives — there is no Web Push pipeline wired for Nostra. Users on Android PWA and desktop with the tab closed silently miss messages.

A Web Push pipeline requires a server-side actor that subscribes to the user's gift-wraps on Nostr relays and dispatches Web Push to the browser/OS push gateway. The decentralized Nostr protocol does not natively provide this.

## Goals

1. Notifications arrive on Android PWA and desktop when the tab is closed or background-throttled.
2. Server-side actor cannot read message content (e2e encryption preserved).
3. No new infrastructure to operate (use an existing public Nostr push relay).
4. User retains explicit control over privacy/preview level.
5. Future swap of the push relay (to a self-hosted `.onion` instance, for instance) requires only a config change, no client rewrite.

## Non-Goals

- Realtime delivery <2s (best-effort over public push relay is fine).
- Read receipts/typing indicators via push.
- Self-hosted push relay (deferred; design must allow it later).
- iOS Safari support (Web Push on iOS Safari is gated by PWA install — out of MVP scope, will work if user installs as PWA but we won't optimize).

## Decisions Made (Brainstorming Outcome)

| # | Topic | Decision |
|---|---|---|
| 1 | Latency target | Quasi-realtime (~2-5s) — self-hosted Node.js relay on existing VPS (default `https://push.nostra.chat`), open source, modular. |
| 2 | Notification payload preview | User-configurable: A=generic (default), B=sender+preview, C=sender only. |
| 3 | Multi-device | All registered devices receive push (A). Per-device dismiss via in-app heartbeat deferred. |
| 4 | Lifecycle | Auto-register at first boot once `Notification.permission === 'granted'`. Auto-unregister on logout/reset. |
| 5 | Groups | Aggregation/rate-limit per peer in SW + per-peer mute via existing tweb mute UI. |
| 6 | Provider failure / vendor lock | Endpoint configurable from Settings → Advanced. Default `https://push.nostra.chat` (self-hosted). Users may swap to any compatible relay (own self-host or community-run). |
| 7 | Test strategy | Real E2E with two Playwright browser contexts hitting Damus relay (separate suite, not in `quick`). |

## Architecture (Approach 1: Damus thin client)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  CLIENT (browser/PWA)                                                    │
│                                                                          │
│  [Settings UI]  ──toggle preview level (A/B/C)──┐                        │
│                                                  │                        │
│  [nostra-push-client.ts] ─── PrivacyTransport(TorMode) ───┐              │
│  ─ subscribe()                                              │              │
│  ─ unsubscribe()                                            │              │
│  ─ register({pubkey, sub, p256dh, auth})                    │              │
│  ─ persists in IDB: nostra-push                             ▼              │
│                                                  [notify.damus.io]        │
│                                                  (or override)            │
│                                                             │              │
│  [Service Worker / nostra-push.ts]  ◄──── Web Push ─────────┘              │
│        │                                                                   │
│        ├─ A: show "Nostra.chat — new message"                              │
│        ├─ B: read privkey IDB → decrypt NIP-44 → resolve name → full       │
│        ├─ C: decrypt → sender name only                                    │
│        └─ aggregation: rate-limit per peerId in SW state                  │
│                                                                            │
│  [Main thread on click] ── notification.onclick ──> setInnerPeer()        │
└──────────────────────────────────────────────────────────────────────────┘
```

**Privacy boundary**: `notify.damus.io` learns `(npub, push endpoint, IP unless Tor, push frequency)` — never message content, never real sender (NIP-59 ephemeral wrapper). Push gateway operators (Google/Mozilla/Apple) learn device identity + payload metadata; this is structural to Web Push and cannot be eliminated.

## New Components

| File | Lines (est.) | Responsibility |
|---|---|---|
| `src/lib/nostra/nostra-push-client.ts` | ~150 | Damus push relay client: subscribe/unsubscribe/register/getRegistration/setEndpointOverride. Routes HTTP via PrivacyTransport. |
| `src/lib/serviceWorker/nostra-push.ts` | ~250 | SW push handler: discriminator, decrypt (B/C), resolve sender name from kind 0 cache, aggregation. |
| `src/lib/nostra/nostra-push-storage.ts` | ~80 | IDB persistence: subscription record + preview level + endpoint override. |
| `src/tests/nostra/nostra-push-client.test.ts` | ~100 | Unit: mock fetch, register/unregister payload, TorMode passthrough. |
| `src/tests/nostra/nostra-push-sw.test.ts` | ~150 | Unit: mock push event, A/B/C rendering, aggregation rate-limit. |
| `src/tests/e2e/e2e-push-bilateral.ts` | ~200 | E2E: two Playwright contexts, real Damus relay, end-to-end push delivery. |
| `docs/PUSH-NOTIFICATIONS.md` | ~80 | User-facing privacy disclosure linked from Settings. |

## Modified Components

- `src/lib/serviceWorker/push.ts` — `onPushEvent` discriminator: `payload.app === 'nostra'` → `nostra-push` handler, else legacy Telegram path (no-op in our builds).
- `src/lib/serviceWorker/index.service.ts` — register the new handler alongside the existing one.
- `src/lib/nostra/nostra-cleanup.ts` — call `unsubscribePush()` before closing IDB; clear new IDB store.
- `src/pages/nostra-onboarding-integration.ts` — auto-subscribe after `Notification.permission === 'granted'` and own pubkey is available.
- `src/components/sidebarLeft/tabs/notifications.tsx` — new "Background notifications" block: enable toggle (auto-on), preview radio (A/B/C), Advanced collapsible with endpoint override, inline disclosure.
- `src/lib/webPushApiManager.ts` — deprecated for Nostra. Either gut the Telegram-coupled `subscribe`/`unsubscribe`/`isAliveNotify` paths and replace with `nostra-push-client` calls, or leave the file as a no-op stub and reference `nostra-push-client` from new sites. **Decision in plan**: leave `webPushApiManager` untouched, never invoked from Nostra paths; document as Telegram-legacy.

## Data Flow

### Registration (one-shot, post-permission)
```
1. permission grant detected (already in onboarding integration listener)
2. nostra-push-client.subscribe():
   a. registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: <Damus VAPID public key>
      })
   b. extract {p256dh, auth} from subscription.toJSON().keys
3. nostra-push-client.register():
   a. POST `${endpoint}/register`
      body = {pubkey: ownNpub_hex, endpoint: sub.endpoint,
              keys: {p256dh, auth}, relays: top-N user relays}
      via PrivacyTransport(TorMode)
   b. on 200: persist {subscriptionId, endpointBase, registeredAt, pubkey} in IDB
4. Damus side (out of our control): adds {kinds:[1059], '#p':[ownNpub]} to its WS subscriptions
```

### Push delivery
```
1. Sender publishes kind 1059 → relay (existing Nostra send path)
2. Damus receives via WS, looks up our subscription, dispatches Web Push
3. Browser SW wakes, receives push event
4. push.ts onPushEvent → if payload.app==='nostra' dispatch to nostra-push handler
5. nostra-push.onNostraPush(event):
   - read previewLevel from IDB
   - if A: showNotification('Nostra.chat', {body: 'New message', tag: payload.peer_id})
   - if B/C:
     a. read privkey directly from IDB `Nostra.chat` via SW-safe helper
        (see "Privkey Access from Service Worker" section below).
     b. decrypt NIP-44 gift-wrap from payload.event_id (or refetch from relay if payload only carries id)
     c. extract sender pubkey from rumor
     d. lookup kind 0 (display name) from IDB nostra-virtual-peers
     e. if C: showNotification(senderName, {body: '[encrypted]'})
        if B: showNotification(senderName, {body: truncate(rumor.content, 80)})
   - aggregation:
     state = await idb.get('nostra-push', 'sw-aggregation')
     entry = state[peerId] ?? {ts: 0, count: 0}
     if(now - entry.ts < 5*60_000):
       update existing notification body to "X new messages from <peer>"
     else:
       new notification, store {ts: now, count: 1, tag}
6. onclick: clients.openWindow('/?p=<peerId>&m=<mid>') →
   setInnerPeer on the resumed tab
```

### Unregister
```
1. nostra-push-client.unsubscribePush():
   a. DELETE `${endpoint}/register/${subscriptionId}` via PrivacyTransport
   b. registration.pushManager.unsubscribe()
   c. clear IDB nostra-push.subscription
2. Triggered by:
   - Logout (nostra-cleanup.ts before DB delete)
   - Reset Local Data (same path)
   - Settings toggle "Disable background notifications"
```

## Privacy Threat Model

| Attacker | Sees | Mitigation |
|---|---|---|
| `notify.damus.io` operator | npub + Web Push endpoint + IP + push timing | TorMode (if user enabled) masks IP. No content. Real sender obscured by NIP-59 ephemeral wrapper. |
| Push gateway (Google/Mozilla/Apple) | device identity + ciphertext payload + push timing | Structural to Web Push. Disclosed to user in Settings. |
| Passive network observer | TLS-encrypted | Standard. |
| Lockscreen attacker | Only notification title (per preview level) | Default A is generic. User opts into B/C with explicit warning. |
| Browser-runtime attacker | privkey IDB, subscription, contacts | Same surface that already exists; not increased by this feature. |
| Compromised push relay (RCE / spoofed pushes) | Can fake-push registered npubs | MVP: payload is treated as a hint; on click, the app fetches the actual event from relays and renders. A spoofed push that doesn't match a real relay event leaves the user with a "phantom notification" that opens to nothing — annoying but not exploitable. Active eventId verification on the SW side is listed under Open Questions. |

## TorMode Integration

Routes that go through `PrivacyTransport`:
- `POST /register` (subscription registration)
- `DELETE /register/:id` (unregister)
- `GET /register/:id` (heartbeat — optional, not in MVP)

Behavior per `tor` mode:
- `always` → all routes via Tor; if Tor down, retry on Tor recovery (defer registration if necessary).
- `when-available` → use Tor if up; fall back to clearnet with main-thread log warning.
- `off` → clearnet directly; show a one-time tooltip in Settings recommending Tor for stronger privacy.

`PushManager.subscribe()` itself is a browser API call to the OS push gateway and cannot be tunneled through Tor; this is documented and accepted.

## Settings UI Block

Inserted in `src/components/sidebarLeft/tabs/notifications.tsx` above the existing "Sounds" section:

```
┌─ Background notifications ──────────────────────────────────┐
│                                                              │
│  ◉ Enable                                  [toggle:on]      │
│      Receive notifications when Nostra.chat is closed.      │
│                                                              │
│  Preview                                                     │
│    ◯ Generic ("New message")           ← default            │
│    ◯ Sender + content                                       │
│    ◯ Sender only                                            │
│                                                              │
│  ▼ Advanced                                                  │
│    Push relay: [notify.damus.io          ] [Reset]          │
│                                                              │
│  ⓘ  Your public key and IP address (unless Tor is enabled)  │
│      are sent to the push relay. Message contents stay       │
│      end-to-end encrypted. Learn more.                       │
└──────────────────────────────────────────────────────────────┘
```

## Aggregation Logic (SW)

State: a single IDB key `sw-aggregation` holds `Record<peerId, {ts, count, lastBody}>`.

Rule:
- If `now - state[peerId].ts < AGGREGATION_WINDOW_MS` (default 5 min):
  - Increment count, update existing notification with `tag === peerId` to body `"<count> new messages from <peer>"`.
- Else:
  - Show new notification, reset entry to `{ts: now, count: 1, lastBody}`.
- On `notificationclick` (peer opened): clear entry for that peer.

Window is configurable via the same IDB store under `aggregation_window_ms` for future tuning.

## Privkey Access from Service Worker

Web Push can wake the Service Worker when no client tab exists. In that case the SW context has access to `caches` and `indexedDB` but **not** `localStorage`. The privkey already lives in IDB database `Nostra.chat` (primary path of `loadIdentity()`; localStorage is only a test fallback), so the SW can read it directly — no main-thread mirror is required.

What is required is a **gate**: the SW handler must only read the privkey when `preview_level !== 'A'`. The IDB read helper used by the SW must be a SW-safe variant of `loadIdentity()` (no `localStorage` fallback path, since the SW cannot reach `localStorage`).

- **Preview A (default)**: SW handler shows generic notification, never reads privkey.
- **Preview B/C**: SW handler reads privkey from `Nostra.chat` IDB, decrypts NIP-44, renders preview accordingly.

Threat surface implication: the privkey is already at rest in IDB (status quo since onboarding). This feature does not enlarge that surface; it only gates *use* of the privkey from the SW context. The Settings disclosure for B/C still mentions that the SW will read the privkey to decrypt notification content.

## Authentication Boundary on Damus

`notify.damus.io` does not authenticate registrations beyond "you supplied a pubkey". An attacker could register fake subscriptions tied to any npub, but they could only receive Web Pushes addressed to **their own** Web Push endpoint (Google/Mozilla/Apple gateway-bound). They could not see or steal someone else's pushes. Spoofed registrations are therefore not a real attack vector. We do not add a NIP-42 auth handshake in MVP; can be added if Damus surfaces it.

## Test Plan

### Unit (Vitest, in `quick` suite)
- `nostra-push-client.test.ts`: mock global `fetch`; verify `register` payload shape, `unregister` URL, TorMode passthrough by mocking `PrivacyTransport.fetch`.
- `nostra-push-sw.test.ts`: import the SW handler directly, mock `event.waitUntil` + `registration.showNotification`; assert per preview-level (A/B/C) the title/body, decrypt path mocking, aggregation behaviour.

### E2E (Playwright, separate `online` suite — manual or nightly)
- `src/tests/e2e/e2e-push-bilateral.ts`: two browser contexts with two distinct generated npubs, both register against real `notify.damus.io`, contextA closes its tab (or `page.evaluate(() => navigator.serviceWorker.controller.postMessage('simulate-close'))`), contextB sends a kind 1059, assert SW notification fires within 10s and click opens correct chat. Skipped automatically if `NOSTRA_PUSH_E2E_OFFLINE=1`.

### Manual smoke (release sign-off)
- Android PWA + desktop, two accounts, send/receive in both directions, verify: notification fires when tab closed, click opens chat, aggregation kicks in for 3 rapid messages, mute on a peer suppresses, Tor toggle round-trip works.

## Rollout

- Branch: `feat/nostra-background-push`.
- Changes ship in a single PR.
- release-please will produce `0.22.0` (`feat:` minor bump).
- No explicit runtime feature flag — auto-on for users who already granted notification permission.
- Migration: existing users who already have local notifications enabled get auto-subscribed at next boot.
- Docs: `docs/PUSH-NOTIFICATIONS.md` linked from Settings disclosure and from `README.md` privacy section.

## Open Questions / Future Work

- **Self-host `nostr-push` with .onion**: when external dependency on Damus becomes a problem (volume, downtime, governance), spin up a CF Worker or VPS instance and document the endpoint switch in user-facing docs.
- **Heartbeat-based device dismiss**: when device A is online with focus, suppress push to device A. Saves duplicate noise.
- **iOS support**: validate that PWA-installed Safari behaves correctly; may require additional `applicationServerKey` handling.
- **Push verification on SW side**: optionally re-fetch the kind 1059 event from a relay to confirm authenticity; today we trust Damus's payload.
- **NIP-42 auth**: if Damus exposes pubkey-signed registration, add it to harden against subscription poisoning.

## Acceptance Criteria

- A user who has granted notification permission, closes the tab/PWA, and is sent a P2P or group message receives a system notification within 10s (best-effort).
- The notification respects the user's preview level (A/B/C); default A renders no message content.
- Clicking the notification opens (or focuses) Nostra.chat to the correct chat.
- Aggregation collapses ≥3 rapid messages from the same peer into one updating notification.
- Per-peer mute (existing tweb UI) suppresses push for that peer.
- Logout / Reset Local Data / Settings toggle off: subscription is removed from `notify.damus.io` and the device stops receiving push within 30s.
- TorMode `always` and `when-available` route registration HTTP through PrivacyTransport.
- Bilateral E2E test passes against the live Damus relay.
- Privacy disclosure (`docs/PUSH-NOTIFICATIONS.md`) shipped and linked from Settings.
