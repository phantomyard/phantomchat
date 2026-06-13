/*
 * Nostra.chat — Virtual MTProto Bridge Invariants
 *
 * Consolidates the middleware rules previously documented only in prose in
 * CLAUDE.md ("Virtual MTProto Middleware Rules" table) into runtime-
 * verifiable predicates + validators. This file is the single source of
 * truth for what "a correct bridge object" looks like; tests and selected
 * call sites delegate here instead of duplicating ad-hoc checks.
 *
 * Design:
 *   - Predicates (isX / hasY): boolean helpers, no side effects
 *   - Validators (validateX): return {ok, reason} — never throw
 *   - assertInvariant(): logs a warning at Logger level (visible when
 *     DEBUG=true) and never throws. This keeps production behavior
 *     identical while giving developers signal during local + E2E runs.
 *
 * Rule numbering below matches the CLAUDE.md table ordering so the two
 * documents stay greppable together.
 */

import {logger} from '@lib/logger';

const log = logger('Nostra/bridge-invariants');

// ─── Constants ────────────────────────────────────────────────────────

/** Lower bound of the synthetic P2P peer-id range. Duplicated from
 *  `nostra-bridge.ts` (VIRTUAL_PEER_BASE = BigInt(10 ** 15)) as a plain
 *  number so this module stays Worker-safe (nostra-bridge drags in
 *  main-thread-only imports). Keep the two in sync. */
export const P2P_PEER_ID_MIN = 1e15;

/** Action prefixes that MUST NOT appear in NOSTRA_ACTION_PREFIXES. Query
 *  methods need shaped responses, not a bare `true` (Rule 2). */
export const FORBIDDEN_ACTION_PREFIXES = ['.get', '.check'] as const;

/** Bridge methods that MUST be present in NOSTRA_BRIDGE_METHODS. Without
 *  these the `.edit` / `.send` action-prefix short-circuit fires first
 *  (Rule 15). */
export const REQUIRED_BRIDGE_METHODS = [
  'messages.editMessage',
  'messages.sendMessage',
  'messages.getHistory',
  'messages.getDialogs'
] as const;

/** App message ID format: `chat-<peerId>-<sequence>`. Used for delivery
 *  tracker keys, P2P edit tags, and event persistence (Rules 9, 16, 17). */
export const APP_MESSAGE_ID_REGEX = /^chat-\d+-\d+$/;

// ─── Shared types ─────────────────────────────────────────────────────

export type InvariantResult =
  | {ok: true}
  | {ok: false; reason: string};

/** Log an invariant violation without throwing. Call sites that wire
 *  invariants into production code use this so a missed rule degrades
 *  gracefully while still being visible in DEBUG logs. Tests that want
 *  hard failures should inspect the result object instead. */
export function assertInvariant(rule: string, result: InvariantResult): void {
  if(result.ok) return;
  const failed = result as {ok: false; reason: string};
  log.warn('[' + rule + '] invariant violated:', failed.reason);
}

// ─── Predicates ───────────────────────────────────────────────────────

/** Returns true if peerId is in the synthetic P2P range (Rule 13). */
export function isP2PPeerId(peerId: number): boolean {
  return peerId >= P2P_PEER_ID_MIN;
}

/** Returns true if id matches the `chat-XXX-N` app message format used by
 *  the delivery tracker and P2P edit protocol (Rules 9, 16, 17). */
export function isAppMessageId(id: unknown): id is string {
  return typeof id === 'string' && APP_MESSAGE_ID_REGEX.test(id);
}

/** Chooses the correct eventId for message-store persistence: prefers
 *  the relay-assigned rumor hex when present, falls back to the app
 *  message id. Writing the "wrong" id → duplicate rows → two bubbles
 *  (Rule 9). */
export function pickPersistenceEventId(msg: {id?: string; relayEventId?: string}): string | undefined {
  return msg?.relayEventId || msg?.id;
}

