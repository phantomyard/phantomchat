# Nostr Web Push Relay — Options Survey
Date: 2026-04-26
Scope: Find a server-side actor that can deliver browser Web Push (VAPID + Service Worker) for Nostra.chat.

## Executive Summary

**There is no existing Nostr push relay that does RFC 8030 Web Push (VAPID).** Every Nostr-aware push server found either delivers via FCM (Firebase Cloud Messaging — requires a Firebase project and the client app to register an FCM token) or via APNS (Apple Push Notification Service — iOS only). The closest option for a browser PWA is FCM, which Chrome and Edge support natively via their push infrastructure, but Safari/Firefox use standard VAPID endpoints that FCM does not cover. Building a thin custom service on top of the `web-push` npm library is the practical path.

---

## Candidates Verified to Exist

### 1. coracle-social/npb — Nostr Push Bridge
- **URL:** https://github.com/coracle-social/npb
- **Stack:** TypeScript / Node.js (Hono framework, pnpm, SQLite via better-sqlite3)
- **Web Push (VAPID)?** No. It is a **webhook bridge**, not a Web Push sender. When a subscribed Nostr event arrives, `npb` POSTs a JSON payload to a `callback` URL supplied by the client at registration time (kind 30390 event per the draft NIP-9a PR). The callback URL must be an HTTP endpoint that the registering client controls — it does NOT do VAPID/RFC 8030 pushes to browser endpoints.
- **Public hosted instance?** None found. Self-host only.
- **Last commit:** 2026-02-09 (active recently)
- **License:** MIT
- **Self-host complexity:** Easy — `git clone`, set `PORT`/`CORS_DOMAIN`/signer env vars, `pnpm install && pnpm start`. Has Dockerfile. No Redis, no DB beyond SQLite.
- **Privacy posture:** Does not decrypt events. Sees only: the relay URL where the event arrived and the event ID. The full encrypted gift-wrap is never fetched — only `{id, relay}` is forwarded to the callback. Good privacy posture for metadata.
- **Notes / blockers for Nostra.chat:**
  - The callback URL must be an HTTP server reachable by `npb`. A browser Service Worker cannot be a callback server. Nostra.chat would need to run its own intermediate HTTP endpoint (e.g. a Cloudflare Worker or small VPS endpoint) that receives the `npb` callback and then re-dispatches a real VAPID push to the browser. This makes `npb` a relay-bridge layer, not a complete push solution on its own.
  - Implements draft NIP-9a (PR #2194, open since 2026-01-21) — not yet a final NIP. No other clients known to implement the same draft.
  - The `worker.ts` subscription logic is solid: subscribes to Nostr relays with per-alert `AbortController`, supports `ignore` filters, deregisters callback on HTTP failure.

### 2. verse-pbc/nostr_push_service — Nostr Push Service (Plur)
- **URL:** https://github.com/verse-pbc/nostr_push_service
- **Stack:** Rust (axum + tokio), Redis, PostgreSQL, Docker + Helm for Kubernetes
- **Web Push (VAPID)?** No. Delivers exclusively via **FCM** (Firebase Cloud Messaging). The `src/fcm_sender.rs` uses `firebase-messaging-rs` crate; there is no VAPID/web-push crate anywhere in the dependency tree. The included demo `frontend/firebase-messaging-sw.js` uses `firebase-messaging-compat` SDK and the `messaging.onBackgroundMessage` handler — confirming this is a Firebase SW push, not a raw VAPID push.
- **Public hosted instance?** None public. Verse (Plur app) runs their own instance for internal use.
- **Last commit:** 2025-10-31
- **License:** None specified (no LICENSE file in root)
- **Self-host complexity:** Complex — requires Rust toolchain build, Redis, PostgreSQL, Firebase service account JSON per-app, optional Kubernetes/Helm. Has `compose.yml` and Dockerfile.
- **Privacy posture:** Decrypts push token registrations (kinds 3079-3082 use NIP-44 encryption, server holds private key). Sees: user pubkey → FCM device token mapping. Does NOT decrypt message content (kind 1059 events flow through opaquely). Redis stores pubkey→token. High metadata exposure.
- **Notes / blockers for Nostra.chat:**
  - FCM covers Chrome, Edge, and Android. It does NOT cover Firefox (uses Mozilla autopush) or Safari (uses Apple WebPush). A pure FCM solution misses ~30% of browser targets.
  - Interesting protocol: uses kinds 3079-3082 with NIP-44 encryption for token registration — reasonable privacy trade-off vs. plaintext token storage.
  - The FCM SW handler in `frontend/firebase-messaging-sw.js` is well-engineered but is FCM-specific; cannot be reused for VAPID directly.

### 3. vitorpamplona/amethyst-push-notif-server
- **URL:** https://github.com/vitorpamplona/amethyst-push-notif-server
- **Stack:** JavaScript / Node.js (firebase-admin, custom relay pool)
- **Web Push (VAPID)?** No. Firebase FCM only (via `firebase-admin` SDK). Sends to Android/FCM devices registered with Amethyst wallet.
- **Public hosted instance?** Yes — runs for Amethyst Android app. Not designed for third-party use; no documented public API.
- **Last commit:** 2026-04-17 (active)
- **License:** MIT
- **Self-host complexity:** Easy — requires Firebase project + service account JSON (base64 env var), Node.js, Heroku-style deploy documented in README.
- **Privacy posture:** Holds FCM device tokens (linked to pubkey). Does not decrypt event content. Subscribes to filters and sends notification on match.
- **Notes / blockers for Nostra.chat:** Android/FCM only. Designed as internal infrastructure for the Amethyst app. No browser Web Push.

### 4. damus-io/notepush — (confirmed APNS-only, see below)

---

## Candidates Investigated but Ruled Out

- **`damus-io/notepush`** — confirmed APNS-only. Rust, GPL-3.0, 12 stars, last updated 2025-12-11. Sends Apple Push Notifications (APNS) to iOS native apps. No VAPID, no FCM, no browser support. `notify.damus.io` is its hosted instance. Not applicable to browser PWA.
- **`DocNR/clave`** — Swift, iOS NIP-46 remote signer using APNS to wake a Notification Service Extension. Not a push relay at all; browser-irrelevant.
- **`kumulynja/nwc_wallet_notifier`** — Firebase Functions for NWC (Nostr Wallet Connect) wallet apps. FCM only, no browser VAPID.
- **`twenty-eighty/relay_monitor`** — Elixir, monitors relay uptime and pings Uptime Kuma. Not a push notification service.
- **GitHub topics `nostr-push` and `nostr-notifications`** — both empty (zero repositories tagged with these topics as of 2026-04-26).

---

## Candidates That Don't Exist (Claimed but Not Verified)

- **`rust-nostr/nostr-webpush`** — **does not exist.** GitHub API returns `404 Not Found`. No repository with this name exists under the `rust-nostr` org. The `rust-nostr` org has no repos related to push or notifications at all.
- **`gozer-rs/nostr-push-server`** — **does not exist.** GitHub API returns `404 Not Found`. The org `gozer-rs` does not appear to exist.

---

## NIP Landscape

- **NIP-9a (draft PR #2194):** "Add NIP 9a for push notifications" — open since 2026-01-21, last updated 2026-04-17. Defines a relay-bridge protocol (kind 30390 registration events). This is what `coracle-social/npb` implements. It is a *bridge* to an arbitrary callback HTTP endpoint, not a direct Web Push spec.
- **No accepted NIP** currently standardizes VAPID Web Push for Nostr. The ecosystem has not converged on a browser push standard.

---

## The Gap: No VAPID-Native Nostr Push Server Exists

The entire ecosystem has converged on either:
1. **APNS** (iOS native apps — Damus, Clave)
2. **FCM** (Android + Chrome via Firebase — Amethyst, Plur/verse-pbc)

Neither covers Firefox or Safari via standard VAPID. A true browser-neutral Web Push solution (RFC 8030 + VAPID) does not exist in the Nostr ecosystem as of 2026-04-26.

### What a VAPID-capable Nostr push server would need

The `web-push` npm library (`npm:web-push`) or Rust's `web-push` crate can send VAPID-signed pushes to any RFC 8030 endpoint (Google FCM endpoint for Chrome, Mozilla autopush for Firefox, Apple WebPush for Safari 16+). A minimal custom service combining:
- Nostr relay subscription (kind 1059, `#p:[pubkey]`)
- A database of `{pubkey → push_subscription_object}` (the JSON object from `PushManager.subscribe()`)
- VAPID key pair + `web-push` library

...would be ~200 lines of Node.js or ~300 lines of Rust and is the most direct path. The `coracle-social/npb` architecture (webhook callback relay) could serve as a bridge if Nostra.chat self-hosts the receiving HTTP endpoint and then forwards VAPID pushes from there — but that adds a hop and a server.

---

## Self-Host Complexity Comparison

| Project | Stack | Delivery | Complexity | Notes |
|---|---|---|---|---|
| coracle-social/npb | TypeScript/Node | Webhook callback (not VAPID) | Easy | Still needs a VAPID layer on top |
| verse-pbc/nostr_push_service | Rust | FCM only | Complex | Redis + Postgres + Firebase |
| vitorpamplona/amethyst-push-notif-server | Node.js | FCM only | Easy | Not designed for third-party use |
| **Custom service (build it)** | Node.js/TS or Rust | VAPID (all browsers) | Easy–Medium | ~200 LOC; only viable path for browser |

---

## Recommendation Summary

**1. Best public hosted option: None.**
There is no public-hosted Nostr push relay that does browser Web Push (VAPID). `notify.damus.io` is APNS-only (iOS). There is no equivalent for browsers. The verse-pbc service is internal to Plur/Android. No third-party-hosted VAPID option exists.

**2. Best self-host option: Build a thin custom service.**
The fastest path to browser Web Push for Nostra.chat is a small custom service (~200 lines Node.js/TypeScript) that: (a) holds a VAPID key pair, (b) accepts push subscription registrations from the Nostra.chat SW via a simple REST endpoint protected by the user's Nostr key signature, (c) subscribes to kind 1059 events tagged `#p:[user_pubkey]` on the user's configured relays, and (d) calls `webpush.sendNotification(subscription, JSON.stringify({eventId}))` when an event arrives. The `web-push` npm library handles all VAPID signing and payload encryption. Deployment: a single Cloudflare Worker (free tier, zero infrastructure) or a small VPS. The `coracle-social/npb` codebase can serve as a structural reference for the Nostr subscription management logic.

**3. No-go:**
Do not pursue FCM-only approaches (verse-pbc, amethyst) — they cover Chrome/Android but exclude Firefox and Safari, fragmenting the notification path and requiring a Firebase project as a permanent dependency. Also do not pursue `coracle-social/npb` as a standalone solution — it is a webhook bridge, not a push sender, and would require an additional VAPID layer making the architecture more complex than building direct.
