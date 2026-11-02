/*
 * The per-contact "Local PC access" gate (issue #276).
 *
 * Stored by the main process and never derived from anything a remote sends. A
 * contact is ON only after the native Allow dialog was accepted. A kind-0
 * `bot: true` grants nothing: this file does not know that flag exists.
 *
 * Deliberately has no Electron import, so the rules can be tested directly.
 */
export const LOCAL_ACCESS_FILE = 'local-access.json';
/** The furthest ahead a call may set its expiry. Bounds the replay memory below. */
export const MAX_CALL_LIFETIME_MS = 10 * 60_000;

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

export function isHexPubkey(value: unknown): value is string {
  return typeof value === 'string' && HEX_PUBKEY.test(value);
}

export interface LocalAccessState {
  /** Identifies this PC to phantoms. Random per install, never sent to relays in the clear. */
  deviceId: string;
  /** Whose switches these are. A different login starts with everything OFF. */
  ownerPubkey: string | null;
  /** Contacts with the switch ON, mapped to when it was turned on. */
  enabled: Record<string, number>;
  /** Handled call ids and their expiry, so a relay replay cannot run a call twice. */
  seenCalls: Record<string, number>;
}

export function defaultLocalAccess(deviceId: string): LocalAccessState {
  return {deviceId, ownerPubkey: null, enabled: {}, seenCalls: {}};
}

export function parseLocalAccess(raw: unknown, newDeviceId: () => string): LocalAccessState {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<LocalAccessState>;
  const state = defaultLocalAccess(
    typeof input.deviceId === 'string' && /^[0-9a-f]{32}$/.test(input.deviceId) ? input.deviceId : newDeviceId()
  );
  state.ownerPubkey = isHexPubkey(input.ownerPubkey) ? input.ownerPubkey : null;
  for(const [pubkey, at] of Object.entries(input.enabled ?? {})) {
    if(isHexPubkey(pubkey) && typeof at === 'number') state.enabled[pubkey] = at;
  }
  for(const [callId, expiry] of Object.entries(input.seenCalls ?? {})) {
    if(typeof expiry === 'number') state.seenCalls[callId] = expiry;
  }
  return state;
}

/** Fail closed when the signed-in identity changes. Returns true if anything was cleared. */
export function setOwner(state: LocalAccessState, ownerPubkey: string): boolean {
  if(state.ownerPubkey === ownerPubkey) return false;
  const hadSwitches = Object.keys(state.enabled).length > 0;
  state.ownerPubkey = ownerPubkey;
  state.enabled = {};
  state.seenCalls = {};
  return hadSwitches;
}

export function isEnabled(state: LocalAccessState, pubkey: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.enabled, pubkey);
}

export const LOCAL_TOOL_NAMES = ['bash', 'read', 'write', 'edit', 'ls', 'find', 'grep'] as const;
export type LocalToolName = typeof LOCAL_TOOL_NAMES[number];

export interface ToolCall {
  callId: string;
  deviceId: string;
  tool: LocalToolName;
  args: Record<string, unknown>;
  /** Unix milliseconds. */
  expiresAt: number;
  /** Set when the call is made from inside a group-class chat. */
  groupId?: string;
  timeoutMs?: number;
}

export function parseToolCall(raw: unknown): ToolCall | null {
  if(!raw || typeof raw !== 'object') return null;
  const call = raw as Record<string, unknown>;
  if(typeof call.callId !== 'string' || !/^[\w-]{1,64}$/.test(call.callId)) return null;
  if(typeof call.deviceId !== 'string') return null;
  if(typeof call.tool !== 'string' || !LOCAL_TOOL_NAMES.includes(call.tool as LocalToolName)) return null;
  if(!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) return null;
  if(typeof call.expiresAt !== 'number' || !Number.isFinite(call.expiresAt)) return null;
  if(call.groupId !== undefined && typeof call.groupId !== 'string') return null;
  if(call.timeoutMs !== undefined && typeof call.timeoutMs !== 'number') return null;
  return call as unknown as ToolCall;
}

/** What the renderer read from its group store for `call.groupId`. */
export interface CallGroupInfo {
  isSession: boolean;
  members: string[];
}

export type CallDecision = 'run' | 'switch-off' | 'wrong-device' | 'expired' | 'replay' | 'group-denied' | 'no-owner';

/**
 * The whole gate. Everything but 'run' gets no answer at all: the sender learns
 * nothing about this PC, and the capability is not advertised to it.
 */
export function decideToolCall(input: {
  state: LocalAccessState;
  sender: string;
  call: ToolCall;
  group?: CallGroupInfo | null;
  now: number;
}): CallDecision {
  const {state, sender, call, group, now} = input;
  if(!state.ownerPubkey) return 'no-owner';
  if(!isEnabled(state, sender)) return 'switch-off';
  if(call.deviceId !== state.deviceId) return 'wrong-device';
  if(call.expiresAt <= now || call.expiresAt > now + MAX_CALL_LIFETIME_MS) return 'expired';
  if(state.seenCalls[call.callId] !== undefined) return 'replay';
  if(call.groupId !== undefined) {
    // A Session with a contact whose switch is ON counts as that contact. Other
    // members change nothing: the switch belongs to the verified sender.
    if(!group?.isSession || !group.members.includes(sender)) return 'group-denied';
  }
  return 'run';
}

export function rememberCall(state: LocalAccessState, call: ToolCall, now: number): void {
  for(const [callId, expiry] of Object.entries(state.seenCalls)) {
    if(expiry <= now) delete state.seenCalls[callId];
  }
  state.seenCalls[call.callId] = call.expiresAt;
}
