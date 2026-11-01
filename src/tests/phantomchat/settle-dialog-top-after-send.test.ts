import 'fake-indexeddb/auto';
import {describe, expect, it, vi} from 'vitest';
import {AppMessagesManager} from '@lib/appManagers/appMessagesManager';

const TEMP_MID = 1000;
const REAL_MID = 5000;

function setup(top: number | null) {
  const manager = Object.create(AppMessagesManager.prototype) as any;
  const dialog = top === null ? undefined : {peerId: -7, top_message: top};
  manager.getDialogOnly = vi.fn(() => dialog);
  manager.setDialogTopMessage = vi.fn();
  return {manager, dialog};
}

const message = {peerId: -7, mid: REAL_MID} as any;

describe('settleDialogTopAfterSend', () => {
  it('moves the dialog off the deleted temp mid', () => {
    const {manager, dialog} = setup(TEMP_MID);
    manager.settleDialogTopAfterSend(message, TEMP_MID);
    expect(manager.setDialogTopMessage).toHaveBeenCalledWith(message, dialog);
  });

  it('moves up when the real message is newer than the current top', () => {
    const {manager, dialog} = setup(REAL_MID - 1);
    manager.settleDialogTopAfterSend(message, TEMP_MID);
    expect(manager.setDialogTopMessage).toHaveBeenCalledWith(message, dialog);
  });

  it('leaves a newer message that arrived during the send on top', () => {
    const {manager} = setup(REAL_MID + 1);
    manager.settleDialogTopAfterSend(message, TEMP_MID);
    expect(manager.setDialogTopMessage).not.toHaveBeenCalled();
  });

  it('does nothing without a dialog', () => {
    const {manager} = setup(null);
    manager.settleDialogTopAfterSend(message, TEMP_MID);
    expect(manager.setDialogTopMessage).not.toHaveBeenCalled();
  });
});
