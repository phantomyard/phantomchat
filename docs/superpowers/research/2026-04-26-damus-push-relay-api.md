# Damus Push Relay API — Probe Results
Date: 2026-04-26

## Executive Summary

`notify.damus.io` runs **`damus-io/notepush`** (Rust, open source). It is an
**APNS-only** push relay — it sends Apple Push Notification Service payloads to
iOS device tokens. There is **no Web Push / VAPID support** anywhere in its
codebase or Cargo dependencies.

This is a **BLOCKER for the planned design** (T5/T7/T9). The downstream tasks
assumed Damus would provide a Web Push relay compatible with browser Service
Workers. That assumption is false. See §Failure modes for the decision fork.

---

## Authentication (all endpoints)

Every single HTTP endpoint — including every path probed — requires
**NIP-98 HTTP Auth** (see [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md)).

- Header: `Authorization: Nostr <base64-standard(JSON-serialized-nostr-kind-27235-event)>`
- The kind-27235 event must include:
  - `["url", "<full request URL>"]` tag
  - `["method", "<HTTP method>"]` tag (uppercase)
  - `created_at` within a short time window (~60s)
  - Valid Schnorr signature from the user's keypair

Error responses (verbatim from live probes):
```
# No header:
HTTP 401 {"error":"Unauthorized","message":"Authorization header not found"}

# Wrong scheme (Bearer):
HTTP 401 {"error":"Unauthorized","message":"Nostr authorization header does not start with `Nostr`"}

# Nostr scheme but invalid base64/JSON:
HTTP 401 {"error":"Unauthorized","message":"Could not parse JSON note from authorization header"}
```

Authorization is validated **before** routing — the pubkey in the NIP-98 event
is extracted and compared against the `:pubkey` URL param on protected routes
(`403 Forbidden` if mismatch).

---

## VAPID Public Key

**Does not exist.** `notepush` has no VAPID key, no Web Push, no browser push
infrastructure whatsoever.

- No `/vapid`, `/vapid-public-key`, `/public-key`, `/push-vapid-key`,
  `/api/v1/vapid` route exists.
- All return `HTTP 401` (auth required), then `HTTP 404 {"error":"Not found"}`
  after valid auth — confirmed by the router fallthrough:
  ```rust
  Ok(APIResponse {
      status: StatusCode::NOT_FOUND,
      body: json!({ "error": "Not found" }),
  })
  ```
- Cargo.toml has no `web-push`, `vapid`, or `wasm` dependency.

**Caching strategy: N/A.** There is no VAPID key to cache.

---

## Register

The API uses path-based registration, not a POST-with-body pattern.

- **Method/Path:** `PUT /user-info/:pubkey/:deviceToken`
- **Auth:** NIP-98 (`:pubkey` must match authorized pubkey)
- **Body:** none (empty body accepted)
- **`:deviceToken`:** An Apple APNS device token (hex string, ~64 chars)
- **Success response:** `HTTP 200` — body not explicitly documented in source;
  the handler calls `save_user_device_info_if_not_present` then returns success
- **Failure modes from source:**
  - `400 {"error":"deviceToken is required on the URL"}` — missing path param
  - `400 {"error":"pubkey is required on the URL"}` — missing path param
  - `400 {"error":"Invalid pubkey"}` — pubkey not valid hex
  - `403 {"error":"Forbidden"}` — NIP-98 pubkey ≠ URL pubkey
  - `401` — any auth error (see above)

### Optional preferences endpoint

After registration, notification preferences can be set:
- **Method/Path:** `PUT /user-info/:pubkey/:deviceToken/preferences`
- **Body (JSON):** `UserNotificationSettings` struct:
  ```json
  {
    "zap_notifications_enabled": true,
    "mention_notifications_enabled": true,
    "repost_notifications_enabled": true,
    "reaction_notifications_enabled": true,
    "dm_notifications_enabled": true,
    "only_notifications_from_following_enabled": false,
    "hellthread_notifications_disabled": false,
    "hellthread_notifications_max_pubkeys": 10
  }
  ```
- **GET** the same path retrieves current preferences.

---

## Unregister

- **Method/Path:** `DELETE /user-info/:pubkey/:deviceToken`
- **Auth:** NIP-98 (same pubkey constraint)
- **Body:** none
- **Success response:** `HTTP 200` (source calls `remove_user_device_info`)
- **Failure modes:** same as register (400/403/401)

---

## Push Payload Received by Client

**Source:** Derived from `damus-io/notepush` source code
(`src/notification_manager/mod.rs`) + `damus-io/damus`
`DamusNotificationService/NotificationService.swift`.

### Delivery mechanism

Notepush sends **APNS payloads** (Apple Push Notification Service), NOT Web Push.
The payload is built using the `a2` APNS crate:

```rust
let mut payload = DefaultNotificationBuilder::new()
    .set_title(&title)
    .set_subtitle(&subtitle)
    .set_body(&body)
    .set_mutable_content()
    .set_content_available()
    .build(device_token, Default::default());

payload.options.apns_topic = Some(self.apns_topic.as_str());
payload.data.insert(
    "nostr_event",
    serde_json::Value::String(event.try_as_json()?),
);
```

### APNS payload field map (what the iOS notification extension receives)