// ─── Configuration validators (Rules 2, 15) ───────────────────────────

/** Rule 2: NOSTRA_ACTION_PREFIXES must not contain `.get` or `.check`.
 *  A wildcard action-prefix match on a query method returns bare `true`
 *  instead of a shaped response, breaking downstream managers. */
export function validateActionPrefixes(prefixes: ReadonlyArray<string>): InvariantResult {
  for(const forbidden of FORBIDDEN_ACTION_PREFIXES) {
    if(prefixes.includes(forbidden)) {
      return {ok: false, reason: 'NOSTRA_ACTION_PREFIXES contains forbidden prefix: ' + forbidden};
    }
  }
  return {ok: true};
}

/** Rule 15: NOSTRA_BRIDGE_METHODS must include the edit/send/history
 *  methods that need real data. Missing methods fall through to the
 *  `.edit`/`.send`/`.get*` action handler and silently break. */
export function validateBridgeMethods(methods: ReadonlySet<string> | ReadonlyArray<string>): InvariantResult {
  const asSet = methods instanceof Set ? methods : new Set(methods);
  for(const required of REQUIRED_BRIDGE_METHODS) {
    if(!asSet.has(required)) {
      return {ok: false, reason: 'NOSTRA_BRIDGE_METHODS missing required method: ' + required};
    }
  }
  return {ok: true};
}

// ─── Message shape validators (Rules 6, 12) ───────────────────────────

/** Rule 6: incoming Nostr messages must be built via
 *  `mapper.createTwebMessage()` — never round-tripped through
 *  message-store before dispatch. A proper tweb message has `mid`,
 *  `peerId`, and a timestamp. */
export function validateTwebMessage(msg: unknown): InvariantResult {
  if(!msg || typeof msg !== 'object') {
    return {ok: false, reason: 'message is not an object'};
  }
  const m = msg as Record<string, unknown>;
  if(typeof m.mid !== 'number' && typeof m.mid !== 'string') {
    return {ok: false, reason: 'message.mid missing or wrong type'};
  }
  if(typeof m.peerId !== 'number') {
    return {ok: false, reason: 'message.peerId missing or wrong type'};
  }
  if(typeof m.date !== 'number') {
    return {ok: false, reason: 'message.date missing or wrong type'};
  }
  if(m.message === undefined && m.media === undefined) {
    return {ok: false, reason: 'message must have either .message (text) or .media'};
  }
  return {ok: true};
}

/** Rule 12: Virtual MTProto `messages.sendMessage` bridge response must
 *  carry `nostraMid` (number) + `nostraEventId` (string). The Worker's
 *  P2P shortcut uses these to rename the temp `0.0001` mid to the real
 *  timestamp-derived mid. Missing → outgoing bubbles sort wrong. */
export function validateSendMessageResponse(response: unknown): InvariantResult {
  if(!response || typeof response !== 'object') {
    return {ok: false, reason: 'response is not an object'};
  }
  const r = response as Record<string, unknown>;
  if(typeof r.nostraMid !== 'number') {
    return {ok: false, reason: 'response.nostraMid missing or wrong type'};
  }
  if(typeof r.nostraEventId !== 'string' || r.nostraEventId.length === 0) {
    return {ok: false, reason: 'response.nostraEventId missing or empty'};
  }
  return {ok: true};
}

// ─── Dialog shape validator (Rule 8) ──────────────────────────────────

/** Rule 8: synthetic dialogs dispatched via `dialogs_multiupdate` must
 *  carry the full message object on `topMessage`, not just the mid. Else
 *  `setLastMessage` falls back to `getMessageByPeer` and fails when
 *  `hasReachedTheEnd=false`. */
