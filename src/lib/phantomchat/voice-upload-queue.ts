/**
 * Voice Upload Queue — IndexedDB-persisted retry queue for failed voice uploads.
 *
 * When a voice-message upload to Blossom fails (e.g. device offline in a
 * tunnel), the encrypted ciphertext + send metadata are persisted to IndexedDB
 * instead of being discarded after the 30s in-memory TTL. On relay reconnect
 * the queue auto-flushes, re-uploading the ciphertext to Blossom and completing
 * the send pipeline (ChatAPI publish + local row save).
 *
 * Design mirrors the OfflineQueue pattern for text messages (per D029) but
 * operates at the file-upload layer rather than the relay-publish layer.
 */

import {Logger, logger} from '@lib/logger';
import {uploadToBlossomWithProgress} from './blossom-upload-progress';

// ─── Types ──────────────────────────────────────────────────────────────────

export type VoiceUploadFileType = 'image' | 'video' | 'file' | 'voice';

export interface QueuedVoiceUpload {
  /** Unique queue entry ID */
  id: string;
  /** Recipient peer ID (absolute value, used for bubble injection) */
  peerId: number;
  /** Recipient pubkey (for ChatAPI connect) */
  peerPubkey: string;
  /** Local optimistic mid shown in the UI bubble */
  tempMid: number;
  /** File type classification */
  type: VoiceUploadFileType;
  /** Optional caption */
  caption: string;
  /** Image/video dimensions */
  width?: number;
  height?: number;
  /** Voice duration in seconds */
  duration?: number;
  /** Voice waveform data */
  waveform?: string;
  /** Encrypted ciphertext Blob — the actual bytes to re-upload */
  ciphertext: Blob;
  /** Sender private key hex (for re-upload signing) */
  privkeyHex: string;
  /** Sender pubkey hex */
  ownPubkey: string;
  /** AES key hex (for ChatAPI sendFileMessage) */
  keyHex: string;
  /** AES IV hex */
  ivHex: string;
  /** SHA-256 of the ciphertext */
  sha256Hex: string;
  /** Original MIME type */
  mimeType: string;
  /** Original blob size in bytes */
  size: number;
  /** Unix timestamp when first queued */
  timestamp: number;
  /** Retry count for exponential backoff */
  retryCount: number;
  /** Set after successful Blossom upload — URL of the uploaded file */
  uploadedUrl?: string;
  /** Mirrors returned by Blossom upload */
  uploadedMirrors?: string[];
}

export interface VoiceUploadFlushResult {
  /** Number of entries successfully uploaded and sent */
  flushed: number;
  /** Number of entries still pending (network still down or max retries) */
  remaining: number;
}

/** Callback signature for dispatching UI events during flush */
export type DispatchFn = (name: string, payload: any) => void;

/** Minimal ChatAPI surface needed for flush completion */
export interface FlushChatAPI {
  getActivePeer(): string | null;
  connect(peerPubkey: string): Promise<void>;
  sendFileMessage(
    type: VoiceUploadFileType,
    url: string,
    sha256: string,
    key: string,
    iv: string,
    mimeType: string,
    size: number,
    dim?: {width: number; height: number},
    extras?: {
      duration?: number;
      waveform?: string;
      mid?: number;
      twebPeerId?: number;
      timestampSec?: number;
      caption?: string;
      servers?: string[];
    }
  ): Promise<string>;
}

/**
 * Minimal message-store surface for flush completion.
 *
 * SAVE CONTRACT: flush MUST write the exact same row shape the normal send
 * path lands via the VMT send bridge (see phantomchatSendFile's ctx.saveMessage
 * in virtual-mtproto-server.ts): full identity triple (mid + twebPeerId +
 * timestamp), deliveryState, isOutgoing, and media fields NESTED under
 * `fileMetadata` — never as flat top-level columns. getHistory builds media
 * exclusively from `stored.fileMetadata`; a flat row has no media and renders
 * as an empty (or raw-JSON) text bubble after reload — the #105 regression.
 */
