/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import callbackify from '@helpers/callbackify';
import numberThousandSplitter from '@helpers/number/numberThousandSplitter';
import {Chat, ChatFull} from '@layer';
import getParticipantsCount from '@appManagers/utils/chats/getParticipantsCount';
import {i18n, LangPackKey} from '@lib/langPack';
import apiManagerProxy from '@lib/apiManagerProxy';
import rootScope from '@lib/rootScope';

function _getChatMembersString(chat: Chat, chatFull: ChatFull) {
  let count: number;
  if(chatFull) {
    count = getParticipantsCount(chatFull);
  } else {
    count = (chat as Chat.chat).participants_count || (chat as any).participants?.participants.length;
  }

  // [Nostra.chat] FIND-3786a35f obs (C) + FIND-e8327b23 §B: synthetic nostra
  // groups inject a Chat with `participants_count: members.length` but the
  // ChatFull they get is missing a `chatParticipants` array, so
  // `getParticipantsCount` short-circuits to `1`. The Chat-level count is
  // authoritative — prefer it when the chatFull-derived count looks like
  // the default `1` fallback while the Chat carries a higher number.
  const chatLevelCount = (chat as Chat.chat).participants_count;
  if(chatLevelCount && count === 1 && chatLevelCount > 1) {
    count = chatLevelCount;
  }

  const isBroadcast = (chat as Chat.channel).pFlags.broadcast;
  count = count || 1;

  const key: LangPackKey = isBroadcast ? 'Peer.Status.Subscribers' : 'Peer.Status.Member';
  return i18n(key, [numberThousandSplitter(count)]);
}

export default function getChatMembersString(
  chatId: ChatId,
  managers = rootScope.managers,
  chat?: Chat,
  onlySync?: boolean,
  chatFull?: ChatFull
) {
  chat ??= apiManagerProxy.getChat(chatId);
  // [Nostra.chat] FIND-e8327b23 §1: when a user leaves a group and then
  // navigates back to the now-defunct group peerId (e.g. via setInnerPeer
  // from a stale link), the mirror is already cleaned up and `chat` is
  // undefined. Without this guard the next `chat._ === 'chatForbidden'`
  // read throws on undefined and surfaces an unhandled rejection.
  if(!chat) {
    return i18n('YouWereKicked');
  }
  if(chat._ === 'chatForbidden') {
    return i18n('YouWereKicked');
  }

  if(onlySync) {
    return _getChatMembersString(chat, undefined);
  }

  const result = chatFull || managers.appProfileManager.getCachedFullChat(chatId);
  return callbackify(result, (chatFull) => _getChatMembersString(chat, chatFull));
}
