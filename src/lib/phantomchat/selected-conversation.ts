import {MOUNT_CLASS_TO} from '@config/debug';

/** Selection, rather than scroll position or window focus, defines read state. */
export function isConversationSelected(peerId: number): boolean {
  return !!peerId && +(MOUNT_CLASS_TO as any).appImManager?.chat?.peerId === peerId;
}
