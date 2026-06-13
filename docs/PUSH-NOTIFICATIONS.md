# Background push notifications

PhantomChat.chat can deliver system notifications when the app is closed by registering with a Nostr push relay. The default relay is `https://push.phantomchat.chat`, an open-source Web Push relay (`nostr-webpush-relay`, AGPL-3.0) operated for the PhantomChat.chat user base.

## What the push relay sees

- Your public key (npub).
- Your browser's Web Push endpoint (Google FCM, Mozilla, or Apple push gateway).
- Your IP address — **unless** Tor is enabled (Settings → Privacy).
- The frequency at which messages arrive for you.

## What the push relay does NOT see

- The contents of your messages (end-to-end encrypted, NIP-44).
- Who is sending you messages — the wrapper public key in NIP-59 is ephemeral and randomized.

## What the OS push gateway (Google/Mozilla/Apple) sees

- Your device identity (linked to your browser/OS account).
- That a push payload was delivered to you.
- The encrypted payload itself (cannot be decrypted by the gateway).

This part is structural to Web Push and cannot be eliminated.

## Authentication

Every registration and unregistration request to the push relay is authenticated with a NIP-98 signed event from your private key. Only you can register or remove subscriptions tied to your npub.

## Preview levels

- **Generic** (default): Notifications show "PhantomChat.chat — new message". No sender, no content. Maximum privacy on the lockscreen.
- **Sender + content**: Notifications show the sender's name and the first ~80 characters of the message.
- **Sender only**: Notifications show the sender's name and "[encrypted]".

For B and C, the Service Worker reads your private key from local storage (IndexedDB) to decrypt the gift-wrap. The key never leaves your device.

## Endpoint override

Advanced users can swap the push relay from Settings → Notifications → Advanced. The protocol is documented at the relay's repository. To self-host, see [github.com/phantomchat-chat/nostr-webpush-relay](https://github.com/phantomchat-chat/nostr-webpush-relay).

## CORS requirement (operators)

The relay's HTTP endpoints (`/info`, `/subscription/*`) are called from the PhantomChat.chat origin via `fetch()`. The server **must** respond with permissive CORS headers, otherwise the browser blocks the response and push subscription silently fails:

```
Access-Control-Allow-Origin: https://phantomchat.chat
Access-Control-Allow-Methods: GET, PUT, DELETE
Access-Control-Allow-Headers: Content-Type, Authorization
```

If you observe `[PhantomChatPushClient] /info fetch failed` with `Failed to fetch` in the browser console (and a `No 'Access-Control-Allow-Origin' header is present` warning above it), the relay is missing CORS headers. Fix on the server — the client cannot work around this.

## Disabling

Settings → Notifications → "Enable background notifications" toggle off sends an authenticated DELETE to the push relay and removes the local subscription. Logging out or resetting local data does the same.

## Tor

With Tor enabled (Settings → Privacy → Tor mode "Always" or "When available"), the registration and unregistration HTTP requests route through Tor. The Web Push delivery itself goes through Google/Mozilla/Apple infrastructure and cannot be tunneled.

## Source code

The push relay server is open source under AGPL-3.0 at [github.com/phantomchat-chat/nostr-webpush-relay](https://github.com/phantomchat-chat/nostr-webpush-relay). The protocol contract (HTTP routes, NIP-98 auth header format, push payload schema) is specified in the relay repo's `docs/PROTOCOL.md`.
