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
    attributes.push({
      _: 'documentAttributeAudio',
      pFlags: {voice: true},
      duration: fm.duration,
      waveform: fm.waveform
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
      file_name: `file-${mid}`,
      pFlags: {}
    }
  };
}
