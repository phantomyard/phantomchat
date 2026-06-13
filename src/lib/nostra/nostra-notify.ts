/**
 * nostra-notify.ts
 *
 * Main-thread bridge from Nostra incoming P2P/group messages to
 * `uiNotificationsManager.notify()`. The Worker-side
 * `appMessagesManager.notifyAboutMessage` path is bypassed by VMT, so without
 * this helper desktop/system notifications never fire for P2P traffic.
 *
 * Gates (cheap → strict):
 *   1. Skip own messages (caller already filters; we re-guard).
 *   2. Skip if chat is open for this peer AND tab is focused.
 *   3. Skip if Notification API or permission unavailable (notify() also
 *      no-ops, but bailing early avoids title/body work).
 *
 * Title resolution: read the peer mirror (`apiManagerProxy.mirrors.peers`).
 * Falls back to a generic title when the peer hasn't been mirrored yet.
 */

import idleController from '@helpers/idleController';
import {MOUNT_CLASS_TO} from '@config/debug';
import {logSwallow} from '@lib/nostra/log-swallow';
import type {NostraFileMetadata} from '@lib/nostra/nostra-media-shape';

interface NotifyInput {
  peerId: number;
  mid: number;
  senderPubkey: string;
  message: {content: string; type?: string; fileMetadata?: NostraFileMetadata};
}

function isChatOpenAndFocused(peerId: number): boolean {
  try {
    const im = (MOUNT_CLASS_TO as any).appImManager;
    const current = im?.chat?.peerId;
    const open = current != null && +current === peerId;
    return open && !idleController.isIdle;
  } catch{
    return false;
  }
}

function resolvePeerTitle(peerId: number): string {
  try {
    const proxy = (MOUNT_CLASS_TO as any).apiManagerProxy;
    const peer = proxy?.mirrors?.peers?.[peerId];
    if(!peer) return 'New message';
    if(peer.title) return String(peer.title);
    const first = peer.first_name || '';
    const last = peer.last_name || '';
    const full = (first + ' ' + last).trim();
    return full || peer.username || 'New message';
  } catch{
    return 'New message';
  }
}

function buildBody(input: NotifyInput): string {
  const meta = input.message.fileMetadata;
  if(meta) {
    const mt = meta.mimeType || '';
    if(mt.startsWith('image/')) return '📷 Photo';
    if(mt.startsWith('video/')) return '🎬 Video';
    if(mt.startsWith('audio/')) return '🎤 Audio';
    return '📎 File';
  }
  const text = (input.message.content || '').trim();
  return text || 'New message';
}

/**
 * Fire a desktop/system notification for an incoming Nostra message.
 * No-op when the user is actively viewing the chat or when the platform
 * lacks the Notification API. Per-peer mute is not yet exposed in the
 * Nostra UI; the global Settings → Notifications → Desktop toggle is
 * honored inside `uiNotificationsManager.notify()`.
 */
export async function notifyIncoming(input: NotifyInput, ownPubkey: string): Promise<void> {
  try {
    if(input.senderPubkey === ownPubkey) return;
    if(isChatOpenAndFocused(input.peerId)) return;
    if(typeof Notification === 'undefined') return;
    if(Notification.permission !== 'granted') return;

    const {default: uiNotificationsManager} = await import('@lib/uiNotificationsManager');
    const {getCurrentAccount} = await import('@lib/accounts/getCurrentAccount');
    const accountNumber = getCurrentAccount();

    const title = resolvePeerTitle(input.peerId);
    const message = buildBody(input);

    const onclick = () => {
      try {
        const im = (MOUNT_CLASS_TO as any).appImManager;
        im?.setInnerPeer?.({peerId: input.peerId, lastMsgId: input.mid});
      } catch(e) { logSwallow('NostraNotify.onclick', e); }
    };

    const pushData = {
      custom: {msg_id: '' + input.mid, peerId: '' + input.peerId},
      description: '',
      loc_key: '',
      loc_args: [] as string[],
      mute: '',
      random_id: 0,
      title: '',
      accountNumber
    };

    await uiNotificationsManager.notify(
      {
        title,
        message,
        tag: 'nostra-' + input.peerId,
        silent: false,
        onclick
      } as any,
      pushData as any
    );
  } catch(e) {
    logSwallow('NostraNotify.notifyIncoming', e);
  }
}
