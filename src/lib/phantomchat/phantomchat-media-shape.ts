/*
 * Shared helper: build a tweb MessageMedia object (messageMediaPhoto or
 * messageMediaDocument) from a PhantomChat fileMetadata row. Used by both
 * VirtualMTProtoServer.getHistory and phantomchat-message-handler so incoming
 * P2P media bubbles render identically whether they come from the store
 * on chat open or from a live phantomchat_new_message dispatch.
 *
 * The Blossom URL travels as-is on the media object; the phantomchatFileMetadata
 * sidecar carries key/iv so AppDownloadManager can fetch+decrypt on demand.
 */

import base64ToBytes from '@helpers/string/base64ToBytes';

/**
 * Normalise a voice-note waveform to the base64 string the wire and the
 * message store expect. The composer's recorder hands over a `Uint8Array`
 * (5-bit packed, Telegram style), and before this helper that value went onto
 * the wire as-is: `JSON.stringify` turns a `Uint8Array` into `{"0":n,"1":n}`,
 * and every receiver's `typeof waveform === 'string'` guard dropped it. The
 * sender's own stored row kept the raw bytes, which `base64ToBytes` cannot
 * read, so its bubble lost the bars as soon as the optimistic one was swapped
 * out. Accepts a string, a `Uint8Array`, a number array, or that
 * index-keyed object (already on relays), and returns undefined for anything
 * else or an empty value.
 */
export function waveformToBase64(raw: unknown): string | undefined {
  if(typeof raw === 'string') return raw || undefined;
  let bytes: Uint8Array | undefined;
  if(raw instanceof Uint8Array) {
    bytes = raw;
  } else if(Array.isArray(raw)) {
    bytes = Uint8Array.from(raw as number[]);
  } else if(raw && typeof raw === 'object') {
    const values = Object.keys(raw)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => +a - +b)
    .map((k) => (raw as Record<string, unknown>)[k]);
    if(values.length && values.every((v) => typeof v === 'number')) {
      bytes = Uint8Array.from(values as number[]);
    }
  }
  if(!bytes?.length) return undefined;
  let bin = '';
  for(let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] & 0xff);
  return btoa(bin);
}

export interface PhantomChatFileMetadata {
  url: string;
  sha256: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  keyHex: string;
  ivHex: string;
  duration?: number;
  waveform?: string;
  /** #11: caption typed with the file (rendered as the bubble text) */
  caption?: string;
  /**
   * Authoritative media class the sender tagged this file with
   * ('image' | 'video' | 'voice' | 'file'). Threaded on the wire so the
   * receiver never has to *re-guess* the type from mime + duration. The
   * heuristics below remain as a fallback for messages already on relays
   * that predate this field. Fixes the "Unknown file" render for voice
   * notes whose recorded blob mime came across as application/octet-stream.
   */
  mediaType?: 'image' | 'video' | 'voice' | 'file';
  /** Multi-mirror Blossom URLs (primary first). Receiver falls back across them. */
  servers?: string[];
}

export interface HealedFileRow {
  fileMetadata: PhantomChatFileMetadata;
  /** Caption recovered from the envelope — the text the bubble should show. */
  caption: string;
}

/**
 * Defensive heal for stored file rows that lost their nested `fileMetadata`.
 *
 * Two known write paths produced such rows:
 *  - ChatAPI.sendMessage's durable-write-first pre-save (content = the raw
 *    file-envelope JSON, no fileMetadata) when the app was killed / the queue
 *    flush was interrupted before the authoritative merge landed.
 *  - The voice-upload-queue flush before the save-contract fix, which wrote
 *    flat top-level media fields and (via merge) could leave the pre-saved
 *    JSON content in place.
 *
 * A third corrupt shape is the HYBRID row: `fileMetadata` is present (so the
 * bubble renders a player) but `content` still holds the raw transport
 * envelope — the state rows flushed by the old queue contract ended in once
 * the flush re-attached media to the live bubble. The envelope JSON is not
 * user text; the heal swaps it for the caption and keeps the row's own
 * (authoritative) fileMetadata.
 *
 * In all cases the row's `content` still holds the full file envelope that
 * ChatAPI.sendFileMessage built ({url, sha256, mimeType, size, key, iv,
 * mediaType, servers, duration, waveform, caption?}), so the media is fully
 * recoverable at render time. Callers persist the healed shape back to
 * IndexedDB (best-effort) so a corrupt row self-repairs instead of healing
 * on every read. Returns undefined when the row has nothing to heal (healthy
 * row, non-envelope JSON) or nothing recoverable (an empty-content row whose
 * media info is genuinely gone).
 */