export interface FlushMessageStore {
  getConversationId(ownPubkey: string, peerPubkey: string): string;
  saveMessage(params: {
    eventId: string;
    conversationId: string;
    senderPubkey: string;
    content: string;
    type: 'file';
    timestamp: number;
    deliveryState: 'sent';
    mid: number;
    twebPeerId: number;
    isOutgoing: boolean;
    fileMetadata: {
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
      mediaType?: VoiceUploadFileType;
      servers?: string[];
    };
  }): Promise<void>;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DB_NAME = 'phantomchat-voice-upload-queue';
const DB_VERSION = 1;
const STORE_NAME = 'voice-uploads';
const MAX_RETRY_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MULTIPLIER = 2;
const BACKOFF_MAX_MS = 60_000;

// ─── IndexedDB persistence ──────────────────────────────────────────────────

let _dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if(!_dbPromise) {
    _dbPromise = initDB();
  }
  return _dbPromise;
}

function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if(!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {keyPath: 'id'});
        store.createIndex('peerPubkey', 'peerPubkey', {unique: false});
        store.createIndex('timestamp', 'timestamp', {unique: false});
      }
    };
  });
}

async function saveToIndexedDB(entry: QueuedVoiceUpload): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(entry);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function deleteFromIndexedDB(id: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function loadFromIndexedDB(): Promise<QueuedVoiceUpload[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result ?? []);
  });
}

// ─── VoiceUploadQueue ───────────────────────────────────────────────────────

let _idCounter = 0;

export class VoiceUploadQueue {
  private log: Logger;
  private _queue: QueuedVoiceUpload[] = [];
  private _initialized = false;
  /** Resolves once IndexedDB restore completes. Awaite this before reading `size`. */
  readonly ready: Promise<void>;
  private _flushInFlight: Promise<VoiceUploadFlushResult> | null = null;

  constructor() {
    this.log = logger('VoiceUploadQueue');

    // Restore from IndexedDB on construction — exposed via `ready` so callers
    // can await initialization before checking `size`.
    this.ready = loadFromIndexedDB()
    .then(entries => {
      this._queue = entries;
      this._initialized = true;
      if(entries.length > 0) {
        this.log('[VoiceUploadQueue] restored', entries.length, 'pending upload(s) from IndexedDB');
      } else {
        this.log('[VoiceUploadQueue] initialized (no pending uploads)');
      }
    })
    .catch(err => {
      this._initialized = true;
      this.log.warn('[VoiceUploadQueue] failed to restore from IndexedDB:', err, '- continuing empty');
    });
  }

  /** Expose for test harness: inject an existing entry to simulate restore. */
  __injectForTest(entry: QueuedVoiceUpload): void {
    this._queue.push(entry);
  }

  /**
   * Persist a failed upload to the queue. Called by sendFileViaPhantomChat
   * when all upload attempts are exhausted.
   */
  async enqueue(entry: Omit<QueuedVoiceUpload, 'id' | 'timestamp' | 'retryCount'>): Promise<string> {
    // Wait for IndexedDB restore so the constructor's loadFromIndexedDB
    // doesn't overwrite this entry when its .then() assigns this._queue.
    await this.ready;

    const id = `vu-${Date.now()}-${_idCounter++}`;
    const full: QueuedVoiceUpload = {
      ...entry,
      id,
      timestamp: Date.now(),
      retryCount: 0
    };

    this._queue.push(full);

    // Persist to IndexedDB — awaited so the write is durable before returning.
    // If the write fails, remove from in-memory queue and re-throw.
    try {
      await saveToIndexedDB(full);
    } catch(err) {
      // Roll back in-memory push so queue stays consistent
      const idx = this._queue.findIndex(e => e.id === id);
      if(idx !== -1) this._queue.splice(idx, 1);
      this.log.warn('[VoiceUploadQueue] failed to persist to IndexedDB:', err);
      throw err;
    }

    this.log('[VoiceUploadQueue] enqueued voice upload:', id, 'for peer:', entry.peerPubkey.slice(0, 8) + '…');
    return id;
  }

