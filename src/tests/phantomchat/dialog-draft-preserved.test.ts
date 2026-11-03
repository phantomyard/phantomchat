import 'fake-indexeddb/auto';
import {describe, expect, it, vi} from 'vitest';
import DialogsStorage from '@lib/storages/dialogs';

// Drafts lost on navigate-away: the VMT server never sends `draft` on dialogs,
// so a getDialogs / reloadConversation re-save used to wipe the local draft.
describe('saveDialog keeps the local draft when the dialog carries none', () => {
  const local = {_: 'draftMessage', message: 'my unsent prompt', date: 1} as any;

  function makeStorage() {
    const drafts: Record<string, any> = {'42': local};
    const appDraftsManager = {
      getDraft: vi.fn((peerId: PeerId) => drafts['' + peerId]),
      saveDraft: vi.fn(({peerId, draft}: any) => {
        if(draft?._ === 'draftMessage') drafts['' + peerId] = draft;
        else delete drafts['' + peerId];
        return drafts['' + peerId];
      })
    };
    const storage = Object.assign(Object.create(DialogsStorage.prototype), {appDraftsManager});
    return {storage, appDraftsManager, drafts};
  }

  it('absent draft (VMT dialog reload) keeps the stored draft', () => {
    const {storage, appDraftsManager, drafts} = makeStorage();
    expect(storage.reconcileDialogDraft({}, 42 as PeerId)).toBe(local);
    expect(appDraftsManager.saveDraft).not.toHaveBeenCalled();
    expect(drafts['42']).toBe(local);
  });

  it('explicit draftMessageEmpty still clears it', () => {
    const {storage, drafts} = makeStorage();
    expect(storage.reconcileDialogDraft({draft: {_: 'draftMessageEmpty'}}, 42 as PeerId)).toBeUndefined();
    expect(drafts['42']).toBeUndefined();
  });

  it('explicit draft overwrites it', () => {
    const {storage, drafts} = makeStorage();
    const next = {_: 'draftMessage', message: 'newer', date: 2} as any;
    expect(storage.reconcileDialogDraft({draft: next}, 42 as PeerId)).toBe(next);
    expect(drafts['42']).toBe(next);
  });
});