export function healStoredFileRow(stored: {
  type?: string;
  content?: string;
  fileMetadata?: PhantomChatFileMetadata;
}): HealedFileRow | undefined {
  if(stored.type !== 'file' || !stored.content) return undefined;

  let parsed: any;
  try {
    parsed = JSON.parse(stored.content);
  } catch{
    return undefined;
  }
  // Envelope shape check: the fields sendFileMessage always writes.
  if(!parsed ||
    typeof parsed.url !== 'string' ||
    typeof parsed.sha256 !== 'string' ||
    typeof parsed.key !== 'string' ||
    typeof parsed.iv !== 'string') {
    return undefined;
  }

  const caption = typeof parsed.caption === 'string' ? parsed.caption : '';

  // Hybrid row: media intact, text corrupt. Heal the text only.
  if(stored.fileMetadata) {
    return {caption, fileMetadata: stored.fileMetadata};
  }

  // Waveform travels as a base64 string on healthy rows, but some send paths
  // serialized it as a raw byte array on the wire. Convert so the bubble's
  // amplitude bars survive the heal.
  const waveform = waveformToBase64(parsed.waveform);

  return {
    caption,
    fileMetadata: {
      url: parsed.url,
      sha256: parsed.sha256,
      mimeType: typeof parsed.mimeType === 'string' ? parsed.mimeType : 'application/octet-stream',
      size: typeof parsed.size === 'number' ? parsed.size : 0,
      width: typeof parsed.width === 'number' ? parsed.width : undefined,
      height: typeof parsed.height === 'number' ? parsed.height : undefined,
      keyHex: parsed.key,
      ivHex: parsed.iv,
      duration: typeof parsed.duration === 'number' ? parsed.duration : undefined,
      waveform,
      mediaType: parsed.mediaType,
      ...(Array.isArray(parsed.servers) && parsed.servers.length ? {servers: parsed.servers} : {})
    }
  };
}

export interface StoredRowMedia {
  media: any | undefined;
  /** The text a preview/bubble should show: healed caption on file rows, else the stored content. */
  text: string;
  /** Set when `healStoredFileRow` recovered fileMetadata from the envelope — callers that own the store may write the healed row back. */
  healed: HealedFileRow | undefined;
}

/** Anything the render path can hand around: a tweb message or a test double. */
export interface RenderableMessageLike {
  mid?: number;
  peerId?: any;
  media?: any;
}

/**
 * Whether `wrapDocument` can render this message at all.
 *
 * Not a truthiness test on `.media`: `wrapDocument` dereferences
 * `media.document` and `media.webpage.document` (components/wrappers/
 * document.ts), so a copy whose `media` survived as a hollow object — or as
 * `messageMediaEmpty` — still throws there and the bubble is dropped just as
 * hard as with `media` undefined. Every "is this row renderable" decision has
 * to use this one predicate.
 */
export function hasRenderableMedia(message: RenderableMessageLike | undefined): boolean {
  const media = message?.media;
  if(!media) return false;
  return !!(media.document || media.webpage?.document);
}

/**
 * Pick which copy of one message to render when history storage and the caller
 * disagree about its media.
 *
 * A media message can have two writers: the receive path that persists the row
 * and the projection handler that appends its own build of the same mid. If the
 * stored copy lost its `media` while the caller's copy still has it, rendering
 * the stored one throws inside wrapDocument and safeRenderMessage drops the
 * bubble for good — the message only comes back when the chat is reopened from
 * IndexedDB. Prefer the caller's object in that case; otherwise the stored copy
 * wins, because it is the copy every other reader of this mid sees.
 *
 * `fallback` may only ever stand in for the SAME message. Album rendering calls
 * this per mid with the message the bubble was handed, and for a sibling mid
 * that object is a DIFFERENT message: returning it would wrap the root's
 * document under the sibling's mid, so the slot shows the wrong file and the
 * real one stays missing — silently wrong instead of visibly missing. So when a
 * stored copy exists at all it is only swapped for a same-identity one
 * (`mid`, plus `peerId` when both carry it; an unknown `mid` never matches).
 * When storage has no copy the caller's object is the only one left and is used
 * as-is — callers must therefore only hand in a fallback for the mid they are
 * rendering.
 */
export function pickRenderableMessage<T extends RenderableMessageLike>(
  stored: T | undefined,
  fallback: T | undefined
): T | undefined {
  if(!stored) return fallback;
  if(hasRenderableMedia(stored)) return stored;
  if(!fallback || !hasRenderableMedia(fallback)) return stored;
  return isSameMessage(stored, fallback) ? fallback : stored;
}

function isSameMessage(a: RenderableMessageLike, b: RenderableMessageLike): boolean {
  if(a.mid === undefined || b.mid === undefined || a.mid !== b.mid) return false;
  if(a.peerId === undefined || b.peerId === undefined) return true;
  return a.peerId === b.peerId;
}

/**
 * Heal a stored copy whose `media` was lost, re-deriving it from the RAW stored
 * row — the contract this module already owns (`storedRowMedia`).
 *
 * Only for a copy that is already known to be unrenderable: the loader is
 * allowed to hit IndexedDB, so callers must not invoke this on the happy path.
 * Returns the copy untouched when the row is gone or itself has no media.
 */
