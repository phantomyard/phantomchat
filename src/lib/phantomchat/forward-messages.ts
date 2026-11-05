import makeError from '@helpers/makeError';
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

/** A batch that failed after some messages already landed. The UI must not
 * offer a blind retry — re-sending everything would duplicate the messages
 * that did arrive — so it carries how many of the total went out.
 *
 * This rejection crosses the worker→main SuperMessagePort via postMessage,
 * whose structured clone strips an Error subclass and its own properties, so
 * it travels as a plain cloneable ApiError-shaped object branched on `type`
 * (same convention as the other port-crossing errors). No nested `original`:
 * a non-cloneable value would make postMessage throw and hang the invoke. */
export type ForwardPartialError = ApiError & {
  forwardSent: number,
  forwardTotal: number
};

export function isForwardPartialError(err: ApiError): err is ForwardPartialError {
  return err.type === 'FORWARD_PARTIAL';
}

function makePartialError(sent: number, total: number, original: unknown): ForwardPartialError {
  const error = makeError('FORWARD_PARTIAL', `Forward batch failed after ${sent} of ${total} messages`) as ForwardPartialError;
  error.forwardSent = sent;
  error.forwardTotal = total;
  if(original instanceof Error) {
    error.originalError = original.message;
  }
  return error;
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
  const ordered = mids.slice().sort((a, b) => a - b);
  let sent = 0;
  try {
    for(const mid of ordered) {
      const content = await deps.load(mid);
      if(content.blob) {
        await deps.sendFile(content, dropCaptions ? '' : content.text);
      } else {
        await deps.sendText(content.text);
      }
      sent++;
    }
  } catch(err) {
    if(sent > 0) throw makePartialError(sent, ordered.length, err);
    throw err;
  }
}
