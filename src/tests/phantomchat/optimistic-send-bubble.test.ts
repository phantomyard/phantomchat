import {describe, it, expect} from 'vitest';
import {isPaintedTempSend, resolveSentTempBubble} from '@lib/phantomchat/optimistic-send-bubble';
import {GROUP_PEER_BASE} from '@lib/phantomchat/group-types';

const P2P_PEER = 1e15 + 42;
const GROUP_PEER = -(Number(GROUP_PEER_BASE) + 7);
const TG_PEER = 777000;

const temp = (over: Record<string, unknown> = {}) => ({
  _: 'message',
  peerId: P2P_PEER,
  pFlags: {is_outgoing: true as const},
  ...over
});

describe('isPaintedTempSend — the temp copy of a VMT-painted text send', () => {
  it('matches an in-flight text send to a P2P peer', () => {
    expect(isPaintedTempSend(temp())).toBe(true);
    expect(isPaintedTempSend(temp({media: {_: 'messageMediaEmpty'}}))).toBe(true);
  });

  it('matches an in-flight text send to a group peer', () => {
    expect(isPaintedTempSend(temp({peerId: GROUP_PEER}))).toBe(true);
  });

  it('leaves the painted real bubble alone (no is_outgoing flag)', () => {
    expect(isPaintedTempSend(temp({pFlags: {out: true}}))).toBe(false);
  });

  it('leaves media sends alone: their upload bubble is keyed by the temp mid', () => {
    expect(isPaintedTempSend(temp({media: {_: 'messageMediaDocument'}}))).toBe(false);
    expect(isPaintedTempSend(temp({media: {_: 'messageMediaPhoto'}}))).toBe(false);
  });

  it('leaves non-PhantomChat peers and service messages alone', () => {
    expect(isPaintedTempSend(temp({peerId: TG_PEER}))).toBe(false);
    expect(isPaintedTempSend(temp({_: 'messageService'}))).toBe(false);
    expect(isPaintedTempSend(undefined)).toBe(false);
  });
});

describe('resolveSentTempBubble — message_sent rename', () => {
  const tempBubble = {id: 'temp'};
  const realBubble = {id: 'real'};

  it('drops the temp bubble when the real mid already has its own bubble', () => {
    expect(resolveSentTempBubble(tempBubble, realBubble)).toBe('drop-temp');
  });

  it('renames when the real mid has no bubble yet (normal tweb path)', () => {
    expect(resolveSentTempBubble(tempBubble, undefined)).toBe('rename');
  });

  it('renames when temp and real resolve to the same bubble', () => {
    expect(resolveSentTempBubble(tempBubble, tempBubble)).toBe('rename');
  });

  it('does nothing when no temp bubble was drawn', () => {
    expect(resolveSentTempBubble(undefined, realBubble)).toBe('none');
  });
});