  /**
   * Flush all pending uploads. Called on relay reconnect.
   *
   * For each entry: re-upload ciphertext to Blossom, then complete the
   * ChatAPI send + local row save. Entries are processed oldest-first.
   */
  async flush(
    chatAPI: FlushChatAPI,
    messageStore: FlushMessageStore,
    dispatch: DispatchFn
  ): Promise<VoiceUploadFlushResult> {
    // Coalesce overlapping flushes (reconnect flap storms)
    if(this._flushInFlight) return this._flushInFlight;
    const run = this.doFlush(chatAPI, messageStore, dispatch).finally(() => {
      if(this._flushInFlight === run) this._flushInFlight = null;
    });
    this._flushInFlight = run;
    return run;
  }

  private async doFlush(
    chatAPI: FlushChatAPI,
    messageStore: FlushMessageStore,
    dispatch: DispatchFn
  ): Promise<VoiceUploadFlushResult> {
    if(this._queue.length === 0) {
      return {flushed: 0, remaining: 0};
    }

    this.log('[VoiceUploadQueue] flushing', this._queue.length, 'pending upload(s)…');

    let flushed = 0;
    const toRemove: string[] = [];

    // Sort oldest-first for ordering preservation
    const sorted = [...this._queue].sort((a, b) => a.timestamp - b.timestamp);

    for(const entry of sorted) {
      // Skip if max retries exceeded
      if(entry.retryCount >= MAX_RETRY_ATTEMPTS) {
        this.log.warn('[VoiceUploadQueue] entry exceeded max retries:', entry.id);
        continue;
      }

      // Exponential backoff gate
      const backoffMs = Math.min(
        BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, entry.retryCount),
        BACKOFF_MAX_MS
      );
      if(Date.now() - entry.timestamp < backoffMs && entry.retryCount > 0) {
        this.log.debug('[VoiceUploadQueue] backoff active for', entry.id, '- skipping');
        continue;
      }

      try {
        // Step 1: Re-upload ciphertext to Blossom
        dispatch('phantomchat_file_upload_progress', {
          peerId: entry.peerId,
          mid: entry.tempMid,
          percent: 0
        });

        const result = await uploadToBlossomWithProgress(
          entry.ciphertext,
          entry.privkeyHex,
          {onProgress: (p: number) => dispatch('phantomchat_file_upload_progress', {
            peerId: entry.peerId,
            mid: entry.tempMid,
            percent: p
          })}
        );

        const url = result.url;
        const mirrors = result.mirrors?.length ? result.mirrors : [url];

        entry.uploadedUrl = url;
        entry.uploadedMirrors = mirrors;

        // Step 2: Connect to peer if needed
        if(chatAPI.getActivePeer() !== entry.peerPubkey) {
          await chatAPI.connect(entry.peerPubkey);
        }

        // Step 3: Generate canonical mid + timestamp
        const nowMs = Date.now();
        const timestampSec = Math.floor(nowMs / 1000);
        const counter = (_idCounter) % 1000;
        const slot = (nowMs % 1000) * 1000 + counter;
        const mid = timestampSec * 1_000_000 + slot;

        // Step 4: Publish via ChatAPI
        const effectiveMime = (entry.type === 'voice' && (!entry.mimeType || entry.mimeType === 'application/octet-stream')) ?
          'audio/ogg; codecs=opus' :
          (entry.mimeType || 'application/octet-stream');

        const eventId = await chatAPI.sendFileMessage(
          entry.type,
          url,
          entry.sha256Hex,
          entry.keyHex,
          entry.ivHex,
          effectiveMime,
          entry.size,
          entry.width && entry.height ? {width: entry.width, height: entry.height} : undefined,
          {
            duration: entry.duration,
            waveform: entry.waveform,
            mid,
            twebPeerId: Math.abs(entry.peerId),
            timestampSec,
            caption: entry.caption,
            servers: mirrors
          }
        );

        // Step 5: Save to local message store — the AUTHORITATIVE row, same
        // contract as the normal send bridge (see FlushMessageStore doc). This
        // merges over ChatAPI's durable-write-first row (keyed by the same
        // rumor id, content = raw file-envelope JSON, no fileMetadata): the
        // caption replaces the JSON text and the nested fileMetadata heals the
        // row so getHistory renders media instead of a raw-JSON bubble.
        // `timestamp` pins the same second the mid was derived from, keeping
        // the identity triple coherent; msSlot is intentionally NOT passed so
        // the pre-saved row's value survives the merge.
        const conversationId = messageStore.getConversationId(entry.ownPubkey, entry.peerPubkey);
        await messageStore.saveMessage({
          eventId,
          conversationId,
          senderPubkey: entry.ownPubkey,
          content: entry.caption || '',
          type: 'file',
          timestamp: timestampSec,
          deliveryState: 'sent',
          mid,
          twebPeerId: Math.abs(entry.peerId),
          isOutgoing: true,
          fileMetadata: {
            url,
            sha256: entry.sha256Hex,
            mimeType: effectiveMime,
            size: entry.size,
            width: entry.width,
            height: entry.height,
            keyHex: entry.keyHex,
            ivHex: entry.ivHex,
            duration: entry.duration,
            waveform: entry.waveform,
            mediaType: entry.type,
            ...(mirrors.length ? {servers: mirrors} : {})
          }
        });

        // Step 6: Dispatch completion event
        dispatch('phantomchat_file_upload_completed', {
          peerId: entry.peerId,
          mid: entry.tempMid,
          url,
          realMid: mid
        });

        toRemove.push(entry.id);
        flushed++;
        this.log('[VoiceUploadQueue] flushed upload:', entry.id);
      } catch(err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn('[VoiceUploadQueue] flush failed for', entry.id, ':', msg);
        entry.retryCount++;

        // Persist updated retry count
        saveToIndexedDB(entry).catch(() => {});
      }
    }

