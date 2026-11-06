import {beforeEach, describe, expect, it, vi} from 'vitest';

// Sessions share the group delete/leave dialog; only the wording differs.
const mocks = vi.hoisted(() => ({createPopup: vi.fn(), getByPeerId: vi.fn()}));
vi.mock('@components/popups', () => ({default: {
  MANAGERS: {appChatsManager: {hasRights: async() => false}},
  createPopup: (...args: any[]) => {
    mocks.createPopup(...args);
    return {show: () => {}};
  }
}}));
vi.mock('@components/popups/peer', () => ({default: class {}}));
vi.mock('@components/wrappers/peerTitle', () => ({default: async() => document.createElement('span')}));
vi.mock('@lib/rootScope', () => ({default: {managers: {appPeersManager: {isSavedDialog: async() => false}}}}));
vi.mock('@lib/phantomchat/group-store', () => ({getGroupStore: () => ({getByPeerId: mocks.getByPeerId})}));

import PopupDeleteDialog from '@components/popups/deleteDialog';
import {GROUP_PEER_BASE, SESSION_PEER_BASE} from '@lib/phantomchat/group-types';
import {leaveGroupLangKey} from '@lib/phantomchat/session-wording';

const SESSION = -(Number(SESSION_PEER_BASE) + 7);
const GROUP = -(Number(GROUP_PEER_BASE) + 7);

async function open(peerId: number, admin: boolean) {
  (window as any).__phantomchatOwnPubkey = admin ? 'admin' : 'member';
  new PopupDeleteDialog(peerId as any, 'group');
  await vi.waitFor(() => expect(mocks.createPopup).toHaveBeenCalledOnce());
  const opts = mocks.createPopup.mock.calls[0][2];
  return {title: opts.titleLangKey, description: opts.descriptionLangKey, button: opts.buttons[0].langKey};
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getByPeerId.mockResolvedValue({adminPubkey: 'admin'});
});

describe('delete dialog wording', () => {
  it('says session for a session admin', async() => {
    expect(await open(SESSION, true)).toEqual({
      title: 'PhantomChat.Session.DeleteMenu',
      description: 'PhantomChat.Session.DeleteAndExit',
      button: 'PhantomChat.Session.DeleteMenu'
    });
  });

  it('says session for a session member', async() => {
    const d = await open(SESSION, false);
    expect(d.title).toBe('PhantomChat.Session.LeaveMenu');
    expect(d.description).toBe('PhantomChat.Session.DeleteAndExitName');
  });

  it('keeps group wording for a group', async() => {
    expect(await open(GROUP, true)).toEqual({
      title: 'DeleteMegaMenu', description: 'AreYouSureDeleteAndExit', button: 'DeleteMegaMenu'
    });
    vi.clearAllMocks();
    const d = await open(GROUP, false);
    expect(d.title).toBe('LeaveMegaMenu');
    expect(d.description).toBe('AreYouSureDeleteAndExitName');
  });
});

describe('leave label (chat-list menu, topbar menu, editor)', () => {
  it('says Leave Session for a session and Leave Group for a group', () => {
    expect(leaveGroupLangKey(SESSION)).toBe('PhantomChat.Session.Leave');
    expect(leaveGroupLangKey(GROUP)).toBe('ChatList.Context.LeaveGroup');
  });
});
