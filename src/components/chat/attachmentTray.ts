/**
 * Composer attachment tray for PhantomChat chats.
 *
 * PhantomChat publishes every file as its own rumor, so the tweb `PopupNewMedia`
 * flow (preview → caption → send) is the wrong shape for a multi-file pick: it
 * turns each pick into a modal round-trip. The tray instead stages up to
 * `MAX_PENDING_ATTACHMENTS` files above the composer, shows a thumbnail per
 * file with a per-file remove button, and lets the normal Send button dispatch
 * the whole batch.
 *
 * DOM-only — all batching rules live in
 * `@lib/phantomchat/composer-attachments`.
 */

import {
  addPendingAttachments,
  MAX_PENDING_ATTACHMENTS,
  PendingAttachment,
  RejectedAttachment,
  removePendingAttachment,
  revokePendingAttachment,
  revokePendingAttachments,
  SendPendingAttachmentsHooks,
  SendPendingAttachmentsResult,
  sendPendingAttachments,
  setAttachmentDimensions
} from '@lib/phantomchat/composer-attachments';

type AttachmentTrayState = 'idle' | 'sending' | 'failed';

export default class AttachmentTray {
  public readonly element: HTMLDivElement;
  public onChange?: () => void;

  private items: PendingAttachment[] = [];
  private itemEls = new Map<string, HTMLDivElement>();
  private states = new Map<string, AttachmentTrayState>();
  private failedReasons = new Map<string, string>();

  constructor() {
    this.element = document.createElement('div');
    this.element.classList.add('attachment-tray');
    this.element.classList.add('hide');
  }

  public hasFiles(): boolean {
    return this.items.length > 0;
  }

  public get pending(): PendingAttachment[] {
    return this.items.slice();
  }

  /** Stages files; returns the ones that could not be staged. */
  public addFiles(files: File[]): RejectedAttachment[] {
    const {items, added, rejected} = addPendingAttachments(this.items, files);
    if(!added.length) {
      return rejected;
    }

    this.items = items;
    added.forEach((item) => this.appendItem(item));
    this.updateVisibility();
    this.notifyChange();

    return rejected;
  }

  public remove(id: string): void {
    if(this.states.get(id) === 'sending') {
      return;
    }

    this.items = removePendingAttachment(this.items, id);
    this.itemEls.get(id)?.remove();
    this.itemEls.delete(id);
    this.states.delete(id);
    this.failedReasons.delete(id);
    this.updateVisibility();
    this.notifyChange();
  }

  public clear(): void {
    revokePendingAttachments(this.items);
    this.items = [];
    this.itemEls.clear();
    this.states.clear();
    this.failedReasons.clear();
    this.element.replaceChildren();
    this.updateVisibility();
    this.notifyChange();
  }

  public markSending(id: string): void {
    this.setState(id, 'sending');
  }

  public markIdle(id: string): void {
    this.setState(id, 'idle');
  }

  public markFailed(id: string, reason?: string): void {
    if(reason) {
      this.failedReasons.set(id, reason);
    }

    this.setState(id, 'failed');
  }

  /**
   * Dispatches every staged file through `send`, in order. Sent files leave the
   * tray; the failed file and the untouched remainder stay, marked, so a retry
   * is one click away.
   */
  public async sendAll(send: (item: PendingAttachment) => Promise<void>): Promise<SendPendingAttachmentsResult> {
    const hooks: SendPendingAttachmentsHooks = {
      onSending: (item) => this.markSending(item.id),
      onSent: (item) => {
        // The sent bubble builds its own object URL from the blob during
        // injection, so the tray's preview URL is dead weight once the send
        // resolves — release it here instead of leaking it for the session.
        revokePendingAttachment(item);
        this.items = this.items.filter((entry) => entry.id !== item.id);
        this.itemEls.get(item.id)?.remove();
        this.itemEls.delete(item.id);
        this.states.delete(item.id);
        this.failedReasons.delete(item.id);
      },
      onFailed: (item, error) => {
        this.markFailed(item.id, error instanceof Error ? error.message : undefined);
      }
    };

    const result = await sendPendingAttachments(this.items, send, hooks);
    if(result.remaining.length) {
      // Re-mark the untouched remainder as idle-failed so the tray reads as
      // "these still need sending" rather than looking half-broken.
      result.remaining.forEach((item) => {
        if(this.states.get(item.id) !== 'failed') {
          this.markFailed(item.id, 'Not sent yet');
        }
      });
    }

    this.updateVisibility();
    this.notifyChange();

    return result;
  }