| Field | Type | Description |
|---|---|---|
| `aps.alert.title` | string | Formatted title (e.g. "New DM from…") |
| `aps.alert.subtitle` | string | Formatted subtitle |
| `aps.alert.body` | string | Short message body (fallback only; client reformats) |
| `aps.mutable-content` | 1 | Signals notification service extension to intercept |
| `aps.content-available` | 1 | Silent push flag |
| `nostr_event` | string | **Full serialized Nostr event JSON** (verbatim) |

The iOS `NotificationService` reads `userInfo["nostr_event"]` as a JSON string
and parses it with `NdbNote.owned_from_json`.

### Web Push payload (not applicable)

There is **no Web Push delivery path**. The server does not send to browser push
endpoints. There is no `endpoint`, `p256dh`, or `auth` field handling anywhere
in the codebase.

### Discriminator decision for SW handler

Since `notify.damus.io` delivers APNS only, a Web Service Worker will never
receive a push from this server directly. The discriminator question is moot for
this relay.

**If Nostra implements Web Push via a different relay:** the SW should
discriminate on the presence of a `nostr_event` field (string) in
`event.data.json()`. This matches notepush's own data key. There is no `app:`
marker in the payload — use `typeof payload.nostr_event === 'string'` as the
discriminator. SW must parse `nostr_event` directly (full event JSON is
included; no relay refetch required).

---

## Failure Modes / Open Issues for Downstream Tasks

### BLOCKER: No Web Push support

`notify.damus.io` / `damus-io/notepush` is APNS-only. It cannot deliver push
notifications to browser Service Workers. The planned T5/T7/T9 architecture
assumes a Web Push relay — **that relay does not exist at Damus**.

**Decision required (escalate to human):**

**Option A — Use a different Web Push relay.**
Several open-source Nostr Web Push relays exist that do support Web Push/VAPID
(e.g. `rust-nostr/nostr-webpush`, community relays). Nostra would need to
choose/host one.

**Option B — Run our own notepush fork with Web Push added.**
Fork `notepush`, add a Web Push delivery path (using the `web-push` Rust crate),
store `{pubkey, endpoint, p256dh, auth}` tuples instead of APNS tokens. The HTTP
API contract is clean and extensible. Estimated effort: 2-3 days Rust work.

**Option C — Skip Damus relay entirely; use a self-hosted minimal relay.**
A minimal Rust/Node push relay that: (1) accepts `PUT /user-info/:pubkey`
with a Web Push subscription JSON body, (2) subscribes to a Nostr relay for
kind 1059 events tagged to that pubkey, (3) forwards via Web Push. No APNS
complexity.

**Option D — Abandon the push-notif feature or defer.**
Scope is broader than initially estimated. Damus cannot be used as-is.

### Additional issues

1. **NIP-98 auth construction is non-trivial in a SW context.** The SW has
   no direct access to the user's nsec. The nostra identity loader (T4) must
   expose a signing primitive callable from the SW, or the registration call
   must originate from the main thread (simpler).

2. **No VAPID key endpoint.** If Nostra runs its own relay, it needs to expose
   a VAPID public key endpoint (unauthenticated GET). Downstream T5 must fetch
   this before calling `pushManager.subscribe()`.

3. **`deviceToken` semantics differ.** In the Web Push world the
   "deviceToken" URL param would need to be a stable opaque identifier for
   the subscription (e.g. SHA-256 of the endpoint URL). The API path pattern
   `PUT /user-info/:pubkey/:deviceToken` is reusable as-is.

4. **Kind 1059 is not in `is_event_kind_supported`** in `notepush`. If we fork,
   the supported-kinds list must be extended to include 1059 (gift-wrap DMs).
   Currently only kinds 1, 4, 6, 16, 7, 9735 trigger notifications.

---

## API Contract Summary (verbatim, for downstream tasks to consume)

```
Base URL: https://notify.damus.io   (APNS relay — NOT usable for Web Push)

Auth: Authorization: Nostr <base64(JSON-kind-27235-event)>   [NIP-98]

Routes:
  PUT    /user-info/:pubkey/:deviceToken              → register APNS token
  DELETE /user-info/:pubkey/:deviceToken              → unregister
  GET    /user-info/:pubkey/:deviceToken/preferences  → get notification prefs
  PUT    /user-info/:pubkey/:deviceToken/preferences  → set notification prefs

Push payload key: "nostr_event" (string) = full Nostr event JSON
Push transport: Apple APNS only
VAPID / Web Push: NOT SUPPORTED
```

---

## Sources

- Probes run: 2026-04-26 (all endpoints — 12 GET/POST/DELETE probes)
- Source: `damus-io/notepush` master branch
  - `src/api_request_handler.rs` — full router + handlers
  - `src/nip98_auth.rs` — NIP-98 validation logic (matches live error messages verbatim)
  - `src/notification_manager/mod.rs` — DB schema + APNS send path
- Source: `damus-io/damus` master branch
  - `damus/Features/Notifications/Models/PushNotificationClient.swift` — iOS client
  - `DamusNotificationService/NotificationService.swift` — iOS notification extension
- Cross-check: zero Web Push / VAPID / `webpush` crate references found in any file
