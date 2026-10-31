/**
 * Dialog state carried across a class re-key (`relocateGroupDialog`).
 *
 * The class reconcile drops the old dialog row and re-materialises it under a
 * re-derived peer id, and the read markers / unread count / pin / mute live ONLY
 * on that row. `carriedDialogState` is the pure rule for what comes across, so
 * it can be pinned without booting the sync module.
 *
 * Two things it must not do:
 *  - invent read progress: `|| topMessage` on a genuine `0` (nothing read yet)
 *    lifts the marker to the top message while the badge still says N unread,
 *    so the row reports unread messages that `updateReadHistory` considers read;
 *  - drop a noIdsDialog guard: with unread 0 the markers must equal top_message.
 */
import '../setup';
import {describe, it, expect, vi} from 'vitest';
import {carriedDialogState} from '@lib/phantomchat/phantomchat-groups-sync';

vi.mock('@config/debug', async() => {
  const actual = await vi.importActual<typeof import('@config/debug')>('@config/debug');
  return {...actual, MOUNT_CLASS_TO: {apiManagerProxy: {mirrors: {}}}};
});
vi.mock('@lib/rootScope', () => ({
  default: {dispatchEvent: vi.fn(), dispatchEventSingle: vi.fn(), managers: {}}
}));

/** A row the user has never read: top message 9, nothing read, 9 unread. */
function unreadFromScratch() {
  return {
    top_message: 9,
    read_inbox_max_id: 0,
    read_outbox_max_id: 0,
    unread_count: 9
  };
}

describe('carriedDialogState', () => {
  it('keeps a genuine 0 read marker when there is unread history', () => {
    const carried = carriedDialogState(unreadFromScratch(), 9);

    // The bug: falling back to topMessage claims all 9 are read.
    expect(carried.readInboxMaxId).toBe(0);
    expect(carried.readOutboxMaxId).toBe(0);
    expect(carried.unreadCount).toBe(9);
  });

  it('keeps a partial read marker as-is', () => {
    const carried = carriedDialogState({...unreadFromScratch(), read_inbox_max_id: 4, unread_count: 5}, 9);
    expect(carried.readInboxMaxId).toBe(4);
    expect(carried.unreadCount).toBe(5);
  });

  it('raises the markers to top_message when nothing is unread (noIdsDialog guard)', () => {
    const carried = carriedDialogState({
      top_message: 9, read_inbox_max_id: 0, read_outbox_max_id: 0, unread_count: 0
    }, 9);
    expect(carried.readInboxMaxId).toBe(9);
    expect(carried.readOutboxMaxId).toBe(9);
  });

  it('defaults to top_message when there is no previous row at all', () => {
    const carried = carriedDialogState(null, 7);
    expect(carried).toMatchObject({
      unreadCount: 0,
      readInboxMaxId: 7,
      readOutboxMaxId: 7,
      pinned: false,
      muteUntil: 0
    });
  });

  it('treats a missing marker with unread history as nothing read, not as top_message', () => {
    const carried = carriedDialogState({top_message: 9, unread_count: 2}, 9);
    expect(carried.readInboxMaxId).toBe(0);
    expect(carried.readOutboxMaxId).toBe(0);
  });

  it('carries the pin, the mute and the unread mention/reaction counts', () => {
    const carried = carriedDialogState({
      ...unreadFromScratch(),
      pFlags: {pinned: 1},
      notify_settings: {mute_until: 1_800_000_000},
      unread_mentions_count: 2,
      unread_reactions_count: 3
    }, 9);

    expect(carried.pinned).toBe(true);
    expect(carried.muteUntil).toBe(1_800_000_000);
    expect(carried.unreadMentionsCount).toBe(2);
    expect(carried.unreadReactionsCount).toBe(3);
  });
});
