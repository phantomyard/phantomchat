/**
 * Composer attachment tray — pure helpers.
 *
 * PhantomChat P2P/group chats send media through the `phantomchatSendFile`
 * bridge, where one call = one published rumor. There is no album primitive on
 * the wire (grouping is sender-local only, see issue #111), so the composer
 * stages a batch of files in a tray and dispatches them one at a time.
 *
 * Everything in this module is DOM-free and synchronous except
 * `sendPendingAttachments`, so the batching rules (cap, size limits, ordering,
 * stop-on-first-failure) are testable without mounting the chat input.
 */

import {isPhantomChatPeerId} from './bridge-invariants';
import {MAX_PHOTO_SIZE, MAX_VIDEO_SIZE} from './blossom-client';

/** How many files a single staged batch may hold. */
export const MAX_PENDING_ATTACHMENTS = 5;

/**
 * Size ceiling for non-media files. Matches the Blossom video ceiling — the
 * relay upload path has no separate document limit of its own.
 */
export const MAX_DOCUMENT_ATTACHMENT_SIZE = MAX_VIDEO_SIZE;

export type PendingAttachmentMediaType = 'image' | 'video' | 'file';
export type PendingAttachmentKind = 'media' | 'document';

export type PendingAttachment = {
  /** Stable id for DOM keying and tray bookkeeping. */
  id: string;
  file: File;
  /** Object URL for image/video tiles; undefined for documents. */
  previewURL?: string;
  kind: PendingAttachmentKind;
  mediaType: PendingAttachmentMediaType;
  /**
   * Intrinsic pixel size, filled in once a staged image has decoded. The tray
   * has no media-editor step, so the bubble would otherwise have no dimensions
   * until its own blob loads.
   */
  width?: number;
  height?: number;
};

/**
 * Ceiling for a composer caption that rides along with an attachment.
 *
 * The caption is the composer text, so it is bounded by the composer rather than
 * by the wire: above this the text falls back to its own message instead of
 * being truncated into a bubble that also has to hold the file.
 */
export const MAX_ATTACHMENT_CAPTION_LENGTH = 1024;

export type RejectedAttachmentReason = 'empty' | 'too-large' | 'batch-full' | 'duplicate';

export type RejectedAttachment = {
  file: File;
  reason: RejectedAttachmentReason;
  /** Human-readable, English-only message for the toast. */
  message: string;
};

/**
 * Whether this chat's composer shows the attachment tray. Decided per peer
 * (`ChatInput.updateAttachmentTray`), never at construct time: `Chat.init` runs
 * from `setPeer` before the peer id is assigned, so a construct-time check sees
 * `NULL_PEER_ID` and the tray would never be built.
 */
export function shouldUseAttachmentTray(
  peerId: number | string | bigint | undefined | null,
  isScheduledChat: boolean
): boolean {
  return !!peerId && !isScheduledChat && isPhantomChatPeerId(peerId);
}

export function getAttachmentMediaType(file: File): PendingAttachmentMediaType {
  const mime = (file.type || '').toLowerCase();
  if(mime.startsWith('image/')) {
    return 'image';
  }

  if(mime.startsWith('video/')) {
    return 'video';
  }

  return 'file';
}

export function getAttachmentKind(file: File): PendingAttachmentKind {
  return getAttachmentMediaType(file) === 'file' ? 'document' : 'media';
}

export function getAttachmentSizeLimit(file: File): number {
  const mediaType = getAttachmentMediaType(file);
  if(mediaType === 'image') {
    return MAX_PHOTO_SIZE;
  }

  return MAX_DOCUMENT_ATTACHMENT_SIZE; // video + document share the 50MB ceiling
}

