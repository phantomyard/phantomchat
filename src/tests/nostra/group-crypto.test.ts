import '../setup';
import {describe, it, expect} from 'vitest';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {wrapGroupMessage, unwrapGiftWrap} from '@lib/nostra/nostr-crypto';
import type {SignedEvent} from '@lib/nostra/nostr-crypto';
import {
  isControlEvent,
  wrapGroupControl,
  unwrapGroupControl,
  broadcastGroupControl,
  getGroupIdFromRumor
} from '@lib/nostra/group-control-messages';
import type {GroupControlPayload} from '@lib/nostra/group-types';

// ─── Helpers ────────────────────────────────────────────────────────

function makeKeypair() {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  return {sk, pk};
}

const GROUP_ID = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

// ─── wrapGroupMessage ───────────────────────────────────────────────

describe('wrapGroupMessage', () => {
  it('with 3 member pubkeys returns exactly 4 events (3 members + 1 self)', () => {
    const sender = makeKeypair();
    const members = [makeKeypair().pk, makeKeypair().pk, makeKeypair().pk];

    const {wraps} = wrapGroupMessage(sender.sk, members, 'hello group', GROUP_ID);
    expect(wraps.length).toBe(4);
  });

  it('with 12 member pubkeys returns exactly 13 events', () => {
    const sender = makeKeypair();
    const members = Array.from({length: 12}, () => makeKeypair().pk);

    const {wraps} = wrapGroupMessage(sender.sk, members, 'hello', GROUP_ID);
    expect(wraps.length).toBe(13);
  });

  it('each wrapped event can be unwrapped by its intended recipient with group tag', () => {
    const sender = makeKeypair();
    const m1 = makeKeypair();
    const m2 = makeKeypair();
    const members = [m1.pk, m2.pk];

    const {wraps} = wrapGroupMessage(sender.sk, members, 'secret msg', GROUP_ID);

    // Member 1 unwraps their event (index 0)
    const {rumor: rumor1} = unwrapGiftWrap(wraps[0] as unknown as SignedEvent, m1.sk);
    expect(rumor1.content).toBe('secret msg');
    const groupTag1 = rumor1.tags.find(t => t[0] === 'group');
    expect(groupTag1).toBeDefined();
    expect(groupTag1![1]).toBe(GROUP_ID);

    // Member 2 unwraps their event (index 1)
    const {rumor: rumor2} = unwrapGiftWrap(wraps[1] as unknown as SignedEvent, m2.sk);
    expect(rumor2.content).toBe('secret msg');
  });

  it('rumor p-tags include all member pubkeys', () => {
    const sender = makeKeypair();
    const m1 = makeKeypair();
    const m2 = makeKeypair();
    const members = [m1.pk, m2.pk];

    const {wraps} = wrapGroupMessage(sender.sk, members, 'msg', GROUP_ID);

    // Unwrap first member's event to inspect rumor
    const {rumor} = unwrapGiftWrap(wraps[0] as unknown as SignedEvent, m1.sk);
    const pTags = rumor.tags.filter(t => t[0] === 'p').map(t => t[1]);
    expect(pTags).toContain(m1.pk);
    expect(pTags).toContain(m2.pk);
  });

  it('includes content in the rumor (not just tags)', () => {
    const sender = makeKeypair();
    const m1 = makeKeypair();

    const {wraps} = wrapGroupMessage(sender.sk, [m1.pk], 'actual content here', GROUP_ID);
    const {rumor} = unwrapGiftWrap(wraps[0] as unknown as SignedEvent, m1.sk);
    expect(rumor.content).toBe('actual content here');
    expect(rumor.content.length).toBeGreaterThan(0);
  });
});

// ─── Control messages ───────────────────────────────────────────────

describe('wrapGroupControl / unwrapGroupControl', () => {
  const payload: GroupControlPayload = {
    type: 'group_create',
    groupId: GROUP_ID,
    groupName: 'Test Group',
    memberPubkeys: ['aaa', 'bbb']
  };

  it('wrapGroupControl sends a control payload with control and group tags', () => {
    const sender = makeKeypair();
    const recipient = makeKeypair();

    const wraps = wrapGroupControl(sender.sk, recipient.pk, payload);
    expect(wraps.length).toBe(1);

    // Unwrap and verify tags
    const {rumor} = unwrapGiftWrap(wraps[0] as unknown as SignedEvent, recipient.sk);
    expect(isControlEvent(rumor)).toBe(true);
    expect(getGroupIdFromRumor(rumor)).toBe(GROUP_ID);
  });

  it('unwrapGroupControl extracts the GroupControlPayload', () => {
    const sender = makeKeypair();
    const recipient = makeKeypair();

    const wraps = wrapGroupControl(sender.sk, recipient.pk, payload);
    const result = unwrapGroupControl(recipient.sk, wraps[0]);
    expect(result).not.toBeNull();
    expect(result!.payload.type).toBe('group_create');
    expect(result!.payload.groupId).toBe(GROUP_ID);
    expect(result!.payload.groupName).toBe('Test Group');
    expect(result!.payload.memberPubkeys).toEqual(['aaa', 'bbb']);
    expect(result!.senderPubkey).toBe(sender.pk);
  });
});

// ─── isControlEvent ─────────────────────────────────────────────────

describe('isControlEvent', () => {
  it('returns true for rumors with [control, true] tag', () => {
    expect(isControlEvent({tags: [['control', 'true'], ['group', 'abc']]})).toBe(true);
  });

  it('returns false for rumors without control tag', () => {
    expect(isControlEvent({tags: [['p', 'abc'], ['group', 'def']]})).toBe(false);
  });

  it('returns false for empty tags', () => {
    expect(isControlEvent({tags: []})).toBe(false);
  });

  it('returns false for undefined tags', () => {
    expect(isControlEvent({})).toBe(false);
  });
});

// ─── broadcastGroupControl ──────────────────────────────────────────

describe('broadcastGroupControl', () => {
  it('broadcasts to all members + self', () => {
    const sender = makeKeypair();
    const members = [makeKeypair().pk, makeKeypair().pk, makeKeypair().pk];
    const payload: GroupControlPayload = {
      type: 'group_add_member',
      groupId: GROUP_ID,
      targetPubkey: 'newmember'
    };

    const wraps = broadcastGroupControl(sender.sk, members, payload);
    // 3 members + 1 self = 4
    expect(wraps.length).toBe(4);
  });
});
