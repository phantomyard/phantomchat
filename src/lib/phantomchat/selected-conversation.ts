import {MOUNT_CLASS_TO} from '@config/debug';

/** A selected peer must have its chat pane visible; window focus is independent. */
export function isConversationSelected(peerId: number): boolean {
  const im = (MOUNT_CLASS_TO as any).appImManager;
  return !!peerId && +im?.chat?.peerId === peerId && im.isChatVisible !== false;
}
