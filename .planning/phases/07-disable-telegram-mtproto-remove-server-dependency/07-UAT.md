---
status: complete
phase: 07-disable-telegram-mtproto-remove-server-dependency
source: [07-01-SUMMARY.md, 07-02-SUMMARY.md, 07-03-SUMMARY.md]
started: 2026-04-03T07:30:00Z
updated: 2026-04-03T08:00:00Z
---

## Current Test

[testing complete]

## Tests

### 1. App loads without MTProto connections
expected: Open Nostra.chat in browser. Complete onboarding. The app loads to the chat list without any network errors about Telegram servers. No "Waiting for network..." indicator — search bar shows "Search".
result: pass

### 2. Connection status shows relay state
expected: The connection indicator reflects Nostr relay connectivity, not MTProto DC status. If relays are reachable, it shows "Search". If ALL relays go down, it shows "Reconnecting...".
result: pass

### 3. Add P2P contact via npub paste
expected: Open Contacts, paste an npub into the search bar. A P2P contact appears in the chat list with a colored avatar and "P2P XXXXXX" name.
result: pass

### 4. Click P2P contact opens chat
expected: Clicking the P2P contact in the sidebar opens the chat panel. The topbar shows the contact name, avatar, and "last seen a long time ago". The message input with "Message" placeholder and green send button are visible.
result: pass

### 5. Send message to P2P contact
expected: Type "ciao" in the message field and click send. The message appears as a bubble in the chat with "Today" header and timestamp. The input field clears after sending.
result: pass

### 6. P2P contact persists in sidebar after message send
expected: After sending a message, the P2P contact remains visible in the sidebar chat list. It does NOT disappear.
result: pass

### 7. No page crash on message send
expected: Sending a message does NOT cause the page to go white/blank or reload. The chat remains open and functional after sending.
result: pass

### 8. Console has no critical errors
expected: After full flow (onboarding → add contact → open chat → send message), the browser console has zero errors related to "window is not defined", "reading 'id'", "reading 'includes'", "reading 'map'", or "sensitive_can_change". Only WebSocket relay errors (if relays unreachable) are acceptable.
result: pass

## Summary

total: 8
passed: 8
issues: 0
pending: 0
skipped: 0

## Gaps

[none]
