/** The contacts-sync nudge (sync-nudge.ts): wire shape and strict parsing. */
import {describe, it, expect} from 'vitest';
import {
  parseSyncNudge, isSyncNudgeRumor, syncNudgeTags, syncNudgeContent, SYNC_NUDGE_TAG, SYNC_NUDGE_DEVICE_ID
} from '@lib/phantomchat/sync-nudge';

const OWN = 'b'.repeat(64);

describe('sync nudge', () => {
  it('round-trips and is tagged as a control message older clients drop', () => {
    const tags = syncNudgeTags(OWN, 'contacts');
    expect(tags).toContainEqual(['control', 'true']);
    expect(tags).toContainEqual(['p', OWN]);
    expect(parseSyncNudge(tags, syncNudgeContent('contacts'))).toEqual({domain: 'contacts', deviceId: SYNC_NUDGE_DEVICE_ID});
    expect(isSyncNudgeRumor(tags)).toBe(true);
  });

  it('rejects a body that disagrees with the tag, an unknown domain, no device id, or junk', () => {
    const tags = syncNudgeTags(OWN, 'contacts');
    expect(parseSyncNudge(tags, JSON.stringify({type: SYNC_NUDGE_TAG, domain: 'groups', deviceId: 'x'}))).toBeNull();
    expect(parseSyncNudge([[SYNC_NUDGE_TAG, 'groups']], JSON.stringify({type: SYNC_NUDGE_TAG, domain: 'groups', deviceId: 'x'}))).toBeNull();
    expect(parseSyncNudge(tags, JSON.stringify({type: SYNC_NUDGE_TAG, domain: 'contacts'}))).toBeNull();
    expect(parseSyncNudge(tags, 'hello')).toBeNull();
    expect(parseSyncNudge([['p', OWN]], syncNudgeContent('contacts'))).toBeNull();
    expect(isSyncNudgeRumor([['p', OWN]])).toBe(false);
    // An invalid nudge is still never a chat message.
    expect(isSyncNudgeRumor(tags)).toBe(true);
  });
});