  private notifyChange(): void {
    this.onChange?.();
  }

  private updateVisibility(): void {
    this.element.classList.toggle('hide', !this.items.length);
  }

  private setState(id: string, state: AttachmentTrayState): void {
    this.states.set(id, state);
    const itemEl = this.itemEls.get(id);
    if(!itemEl) {
      return;
    }

    itemEl.classList.toggle('is-sending', state === 'sending');
    itemEl.classList.toggle('is-failed', state === 'failed');
    const statusEl = itemEl.querySelector('.attachment-tray-item-status') as HTMLElement | null;
    if(statusEl) {
      statusEl.textContent = state === 'sending' ? '' : state === 'failed' ? '!' : '';
      statusEl.title = state === 'failed' ? (this.failedReasons.get(id) || 'Not sent') : '';
      statusEl.classList.toggle('hide', state === 'idle');
    }

    const removeBtn = itemEl.querySelector('.attachment-tray-item-remove') as HTMLButtonElement | null;
    if(removeBtn) {
      removeBtn.disabled = state === 'sending';
    }
  }

  private appendItem(item: PendingAttachment): void {
    const itemEl = document.createElement('div');
    itemEl.classList.add('attachment-tray-item');
    itemEl.dataset.id = item.id;
    itemEl.title = item.file.name;

    const thumbEl = document.createElement('div');
    thumbEl.classList.add('attachment-tray-item-thumb');
    if(item.mediaType === 'image' && item.previewURL) {
      const img = document.createElement('img');
      img.src = item.previewURL;
      img.alt = item.file.name;
      img.draggable = false;
      // The thumbnail is the only decode of this file before it is sent, so
      // read the intrinsic size off it and hand it to the bridge.
      img.addEventListener('load', () => {
        setAttachmentDimensions(item, img.naturalWidth, img.naturalHeight);
      });
      thumbEl.append(img);
    } else if(item.mediaType === 'video' && item.previewURL) {
      const video = document.createElement('video');
      video.src = item.previewURL;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      thumbEl.append(video);
      const badgeEl = document.createElement('span');
      badgeEl.classList.add('attachment-tray-item-badge');
      badgeEl.textContent = 'video';
      thumbEl.append(badgeEl);
    } else {
      const extEl = document.createElement('span');
      extEl.classList.add('attachment-tray-item-ext');
      extEl.textContent = getExtensionLabel(item.file.name);
      thumbEl.append(extEl);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.classList.add('attachment-tray-item-remove');
    removeBtn.setAttribute('aria-label', `Remove ${item.file.name}`);
    removeBtn.textContent = '\u00D7';
    removeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.remove(item.id);
    });

    const statusEl = document.createElement('div');
    statusEl.classList.add('attachment-tray-item-status', 'hide');

    const nameEl = document.createElement('span');
    nameEl.classList.add('attachment-tray-item-name');
    nameEl.textContent = item.file.name;

    thumbEl.append(removeBtn, statusEl);
    itemEl.append(thumbEl, nameEl);
    this.itemEls.set(item.id, itemEl);
    this.element.append(itemEl);
  }
}

function getExtensionLabel(fileName: string): string {
  const match = /\.([^.]+)$/.exec(fileName);
  if(!match) {
    return 'FILE';
  }

  return match[1].slice(0, 4).toUpperCase();
}

export {MAX_PENDING_ATTACHMENTS};