export function validateDialogTopMessage(dialog: unknown): InvariantResult {
  if(!dialog || typeof dialog !== 'object') {
    return {ok: false, reason: 'dialog is not an object'};
  }
  const d = dialog as Record<string, unknown>;
  if(d.topMessage == null) {
    return {ok: false, reason: 'dialog.topMessage missing'};
  }
  if(typeof d.topMessage !== 'object') {
    return {ok: false, reason: 'dialog.topMessage must be a full message object, got ' + typeof d.topMessage};
  }
  return {ok: true};
}

// ─── P2P edit validator (Rule 16) ─────────────────────────────────────

/** Rule 16: P2P edits are new NIP-17 gift-wraps carrying
 *  `['nostra-edit', '<originalAppMessageId>']`. The edit must drop if
 *  the rumor pubkey doesn't match the original sender — otherwise anyone
 *  could rewrite anyone's messages. */
export function validateP2PEditAuthor(
  rumorPubkey: string,
  originalSenderPubkey: string
): InvariantResult {
  if(!rumorPubkey || !originalSenderPubkey) {
    return {ok: false, reason: 'missing rumorPubkey or originalSenderPubkey'};
  }
  if(rumorPubkey !== originalSenderPubkey) {
    return {
      ok: false,
      reason: 'edit author mismatch: rumor=' + rumorPubkey.slice(0, 8) +
        '… original=' + originalSenderPubkey.slice(0, 8) + '…'
    };
  }
  return {ok: true};
}

// ─── Tweb user name validator (Rules 1, 5) ────────────────────────────

/** Rules 1 + 5: when building/persisting a tweb User for a P2P peer, the
 *  `first_name` must match the virtual-peers-db mapping's `displayName`
 *  when one is set. Otherwise reload → hex-fallback names overwrite the
 *  correct profile-derived names. */
export function validateTwebUserName(
  user: {first_name?: string} | null | undefined,
  mapping: {displayName?: string} | null | undefined
): InvariantResult {
  if(!mapping?.displayName) return {ok: true}; // no mapping → no constraint
  if(!user) {
    return {ok: false, reason: 'user missing but mapping has displayName=' + mapping.displayName};
  }
  if(user.first_name !== mapping.displayName) {
    return {
      ok: false,
      reason: 'user.first_name="' + user.first_name + '" does not match mapping.displayName="' + mapping.displayName + '"'
    };
  }
  return {ok: true};
}

// ─── Delivery tracker validator (Rule 17) ─────────────────────────────

/** Rule 17: delivery tracker state is keyed by the **app** message id
 *  (`chat-XXX-N`), never by the rumor hex. Receipts arriving with a
 *  raw rumor id silently no-op because the tracker has nothing to match. */
export function validateDeliveryReceiptId(id: unknown): InvariantResult {
  if(!isAppMessageId(id)) {
    return {
      ok: false,
      reason: 'delivery receipt id must be chat-XXX-N format, got: ' + String(id)
    };
  }
  return {ok: true};
}

// ─── Own pubkey presence (Rule 4) ─────────────────────────────────────

/** Rule 4: `window.__nostraOwnPubkey` must be set once onboarding
 *  completes — contact add + persist paths read it. */
export function validateOwnPubkeySet(): InvariantResult {
  if(typeof window === 'undefined') return {ok: true}; // Worker/Node: not applicable
  const pubkey = (window as unknown as {__nostraOwnPubkey?: string}).__nostraOwnPubkey;
  if(typeof pubkey !== 'string' || pubkey.length === 0) {
    return {ok: false, reason: 'window.__nostraOwnPubkey is not set'};
  }
  return {ok: true};
}

// ─── History-append gating (Rule 13) ──────────────────────────────────

/** Rule 13: `beforeMessageSending` MUST skip `history_append` dispatch
 *  for P2P peers. Main-thread `injectOutgoingBubble` is the sole render
 *  path for outgoing P2P bubbles — a dual dispatch duplicates the DOM. */
export function shouldSkipHistoryAppend(peerId: number): boolean {
  return isP2PPeerId(peerId);
}
