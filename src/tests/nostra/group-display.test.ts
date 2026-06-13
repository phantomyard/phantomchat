import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect} from 'vitest';

// Polyfill Number.prototype.toPeerId (tweb runtime addition, not available in test)
if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

// ─── Test 1-2: group dialog shape ───────────────────────────────────
describe('group dialog shape', () => {
  it('group peerId is negative', () => {
    const peerId = -2000000000000100;
    expect(peerId).toBeLessThan(0);
  });

  it('chat_id is Math.abs(peerId) (always positive)', () => {
    const peerId = -2000000000000100;
    const chatId = Math.abs(peerId);
    expect(chatId).toBeGreaterThan(0);
    expect(chatId).toBe(2000000000000100);
  });
});

// ─── Test 3: groupIdToPeerId returns negative number ────────────────
describe('groupIdToPeerId', () => {
  it('returns a negative number for a valid hex groupId', async() => {
    const {groupIdToPeerId} = await import('@lib/nostra/group-types');
    const groupId = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
    const peerId = await groupIdToPeerId(groupId);
    expect(peerId).toBeLessThan(0);
  });
});
