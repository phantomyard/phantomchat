// @ts-nocheck
import type {Postcondition, Action, FuzzContext, FailureDetails} from '../types';
import {
  POST_sendText_bubble_appears,
  POST_sendText_input_cleared,
  POST_edit_preserves_mid,
  POST_edit_content_updated,
  POST_delete_local_bubble_gone,
  POST_react_emoji_appears,
  POST_react_peer_sees_emoji,
  POST_remove_reaction_peer_disappears,
  POST_react_multi_emoji_separate,
  POST_deleteWhileSending_consistent
} from './messaging';
import {
  POST_editName_cache_updated,
  POST_editName_relay_published,
  POST_uploadAvatar_propagated
} from './profile';
import {
  POST_createGroup_record_exists,
  POST_sendInGroup_bubble_on_sender,
  POST_sendInGroup_bubble_on_peer,
  POST_addMember_member_in_store,
  POST_removeMember_member_gone_admin,
  POST_removeMember_target_loses_group,
  POST_leaveGroup_record_gone_leaver
} from './groups';

export const POSTCONDITIONS: Record<string, Postcondition[]> = {
  sendText: [POST_sendText_bubble_appears, POST_sendText_input_cleared],
  replyToRandomBubble: [POST_sendText_bubble_appears],
  editRandomOwnBubble: [POST_edit_preserves_mid, POST_edit_content_updated],
  deleteRandomOwnBubble: [POST_delete_local_bubble_gone],
  reactToRandomBubble: [POST_react_emoji_appears, POST_react_peer_sees_emoji],
  removeReaction: [POST_remove_reaction_peer_disappears],
  reactMultipleEmoji: [POST_react_multi_emoji_separate],
  deleteWhileSending: [POST_deleteWhileSending_consistent],
  editName: [POST_editName_cache_updated, POST_editName_relay_published],
  uploadAvatar: [POST_uploadAvatar_propagated],
  createGroup: [POST_createGroup_record_exists],
  sendInGroup: [POST_sendInGroup_bubble_on_sender, POST_sendInGroup_bubble_on_peer],
  addMemberToGroup: [POST_addMember_member_in_store],
  removeMemberFromGroup: [POST_removeMember_member_gone_admin, POST_removeMember_target_loses_group],
  leaveGroup: [POST_leaveGroup_record_gone_leaver]
};

export async function runPostconditions(
  ctx: FuzzContext,
  action: Action
): Promise<FailureDetails | null> {
  const list = POSTCONDITIONS[action.name] || [];
  for(const p of list) {
    const r = await p.check(ctx, action);
    if(!r.ok) {
      return {
        invariantId: p.id,
        tier: 'postcondition',
        message: r.message || 'postcondition failed',
        evidence: r.evidence,
        action
      };
    }
  }
  return null;
}
