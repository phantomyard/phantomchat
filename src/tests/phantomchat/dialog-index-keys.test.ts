/**
 * #332 — a state-restored group row must keep its sort anchor.
 *
 * `setDialogsFromState` drops every computed `index_N` so the folder pass can
 * re-derive them. `index_1`..`index_21` are genuinely computed folder keys, but
 * a group's `index_0` is not: it is the top-message sort anchor the peer mapper
 * writes once, and nothing re-derives it on restore. Dropping it left the row
 * with no anchor at all, so every consumer fell through to "now" and the row
 * sorted above everything — the visible half of the reload-then-unpin report.
 *
 * A chat's `index_0` IS its folder index (rebuilt by the filter pass), so chats
 * must keep losing it.
 */
import {describe, it, expect} from 'vitest';
import type {Dialog} from '@lib/appManagers/appMessagesManager';
import {GROUP_PEER_BASE, SESSION_PEER_BASE} from '@lib/phantomchat/group-types';
import clearComputedDialogIndexes from '@lib/storages/clearComputedDialogIndexes';

const GROUP_PEER = -Number(GROUP_PEER_BASE) - 7;
const SESSION_PEER = -Number(SESSION_PEER_BASE) - 7;
const CHAT_PEER = 123456789;

function dialogWithIndexes(peerId: number) {
  const dialog = {peerId} as unknown as Dialog;
  for(let i = 0; i <= 21; ++i) {
    (dialog as any)[`index_${i}`] = (i + 1) * 0x10000;
  }

  return dialog;
}

describe('clearComputedDialogIndexes', () => {
  it('keeps index_0 for a group — that key is the sort anchor, not a folder key', () => {
    const dialog = dialogWithIndexes(GROUP_PEER);
    clearComputedDialogIndexes(dialog);

    expect((dialog as any).index_0).toBe(0x10000);
  });

  it('keeps index_0 for a session too — sessions are group-class peers', () => {
    const dialog = dialogWithIndexes(SESSION_PEER);
    clearComputedDialogIndexes(dialog);

    expect((dialog as any).index_0).toBe(0x10000);
  });

  it('drops every folder key on a group, so a stale folder cannot claim the row', () => {
    const dialog = dialogWithIndexes(GROUP_PEER);
    clearComputedDialogIndexes(dialog);

    for(let i = 1; i <= 21; ++i) {
      expect((dialog as any)[`index_${i}`]).toBeUndefined();
    }
  });

  it('drops index_0 as well for a chat — a chat rebuilds it from topDate', () => {
    const dialog = dialogWithIndexes(CHAT_PEER);
    clearComputedDialogIndexes(dialog);

    for(let i = 0; i <= 21; ++i) {
      expect((dialog as any)[`index_${i}`]).toBeUndefined();
    }
  });

  it('is a no-op on a row that carries no indexes at all', () => {
    const dialog = {peerId: GROUP_PEER} as unknown as Dialog;

    expect(() => clearComputedDialogIndexes(dialog)).not.toThrow();
    expect(Object.keys(dialog)).toEqual(['peerId']);
  });
});
