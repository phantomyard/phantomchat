/*
 * Gate envelopes (phantomchat#498): when a phantombot turn pauses on an
 * approval or secret gate, the engine may deliver the gate's control text as
 * the turn's reply, and the channel publishes it like any other message.
 * That text is protocol, not chat: it names the internal control-plane
 * endpoints (POST /api/v1/gates/<id>/approve|deny|secret) and, in groups,
 * broadcasts them to every member. The engine-side fix (never letting the
 * envelope reach a channel, plus a real approval UI over the desktop
 * bridge) is tracked separately in phantombot; this module is PhantomChat's
 * defense-in-depth.
 *
 * A payload that is ENTIRELY a bracketed gate envelope is swapped for a
 * neutral placeholder at every receive entry point: the 1:1 relay handler
 * (chat-api-receive.ts) and group live receive + group history backfill
 * (both funnel through handleGroupIncoming in phantomchat-groups-sync.ts).
 * An envelope merely quoted inside a longer message is left untouched —
 * that is someone talking about the gate, not the gate itself.
 */

/** Which kind of engine gate the envelope pauses on. */
export type GateKind = 'approval' | 'secret';

/**
 * Anchored full-payload match. Only three things are load-bearing: the
 * bracketed prefix, the gates endpoint the envelope directs the operator to,
 * and the envelope spanning the whole payload. The wording between them is
 * the engine's to change.
 */
const GATE_ENVELOPE_PATTERN =
  /^\[(Approval needed|Secret needed)\b[\s\S]*\/api\/v1\/gates\/[\s\S]*\]$/;

/** Envelopes are a few hundred bytes; anything longer is not one. */
const MAX_GATE_PAYLOAD_LENGTH = 4000;

/** True when the whole payload is a gate envelope of the given kind. */
export function matchGateEnvelope(text: string): GateKind | null {
  if(typeof text !== 'string') return null;
  const trimmed = text.trim();
  if(!trimmed || trimmed.length > MAX_GATE_PAYLOAD_LENGTH) return null;
  const match = GATE_ENVELOPE_PATTERN.exec(trimmed);
  return match ? (match[1] === 'Approval needed' ? 'approval' : 'secret') : null;
}

/** Neutral bubble text; matches the lang.ts defaults so pre-boot receive
 *  paths (and tests without a wired resolver) never show protocol internals. */
export const GATE_PLACEHOLDER: Record<GateKind, string> = {
  approval: 'Waiting for the operator to approve this action.',
  secret: 'Waiting for the operator to provide a required secret.'
};

const GATE_LANG_KEYS: Record<GateKind, string> = {
  approval: 'Chat.Gate.ApprovalPaused',
  secret: 'Chat.Gate.SecretPaused'
};

type Localizer = (key: string) => string | undefined;

let localizer: Localizer = () => undefined;

/**
 * Boot wires the app's i18n here (index.ts). The default returns nothing,
 * which falls back to the English placeholders above.
 */
export function setGatePlaceholderResolver(resolver: Localizer): void {
  localizer = resolver;
}

/** Neutral bubble text for a matched gate envelope. */
export function resolveGatePlaceholder(kind: GateKind): string {
  const localized = localizer(GATE_LANG_KEYS[kind]);
  // A missing pack makes I18n.format return the key itself; treat that as
  // "not localized" rather than leaking the raw key into a bubble.
  return localized && localized !== GATE_LANG_KEYS[kind] ? localized : GATE_PLACEHOLDER[kind];
}
