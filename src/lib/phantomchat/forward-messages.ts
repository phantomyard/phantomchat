import type {StoredMessage} from './message-store';
import {healStoredFileRow} from './phantomchat-media-shape';
import type {fetchAndDecryptPhantomChatFile} from './phantomchat-file-fetch';

export interface ForwardContent {
  text: string;
  blob?: Blob;
  mediaType?: 'image' | 'video' | 'voice' | 'file';
  width?: number;
  height?: number;
  duration?: number;
  waveform?: string;
}

/** Main-thread source read: keep full mids and never forward another peer's row.
 * Files are decrypted locally and sent through the normal upload path with new
 * encryption, rather than sharing the original conversation's media keys. */
export async function prepareForwardContent(
  params: {fromPeerId: number; mid: number},
  getByMid: (mid: number) => Promise<StoredMessage | null | undefined>,
  fetchFile: typeof fetchAndDecryptPhantomChatFile
): Promise<ForwardContent> {
  const row = await getByMid(params.mid);
  if(!row || row.twebPeerId !== Number(params.fromPeerId) || row.serviceType) {
    throw new Error('Forward source is no longer available');
  }
  const healed = healStoredFileRow(row);
  const fm = row.fileMetadata ?? healed?.fileMetadata;
  const text = healed ? healed.caption : row.content;
  if(!fm) {
    if(row.type === 'file' || !text) throw new Error('Forward source has no sendable content');
    return {text};
  }
  const decrypted = await fetchFile(fm.url, fm.keyHex, fm.ivHex, {sha256: fm.sha256, mirrors: fm.servers});
  return {
    text,
    blob: new Blob([decrypted], {type: fm.mimeType}),
    mediaType: fm.mediaType ?? (fm.mimeType.startsWith('image/') ? 'image' : fm.mimeType.startsWith('video/') ? 'video' : fm.mimeType.includes('audio') && (fm.duration || fm.waveform) ? 'voice' : 'file'),
    width: fm.width,
    height: fm.height,
    duration: fm.duration,
    waveform: fm.waveform
  };
}

/** Worker orchestration. Each send depends on the preceding one to preserve
 * selection order and avoid retaining a batch of decrypted attachments. The
 * existing sends own optimistic rendering, persistence and pending settlement. */
export async function forwardPhantomChatMessages(
  mids: number[],
  dropCaptions: boolean,
  deps: {
    load: (mid: number) => Promise<ForwardContent>;
    sendText: (text: string) => Promise<unknown>;
    sendFile: (content: ForwardContent, caption: string) => Promise<unknown>;
  }
): Promise<void> {
  for(const mid of mids.slice().sort((a, b) => a - b)) {
    const content = await deps.load(mid);
    if(content.blob) {
      await deps.sendFile(content, dropCaptions ? '' : content.text);
    } else {
      await deps.sendText(content.text);
    }
  }
}
