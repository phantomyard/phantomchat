import type {Dialog} from '@appManagers/appMessagesManager';
import {isGroupPeer} from '@lib/phantomchat/group-types';

/**
 * Drops the computed `index_N` keys a persisted dialog row carries, so the
 * folder pass can re-derive them for the folder the row belongs to *now*.
 *
 * `index_0` is not a folder key for a group: it is the top-message sort anchor,
 * written only by the peer mapper (`phantomchat-peer-mapper.ts`, right after
 * `pFlags`). Nothing re-derives it on a state restore, so dropping it left the
 * row with no anchor at all and every reader fell through to "now" — which
 * sorts the row to the very top of the list (issue #332). A chat's `index_0`
 * really is its folder index and the filter pass rebuilds it, so chats keep the
 * old behaviour.
 *
 * `index_1`..`index_21` are always dropped, for both: a persisted folder key
 * can describe a folder the row has since left.
 */
export default function clearComputedDialogIndexes(dialog: Dialog) {
  const keepSortAnchor = isGroupPeer(dialog.peerId);
  for(let i = 0; i <= 21; ++i) {
    if(i === 0 && keepSortAnchor) continue;
    delete dialog[`index_${i}` as 'index_0'];
  }
}
