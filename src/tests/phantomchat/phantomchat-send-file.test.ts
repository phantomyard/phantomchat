import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

vi.mock('@lib/phantomchat/blossom-upload-progress', () => ({
  BLOSSOM_SERVERS: ['https://mock'],
  uploadToBlossomWithProgress: vi.fn()
}));

import {uploadToBlossomWithProgress} from '@lib/phantomchat/blossom-upload-progress';
import {
  sendFileViaPhantomChat,
  getPendingFileSend,
  getPendingFileSendCount,
  clearPendingFileSends,
  __setRetryBackoffForTests,
  __resetRetryBackoffForTests
} from '@lib/phantomchat/phantomchat-send-file';

const mockedUpload = uploadToBlossomWithProgress as unknown as ReturnType<typeof vi.fn>;

function makeCtx(overrides: any = {}) {
  const dispatched: any[] = [];
  return {
    dispatched,
    ctx: {
      ownPubkey: '11'.repeat(32),
      privkeyHex: '22'.repeat(32),
      peerPubkey: '33'.repeat(32),
      chatAPI: {
        getActivePeer: () => '33'.repeat(32),
        connect: vi.fn(async() => {}),
        sendFileMessage: vi.fn(async() => 'chat-1-1')
      },
      dispatch: (name: string, payload: any) => dispatched.push({name, payload}),
      injectBubble: vi.fn(async() => {}),
      saveMessage: vi.fn(async() => {}),
      log: Object.assign((..._: any[]) => {}, {warn: () => {}, error: () => {}}),
      ...overrides
    }
  };
}