export async function healLossyCopy<T extends RenderableMessageLike & {message?: string}>(
  copy: T,
  mid: number,
  loadStoredRow: (mid: number) => Promise<{
    type?: string;
    content?: string;
    fileMetadata?: PhantomChatFileMetadata;
  } | null | undefined>
): Promise<T> {
  if(hasRenderableMedia(copy)) return copy;
  let row: Awaited<ReturnType<typeof loadStoredRow>>;
  try {
    row = await loadStoredRow(mid);
  } catch{
    return copy;
  }
  if(!row) return copy;
  const {media, text} = storedRowMedia(row, mid);
  if(!media) return copy;
  return {...copy, media, ...(text ? {message: text} : {})} as T;
}

/**
 * Derive media + display text from a STORED message row — the single shared
 * contract every stored-row → tweb-message builder must use.
 *
 * Bug family this closes (2026-10-05 restart regression): several builders
 * (getDialogs top message, delivery-ui preview, cleared-dialog, search)
 * rebuilt tweb messages from stored rows WITHOUT media, and each write
 * landed in the same render cache the chat renders from — so a restart
 * flipped media bubbles to `is-message-empty` shells (stored rows keep
 * fileMetadata; the render cache got overwritten by media-less copies).
 * tweb never re-fetches a cached window, so the shells stuck forever.
 */
export function storedRowMedia(stored: {
  type?: string;
  content?: string;
  fileMetadata?: PhantomChatFileMetadata;
}, mid: number): StoredRowMedia {
  const healed = healStoredFileRow(stored);
  const fm = stored.fileMetadata ?? healed?.fileMetadata;
  const media = fm ? buildPhantomChatMedia(mid, fm) : undefined;
  const text = healed ? healed.caption : (stored.content ?? '');
  return {media, text, healed};
}

export function buildPhantomChatMedia(mid: number, fm: PhantomChatFileMetadata): any {
  const mime = fm.mimeType || '';
  // Prefer the explicit, sender-tagged media class. Fall back to the legacy
  // mime + duration/waveform heuristic for pre-`mediaType` messages.
  const hasVoiceSignal = (!!fm.duration || !!fm.waveform) && mime.includes('audio');
  const isVoice = fm.mediaType === 'voice' || (fm.mediaType === undefined && hasVoiceSignal);
  // Treat anything tagged `image/*` as a photo even when explicit width/height
  // are absent (e.g. when the sender's UI didn't extract dimensions, or the
  // rumor came from a path that drops them). Falling through to
  // `messageMediaDocument` rendered the bubble as a generic file attachment
  // — visually broken on both DM and group receive paths (FIND-e60cef56 γ).
  const isImage = !isVoice && (fm.mediaType === 'image' || mime.startsWith('image/'));

  if(isImage) {
    // Default to 320×320 when dimensions are missing — tweb's image bubble
    // sizes itself by the photoSize w/h, so a sensible square placeholder
    // is better than emitting `undefined` (which collapses to a tiny render).
    const w = fm.width || 320;
    const h = fm.height || 320;
    return {
      _: 'messageMediaPhoto',
      pFlags: {},
      photo: {
        _: 'photo',
        id: `phantomchat_${mid}`,
        sizes: [{
          _: 'photoSize',
          type: 'x',
          w,
          h,
          size: fm.size,
          url: fm.url
        }],
        url: fm.url,
        phantomchatFileMetadata: fm,
        pFlags: {}
      }
    };
  }

  const attributes: any[] = [];
  if(isVoice) {
    // The sender ships `waveform` as a base64 string (5-bit Telegram packing),
    // but tweb's AudioElement feeds it straight into `decodeWaveform`, which
    // expects packed *bytes* — a string decodes to all-zero (flat, no bars).
    // Decode here so the bubble draws the amplitude bars. Omit on failure so a
    // bad blob never throws the whole media-shape build (bubble still plays).
    // Stored rows written before waveformToBase64 existed can hold the raw
    // recorder bytes rather than a string — normalise first.
    let waveform: Uint8Array | undefined;
    const waveformB64 = waveformToBase64(fm.waveform);
    if(waveformB64) {
      try {
        waveform = base64ToBytes(waveformB64);
      } catch{
        waveform = undefined;
      }
    }
    attributes.push({
      _: 'documentAttributeAudio',
      pFlags: {voice: true},
      duration: fm.duration,
      waveform
    });
  }

  const docType = isVoice ? 'voice' :
    (fm.mediaType === 'video' || mime.startsWith('video/')) ? 'video' :
    mime.startsWith('audio/') ? 'audio' :
    undefined;

  return {
    _: 'messageMediaDocument',
    pFlags: {},
    document: {
      _: 'document',
      id: `phantomchat_${mid}`,
      mime_type: fm.mimeType,
      size: fm.size,
      url: fm.url,
      phantomchatFileMetadata: fm,
      attributes,
      type: docType,
      // Top-level duration mirrors appDocsManager.saveDoc — the P2P shape
      // bypasses saveDoc, so without it AudioElement's waveform renderer hits
      // clamp(undefined/60*maxW) → NaN width → empty bubble (FIND-voice-empty).
      ...(typeof fm.duration === 'number' ? {duration: fm.duration} : {}),
      file_name: `file-${mid}`,
      pFlags: {}
    }
  };
}