function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/** Returns undefined when the file may be staged. */
export function validateAttachment(file: File): RejectedAttachment | undefined {
  if(!file.size) {
    return {file, reason: 'empty', message: `"${file.name}" is empty and cannot be sent.`};
  }

  const limit = getAttachmentSizeLimit(file);
  if(file.size > limit) {
    return {
      file,
      reason: 'too-large',
      message: `"${file.name}" is ${formatMegabytes(file.size)} — the limit is ${formatMegabytes(limit)}.`
    };
  }

  return undefined;
}

function attachmentKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

let attachmentIdCounter = 0;
function nextAttachmentId(): string {
  return `pending-${Date.now()}-${++attachmentIdCounter}`;
}

const supportsObjectURL = () => typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
const supportsRevokeObjectURL = () => typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function';

function defaultPreviewURL(file: File): string | undefined {
  if(!supportsObjectURL()) {
    return;
  }

  return getAttachmentMediaType(file) === 'file' ? undefined : URL.createObjectURL(file);
}

export type AddPendingAttachmentsResult = {
  /** The full staged list after the addition. */
  items: PendingAttachment[];
  /** Newly staged files. */
  added: PendingAttachment[];
  rejected: RejectedAttachment[];
};

/**
 * Stages files into a batch, enforcing the per-batch cap, the size ceilings and
 * duplicate suppression. Existing items are never mutated.
 */
export function addPendingAttachments(
  existing: PendingAttachment[],
  files: File[],
  createPreviewURL: (file: File) => string | undefined = defaultPreviewURL
): AddPendingAttachmentsResult {
  const items = existing.slice();
  const added: PendingAttachment[] = [];
  const rejected: RejectedAttachment[] = [];
  const known = new Set(items.map((item) => attachmentKey(item.file)));

  for(const file of files) {
    const key = attachmentKey(file);
    if(known.has(key)) {
      rejected.push({file, reason: 'duplicate', message: `"${file.name}" is already attached.`});
      continue;
    }

    if(items.length + added.length >= MAX_PENDING_ATTACHMENTS) {
      rejected.push({
        file,
        reason: 'batch-full',
        message: `You can attach up to ${MAX_PENDING_ATTACHMENTS} files at a time.`
      });
      continue;
    }

    const invalid = validateAttachment(file);
    if(invalid) {
      rejected.push(invalid);
      continue;
    }

    known.add(key);
    added.push({
      id: nextAttachmentId(),
      file,
      previewURL: createPreviewURL(file),
      kind: getAttachmentKind(file),
      mediaType: getAttachmentMediaType(file)
    });
  }

  return {items: items.concat(added), added, rejected};
}

/**
 * Records a staged image's intrinsic size. Ignores non-positive or non-finite
 * values so a broken decode cannot send `width: 0` to the bridge.
 */
export function setAttachmentDimensions(
  item: PendingAttachment,
  width: number,
  height: number
): void {
  if(!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return;
  }

  item.width = Math.round(width);
  item.height = Math.round(height);
}

export function removePendingAttachment(items: PendingAttachment[], id: string): PendingAttachment[] {
  const item = items.find((entry) => entry.id === id);
  if(item) {
    revokePendingAttachment(item);
  }

  return items.filter((entry) => entry.id !== id);
}

export function revokePendingAttachment(item: PendingAttachment): void {
  if(item.previewURL && supportsRevokeObjectURL()) {
    URL.revokeObjectURL(item.previewURL);
  }
}

export function revokePendingAttachments(items: PendingAttachment[]): void {
  items.forEach(revokePendingAttachment);
}

/**
 * Composer state that decides whether the typed text can travel as a caption.
 *
 * A caption is the *body* of the file message, so it is rejected whenever the
 * text carries a per-message flag the file path cannot express — a reply, a
 * story reply, a forwarded batch or a suggested post. Those fall back to the
 * files-then-text order, which is what keeps the linkage.
 */
export type AttachmentCaptionContext = {
  /** Raw composer text. */
  text: string;
  /** A reply (or story reply) is armed on the composer. */
  hasReply: boolean;
  /** A forwarded batch is staged. */
  isForwarding: boolean;
  /** A suggested post is being edited. */
  hasSuggestedPost: boolean;
};

