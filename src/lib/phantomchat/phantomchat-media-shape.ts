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
  let waveform: string | undefined;
  if(typeof parsed.waveform === 'string') {
    waveform = parsed.waveform;
  } else if(Array.isArray(parsed.waveform) && parsed.waveform.length) {
    try {
      const bytes = Uint8Array.from(parsed.waveform);
      let bin = '';
      for(let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      waveform = btoa(bin);
    } catch{
      waveform = undefined;
    }
  }

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
    let waveform: Uint8Array | undefined;
    if(fm.waveform) {
      try {
        waveform = base64ToBytes(fm.waveform);
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
