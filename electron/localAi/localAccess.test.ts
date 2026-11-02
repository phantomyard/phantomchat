import {describe, expect, it} from 'vitest';
import {
  decideToolCall, defaultLocalAccess, isEnabled, MAX_CALL_LIFETIME_MS, parseLocalAccess, parseToolCall,
  rememberCall, setOwner, type LocalAccessState, type ToolCall
} from './localAccess';

const OWNER = 'a'.repeat(64);
const PHANTOM = 'b'.repeat(64);
const STRANGER = 'c'.repeat(64);
const DEVICE = 'd'.repeat(32);
const NOW = 1_000_000;

function state(on = true): LocalAccessState {
  const s = defaultLocalAccess(DEVICE);
  s.ownerPubkey = OWNER;
  if(on) s.enabled[PHANTOM] = NOW;
  return s;
}

function call(extra: Partial<ToolCall> = {}): ToolCall {
  return {callId: 'c1', deviceId: DEVICE, tool: 'bash', args: {command: 'ls'}, expiresAt: NOW + 1000, ...extra};
}

describe('decideToolCall', () => {
  it('runs for a contact with the switch ON', () => {
    expect(decideToolCall({state: state(), sender: PHANTOM, call: call(), now: NOW})).toBe('run');
  });

  it('gives nothing with the switch OFF', () => {
    expect(decideToolCall({state: state(false), sender: PHANTOM, call: call(), now: NOW})).toBe('switch-off');
  });

  it('gives nothing to an unknown npub', () => {
    expect(decideToolCall({state: state(), sender: STRANGER, call: call(), now: NOW})).toBe('switch-off');
  });

  it('is on by the switch alone: the default for every contact is OFF', () => {
    expect(isEnabled(defaultLocalAccess(DEVICE), PHANTOM)).toBe(false);
    expect(isEnabled(parseLocalAccess({}, () => DEVICE), PHANTOM)).toBe(false);
  });

  it('ignores a call for another device', () => {
    const decision = decideToolCall({state: state(), sender: PHANTOM, call: call({deviceId: 'e'.repeat(32)}), now: NOW});
    expect(decision).toBe('wrong-device');
  });

  it('drops a call past its expiry, or claiming too long a life', () => {
    expect(decideToolCall({state: state(), sender: PHANTOM, call: call({expiresAt: NOW}), now: NOW})).toBe('expired');
    const tooLong = call({expiresAt: NOW + MAX_CALL_LIFETIME_MS + 1});
    expect(decideToolCall({state: state(), sender: PHANTOM, call: tooLong, now: NOW})).toBe('expired');
  });

  it('does not run a replayed call', () => {
    const s = state();
    rememberCall(s, call(), NOW);
    expect(decideToolCall({state: s, sender: PHANTOM, call: call(), now: NOW})).toBe('replay');
  });

  it('allows a Session with that contact', () => {
    const group = {isSession: true, members: [OWNER, PHANTOM]};
    expect(decideToolCall({state: state(), sender: PHANTOM, call: call({groupId: 'g'}), group, now: NOW})).toBe('run');
    expect(decideToolCall({state: state(false), sender: PHANTOM, call: call({groupId: 'g'}), group, now: NOW})).toBe('switch-off');
  });

  it('allows a Session with others in it, and refuses other groups or a Session without the sender', () => {
    const decide = (group: {isSession: boolean; members: string[]} | null) =>
      decideToolCall({state: state(), sender: PHANTOM, call: call({groupId: 'g'}), group, now: NOW});
    expect(decide({isSession: false, members: [OWNER, PHANTOM]})).toBe('group-denied');
    expect(decide({isSession: true, members: [OWNER, PHANTOM, STRANGER]})).toBe('run');
    expect(decide({isSession: true, members: [OWNER, STRANGER]})).toBe('group-denied');
    expect(decide(null)).toBe('group-denied');
  });

  it('refuses everything before anyone is signed in', () => {
    const s = state();
    s.ownerPubkey = null;
    expect(decideToolCall({state: s, sender: PHANTOM, call: call(), now: NOW})).toBe('no-owner');
  });
});

describe('state', () => {
  it('turns every switch off when a different identity signs in', () => {
    const s = state();
    expect(setOwner(s, STRANGER)).toBe(true);
    expect(isEnabled(s, PHANTOM)).toBe(false);
    expect(setOwner(s, STRANGER)).toBe(false);
  });

  it('survives a malformed file without granting anything', () => {
    const s = parseLocalAccess({deviceId: 'x', enabled: {nope: 1, [PHANTOM]: 'yes'}, ownerPubkey: 5}, () => DEVICE);
    expect(s.deviceId).toBe(DEVICE);
    expect(s.enabled).toEqual({});
    expect(s.ownerPubkey).toBeNull();
  });

  it('forgets expired call ids', () => {
    const s = state();
    s.seenCalls.old = NOW - 1;
    rememberCall(s, call(), NOW);
    expect(Object.keys(s.seenCalls)).toEqual(['c1']);
  });
});

describe('parseToolCall', () => {
  it('accepts a well-formed call and rejects the rest', () => {
    expect(parseToolCall(call())).not.toBeNull();
    expect(parseToolCall(call({tool: 'rm' as never}))).toBeNull();
    expect(parseToolCall(call({callId: '../x'}))).toBeNull();
    expect(parseToolCall({...call(), args: []})).toBeNull();
    expect(parseToolCall(null)).toBeNull();
  });
});