    // Remove flushed entries from queue + IndexedDB
    for(const id of toRemove) {
      const idx = this._queue.findIndex(e => e.id === id);
      if(idx !== -1) this._queue.splice(idx, 1);
      deleteFromIndexedDB(id).catch(err => {
        this.log.warn('[VoiceUploadQueue] failed to delete from IndexedDB:', err);
      });
    }

    const remaining = this._queue.length;
    this.log('[VoiceUploadQueue] flush complete:', flushed, 'flushed,', remaining, 'remaining');
    return {flushed, remaining};
  }

  /** Number of pending entries. */
  get size(): number {
    return this._queue.length;
  }

  /** Whether the queue has been initialized from IndexedDB. */
  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Wait for IndexedDB restore to complete. Returns immediately if already
   * initialized. Safe to call multiple times — the same promise is reused.
   */
  awaitReady(): Promise<void> {
    return this.ready;
  }

  /** Clear all pending entries (memory + IndexedDB). */
  async clear(): Promise<void> {
    const ids = this._queue.map(e => e.id);
    this._queue = [];
    for(const id of ids) {
      deleteFromIndexedDB(id).catch(() => {});
    }
    this.log('[VoiceUploadQueue] cleared', ids.length, 'entry/entries');
  }

  destroy(): void {
    this._queue = [];
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

let _instance: VoiceUploadQueue | null = null;

export function getVoiceUploadQueue(): VoiceUploadQueue {
  if(!_instance) {
    _instance = new VoiceUploadQueue();
  }
  return _instance;
}

/** Test-only: reset the singleton. */
export function __resetVoiceUploadQueueForTests(): void {
  if(_instance) {
    _instance.destroy();
    _instance = null;
  }
  // Also reset the module-level IDB promise so each test gets a fresh mock
  _dbPromise = null;
}