/**
 * Returns the caption to attach to the first file of a batch, or `''` when the
 * text has to be published as its own message.
 *
 * Why this exists: the recipient of a PhantomChat media message gets the file
 * and nothing else, so a batch sent as `files… then text` reaches an agent as N
 * context-free media events followed by the instruction that explains them — it
 * answers the first one blind. Carrying the text as the caption of the file the
 * batch starts with puts the instruction on the same published message as the
 * first file, which is the only way it can be read in the same turn.
 */
export function getAttachmentCaption({
  text,
  hasReply,
  isForwarding,
  hasSuggestedPost
}: AttachmentCaptionContext): string {
  if(!text.trim()) {
    return '';
  }

  if(hasReply || isForwarding || hasSuggestedPost) {
    return '';
  }

  if(text.length > MAX_ATTACHMENT_CAPTION_LENGTH) {
    return '';
  }

  return text;
}

/**
 * Builds the per-item caption accessor for one batch.
 *
 * The caption is the body of a single message, so exactly one published file may
 * carry it: the first one that actually dispatches. Everything after it — and
 * any retry, where the composer is empty by then — gets nothing, because a
 * second copy of the text would read as the user having said it twice.
 */
export function createBatchCaptionPicker(caption: string): () => string {
  let pending = caption;

  return () => {
    const current = pending;
    pending = '';

    return current;
  };
}

export type SendPendingAttachmentsResult = {
  sent: PendingAttachment[];
  /** The item that failed, if any. It stays staged for a retry. */
  failed?: PendingAttachment;
  /** Everything that was not sent: the failed item plus everything after it. */
  remaining: PendingAttachment[];
};

export type SendPendingAttachmentsHooks = {
  onSending?: (item: PendingAttachment) => void;
  onSent?: (item: PendingAttachment) => void;
  onFailed?: (item: PendingAttachment, error: unknown) => void;
};

/**
 * Dispatches a staged batch in order, one file at a time.
 *
 * Sequential on purpose: every file is a separate publish, and firing them
 * concurrently would let the relay observe them out of order. The first failure
 * stops the batch — the failed item and the untouched remainder stay staged so
 * the user can retry instead of silently losing files mid-batch.
 */
export async function sendPendingAttachments(
  items: PendingAttachment[],
  send: (item: PendingAttachment) => Promise<void>,
  hooks: SendPendingAttachmentsHooks = {}
): Promise<SendPendingAttachmentsResult> {
  const sent: PendingAttachment[] = [];

  for(let index = 0; index < items.length; ++index) {
    const item = items[index];
    hooks.onSending?.(item);

    try {
      await send(item);
    } catch(error) {
      hooks.onFailed?.(item, error);
      return {sent, failed: item, remaining: items.slice(index)};
    }

    sent.push(item);
    hooks.onSent?.(item);
  }

  return {sent, remaining: []};
}

/**
 * Runs the staged batch, then the typed text.
 *
 * The text belongs to the peer the batch started on: `sendMessageInner` reads
 * the current chat and the composer after the batch resolves, so a chat switch
 * mid-upload would publish the newly opened chat's draft as if Send had been
 * pressed there. In that case the text is dropped and only the files land — a
 * deliberate trade, because a file that already published cannot be recalled.
 *
 * Returns false when the batch failed or the peer changed, so the caller leaves
 * the composer alone.
 */
export async function sendBatchThenText(
  peerIdBeforeBatch: number,
  sendBatch: () => Promise<boolean>,
  sendText: () => unknown,
  currentPeerId: () => number
): Promise<boolean> {
  if(!await sendBatch()) {
    return false;
  }

  if(currentPeerId() !== peerIdBeforeBatch) {
    return false;
  }

  await sendText();
  return true;
}