describe('phantomchat-send-file', () => {
  beforeEach(() => {
    mockedUpload.mockReset();
    clearPendingFileSends();
    __setRetryBackoffForTests([0, 0, 0]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetRetryBackoffForTests();
  });

  it('encrypts, uploads, dispatches progress + completed, calls sendFileMessage', async() => {
    mockedUpload.mockImplementation(async(_blob: any, _key: any, opts: any) => {
      opts?.onProgress?.(50);
      opts?.onProgress?.(100);
      return {url: 'https://mock/x', sha256: 'abc', mirrors: ['https://mock/x', 'https://mock2/y']};
    });

    const {ctx, dispatched} = makeCtx();
    const blob = new Blob([new Uint8Array([1, 2, 3])], {type: 'image/jpeg'});
    const result = await sendFileViaPhantomChat(ctx, {
      peerId: 1_000_000_000_000_001,
      blob,
      type: 'image',
      caption: '',
      tempMid: -1,
      width: 100,
      height: 80
    });

    expect(result.ok).toBe(true);
    expect(ctx.chatAPI.sendFileMessage).toHaveBeenCalledTimes(1);
    const progressEvents = dispatched.filter(d => d.name === 'phantomchat_file_upload_progress');
    expect(progressEvents.map(e => e.payload.percent)).toEqual([50, 100]);
    expect(dispatched.some(d => d.name === 'phantomchat_file_upload_completed')).toBe(true);
  });

  it('carries the caption to sendFileMessage and saves it as the row content (#11)', async() => {
    mockedUpload.mockImplementation(async() => ({
      url: 'https://mock/x',
      sha256: 'abc',
      mirrors: ['https://mock/x', 'https://mock2/y']
    }));
    const {ctx} = makeCtx();

    await sendFileViaPhantomChat(ctx, {
      peerId: 1_000_000_000_000_009,
      blob: new Blob([new Uint8Array([1])], {type: 'image/png'}),
      type: 'image',
      caption: 'sunset 🌅',
      tempMid: -9,
      width: 10,
      height: 10
    });

    // caption reaches the relay publish via the sendFileMessage extras (→ fileContent)
    const extras = (ctx.chatAPI.sendFileMessage as any).mock.calls[0][8];
    expect(extras).toMatchObject({
      caption: 'sunset 🌅',
      servers: ['https://mock/x', 'https://mock2/y']
    });
    // caption persisted as the local row content so the sender's own bubble shows it
    expect((ctx.saveMessage as any).mock.calls[0][0]).toMatchObject({
      content: 'sunset 🌅',
      servers: ['https://mock/x', 'https://mock2/y']
    });
  });

  it('tags voice notes with mediaType + an audio mime even when blob.type is empty', async() => {
    mockedUpload.mockImplementation(async() => ({url: 'https://mock/v', sha256: 'abc'}));
    const {ctx} = makeCtx();

    await sendFileViaPhantomChat(ctx, {
      peerId: 1_000_000_000_000_009,
      // opus-recorder can hand us a blob with no type → octet-stream.
      blob: new Blob([new Uint8Array([1, 2, 3])]),
      type: 'voice',
      caption: '',
      tempMid: -10,
      duration: 4,
      waveform: 'aabb'
    });

    // Sender passes the authoritative type + a non-octet audio mime on the wire.
    const call = (ctx.chatAPI.sendFileMessage as any).mock.calls[0];
    expect(call[0]).toBe('voice');                 // type arg
    expect(call[5]).toContain('audio');            // mimeType arg, no longer octet-stream
    // …and persists both on the sender's own row so reload/echo renders voice.
    const saved = (ctx.saveMessage as any).mock.calls[0][0];
    expect(saved.mediaType).toBe('voice');
    expect(saved.mimeType).toContain('audio');
  });

  it('retries 3 times on upload failure, then hard fails', async() => {
    mockedUpload.mockRejectedValue(new Error('network'));
    const {ctx, dispatched} = makeCtx();

    const result = await sendFileViaPhantomChat(ctx, {
      peerId: 1_000_000_000_000_002,
      blob: new Blob([new Uint8Array([1])]),
      type: 'file',
      caption: '',
      tempMid: -2
    });

    expect(result.ok).toBe(false);
    expect(mockedUpload).toHaveBeenCalledTimes(4);
    expect(dispatched.some(d => d.name === 'phantomchat_file_upload_failed')).toBe(true);
    expect(getPendingFileSend(-2)).toBeDefined();
  });

  it('retry map LRU-evicts at cap 20 when uploads keep failing', async() => {
    // On success pending entries are removed immediately, so LRU only kicks
    // in when entries are left behind after hard failure.
    mockedUpload.mockRejectedValue(new Error('network'));
    for(let i = 0; i < 25; i++) {
      const {ctx} = makeCtx();
      await sendFileViaPhantomChat(ctx, {
        peerId: 1_000_000_000_000_100 + i,
        blob: new Blob([new Uint8Array([i])]),
        type: 'file',
        caption: '',
        tempMid: -1000 - i
      });
    }
    expect(getPendingFileSendCount()).toBeLessThanOrEqual(20);
    // Oldest entries should have been evicted
    expect(getPendingFileSend(-1000)).toBeUndefined();
    expect(getPendingFileSend(-1024)).toBeDefined();
  });

  it('issue #111: parallel album sends produce unique mids even when timestampSec is identical', async() => {
    // Pin Date.now so all three calls would have shared timestampSec under
    // the pre-fix arithmetic (mid = timestampSec).
    const PINNED_MS = 1_715_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(PINNED_MS);

    mockedUpload.mockImplementation(async() => ({url: 'https://mock/x', sha256: 'abc'}));

    const ctxs = [makeCtx(), makeCtx(), makeCtx()];
    const results = await Promise.all(ctxs.map((c, i) => sendFileViaPhantomChat(c.ctx, {
      peerId: 1_000_000_000_000_000 + i,
      blob: new Blob([new Uint8Array([i])], {type: 'image/jpeg'}),
      type: 'image',
      caption: '',
      tempMid: -(1000 + i)
    })));

    expect(results.every(r => r.ok)).toBe(true);
    const mids = results.map(r => r.mid);
    expect(new Set(mids).size).toBe(mids.length);
    // All mids share the same second prefix per mapEventIdToMid scheme
    const sharedSec = Math.floor(PINNED_MS / 1000);
    expect(mids.every(m => Math.floor(m / 1_000_000) === sharedSec)).toBe(true);
  });

  it('aborts upload when signal fires', async() => {
    const abort = new AbortController();
    mockedUpload.mockImplementation((_blob: any, _key: any, opts: any) => {
      return new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(new Error('upload aborted')));
      });
    });
    const {ctx} = makeCtx();

    const p = sendFileViaPhantomChat(ctx, {
      peerId: 1_000_000_000_000_003,
      blob: new Blob([new Uint8Array([1])]),
      type: 'file',
      caption: '',
      tempMid: -3,
      signal: abort.signal
    });
    abort.abort();
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/aborted/);
  });
});
