/*
 * Shared helper: build a tweb MessageMedia object (messageMediaPhoto or
 * messageMediaDocument) from a Nostra fileMetadata row. Used by both
 * VirtualMTProtoServer.getHistory and nostra-message-handler so incoming
 * P2P media bubbles render identically whether they come from the store
 * on chat open or from a live nostra_new_message dispatch.
 *
 * The Blossom URL travels as-is on the media object; the nostraFileMetadata
 * sidecar carries key/iv so AppDownloadManager can fetch+decrypt on demand.
 */

export interface NostraFileMetadata {
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
}

export function buildNostraMedia(mid: number, fm: NostraFileMetadata): any {
  const isVoice = !!fm.duration && (fm.mimeType || '').includes('audio');
  // Treat anything tagged `image/*` as a photo even when explicit width/height
  // are absent (e.g. when the sender's UI didn't extract dimensions, or the
  // rumor came from a path that drops them). Falling through to
  // `messageMediaDocument` rendered the bubble as a generic file attachment
  // — visually broken on both DM and group receive paths (FIND-e60cef56 γ).
  const isImage = (fm.mimeType || '').startsWith('image/');

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
        id: `nostra_${mid}`,
        sizes: [{
          _: 'photoSize',
          type: 'x',
          w,
          h,
          size: fm.size,
          url: fm.url
        }],
        url: fm.url,
        nostraFileMetadata: fm,
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
    (fm.mimeType || '').startsWith('video/') ? 'video' :
    (fm.mimeType || '').startsWith('audio/') ? 'audio' :
    undefined;

  return {
    _: 'messageMediaDocument',
    pFlags: {},
    document: {
      _: 'document',
      id: `nostra_${mid}`,
      mime_type: fm.mimeType,
      size: fm.size,
      url: fm.url,
      nostraFileMetadata: fm,
      attributes,
      type: docType,
      file_name: `file-${mid}`,
      pFlags: {}
    }
  };
}
