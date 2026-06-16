# NIP-17 alignment + Markdown

Goal: make PhantomChat's 1:1 **text** DMs interoperable with standard NIP-17
clients (0xchat, Amethyst), and render **Markdown** in the bubble. This is a
cross-repo, phased migration touching both `phantomchat` (PWA) and `phantombot`
(Lena's runtime) — they must move in lockstep or the live Andrew↔Lena path
breaks.

## Current divergence (small, but core-path)

The NIP-17 **outer** structure already matches the spec: kind 1059 gift-wrap →
kind 13 seal → kind 14 rumor. The **only** deviation is the kind-14 rumor's
`.content`:

- **Standard NIP-17:** `content` = the plain message text. Identity/metadata come
  from native event fields (`pubkey` = sender, `p` tag = recipient, `created_at`
  = time, the rumor's own `id` = message id).
- **PhantomChat today:** `content` = a JSON envelope
  `{id, from, to, type, content, timestamp}`. Every field except the inner
  `content`/`type` duplicates a native field.

So aligning text = **drop the envelope, put plain text in `content`**. Files stay
on the JSON-content path for now (kind 15 is a later follow-up); reactions/edits/
receipts/groups are *not* NIP-17 and stay custom (they won't interop with stock
clients, but that's out of scope — NIP-17 is just the encrypted-DM transport).

## Key de-risking fact

**PWA receive already dual-reads.** `chat-api-receive.ts::parseMessageContent`
returns `{content, type:'text'}` when `content` isn't JSON, and the message id
falls back to the rumor id (`parsed.id || msg.id`). So the PWA can already
*receive* standard plain-text DMs and key them by rumor id. No receive change
needed on the PWA.

What remains:
- **phantombot receive** (`channel.ts`): currently `JSON.parse(rumor.content)` +
  requires `type === 'text'` → a plain-text rumor is dropped as "not valid JSON".
  Needs dual-read.
- **Send side, both apps**: switch text sends from the envelope to plain content.
- **phantombot send** (`transport.ts`): confirm/align to plain content.
- **Markdown rendering** in PWA bubbles.

## Phased plan (ordering matters — never break the live path)

A send-switch on one side is only safe once the *other* side can read the new
format. PWA receive is already dual-read, so the gating dependency is:
**phantombot must dual-read (and be deployed to Lena) before the PWA switches
its send to plain text.**

1. **phantombot dual-read** (`phantombot` repo): accept a plain-text rumor as a
   text message in addition to the JSON envelope. Non-breaking. **Rebuild +
   deploy to Lena's box** before step 2.
2. **PWA send → plain text** (`phantomchat` repo, this PR): text rumor `content`
   = the raw text (no envelope). Safe once (1) is deployed: Lena dual-reads
   PWA's plain text; the PWA already dual-reads Lena's (still-envelope) replies.
   ⚠️ Pushing this branch auto-deploys to prod (dogfood rule), so (1) must be
   live on Lena first.
3. **phantombot send → plain text** + redeploy to Lena. Safe because the PWA
   already dual-reads.
4. **Cleanup**: once both sides send plain and old messages have aged past
   relevance, retire the envelope writer. Keep dual-read indefinitely for
   stored/legacy messages.

### Identity keying (the subtle part)
The envelope's `id` was the app message id used to key reactions/edits/deletes/
receipts. Standard nostr uses the **rumor event id**. The receive path already
falls back to `msg.id`; the send path must key its store row + delivery tracking
off the canonical **rumor id** (`result.rumorId`), which it already captures.
Verify reactions/edit/delete/receipt `['e', …]` references resolve to the rumor
id on both sides before retiring the envelope.

## Markdown

Formatting is a **rendering** concern, orthogonal to the wire format — the body
is a `string` either way. Send Markdown as the plain text; render it richly in
PhantomChat bubbles (bold, code, code blocks; tables degrade in stock clients).
Lena (an LLM) already emits Markdown. Approach: convert the message text to tweb
MessageEntities (or a scoped Markdown renderer for phantomchat bubbles) at render
time. Graceful degradation: stock NIP-17 clients show the raw Markdown.

## Test gates
- After step 1: Lena still replies to an envelope message (regression) AND to a
  plain-text message (new) — verified on the wire + Lena logs.
- After step 2: a cold + warm PWA→Lena message round-trips with a real reply;
  a stock NIP-17 client (0xchat) using the same relays can read a PWA→peer DM.
- Markdown: bold/code render in-app; raw Markdown is still legible in 0xchat.
