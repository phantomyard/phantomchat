/**
 * Sessions share the group UI (menus, editor, dialogs); only the wording
 * differs. One place picks the "Leave" label so every surface agrees.
 */
import type {LangPackKey} from '@lib/langPack';
import {isSessionPeer} from '@lib/phantomchat/group-types';

export function leaveGroupLangKey(peerId: number): LangPackKey {
  return isSessionPeer(peerId) ? 'PhantomChat.Session.Leave' : 'ChatList.Context.LeaveGroup';
}
