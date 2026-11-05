import {describe, expect, it, vi} from 'vitest';
import {forwardPhantomChatMessages, isForwardPartialError, prepareForwardContent} from '@lib/phantomchat/forward-messages';
import type {ForwardPartialError} from '@lib/phantomchat/forward-messages';
import type {StoredMessage} from '@lib/phantomchat/message-store';

const MID = 1762350000123456;
const PEER = 1000000000000001;
const row = (patch: Partial<StoredMessage> = {}): StoredMessage => ({
  eventId: 'a'.repeat(64), conversationId: 'source', senderPubkey: 'b'.repeat(64),
  content: 'hello', type: 'text', timestamp: 1762350000, deliveryState: 'sent',
  mid: MID, twebPeerId: PEER, ...patch
});
const fm = {
  url: 'https://blossom.test/file', sha256: 'c'.repeat(64), mimeType: 'audio/ogg',
  size: 4, keyHex: 'd'.repeat(64), ivHex: 'e'.repeat(24), duration: 3,
  waveform: 'AQID', mediaType: 'voice' as const, servers: ['https://mirror.test/file']
};

describe('forward source', () => {
  it('looks up the full mid and copies text without fetching a file', async() => {
    const get = vi.fn().mockResolvedValue(row());
    const fetch = vi.fn();
    expect(await prepareForwardContent({fromPeerId: PEER, mid: MID}, get, fetch)).toEqual({text: 'hello'});
    expect(get).toHaveBeenCalledWith(MID);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, row({twebPeerId: PEER + 1}), row({serviceType: 'chatCreate'}), row({type: 'file'}), row({content: ''})])('rejects unavailable or unsendable source %j', async(source) => {
    const fetch = vi.fn();
    await expect(prepareForwardContent({fromPeerId: PEER, mid: MID}, vi.fn().mockResolvedValue(source), fetch)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([PEER, -5000000000000001])('prepares DM/group attachments with MIME, class, caption and waveform (%s)', async(peer) => {
    const fetch = vi.fn().mockResolvedValue(new Blob(['file']));
    const content = await prepareForwardContent({fromPeerId: peer, mid: MID}, vi.fn().mockResolvedValue(row({twebPeerId: peer, type: 'file', fileMetadata: fm})), fetch);
    expect(fetch).toHaveBeenCalledWith(fm.url, fm.keyHex, fm.ivHex, {sha256: fm.sha256, mirrors: fm.servers});
    expect(content.text).toBe('hello');
    expect(content.blob?.size).toBe(4);
    expect(content.blob?.type).toBe('audio/ogg');
    expect(content.mediaType).toBe('voice');
    expect(content.duration).toBe(3);
    expect(content.waveform).toBe('AQID');
    expect(content).not.toHaveProperty('keyHex');
  });

  it('heals a legacy envelope rather than forwarding its transport JSON', async() => {
    const envelope = {...fm, key: fm.keyHex, iv: fm.ivHex, caption: 'caption'};
    const content = await prepareForwardContent({fromPeerId: PEER, mid: MID}, vi.fn().mockResolvedValue(row({type: 'file', content: JSON.stringify(envelope)})), vi.fn().mockResolvedValue(new Blob(['file'])));
    expect(content.text).toBe('caption');
    expect(content.mediaType).toBe('voice');
    expect(content.blob?.size).toBe(4);
  });

  it('propagates a download/decryption failure', async() => {
    await expect(prepareForwardContent({fromPeerId: PEER, mid: MID}, vi.fn().mockResolvedValue(row({type: 'file', fileMetadata: fm})), vi.fn().mockRejectedValue(new Error('decrypt failed')))).rejects.toThrow('decrypt failed');
  });
});

describe('forward sends', () => {
  it('sends a mixed selection in order through the existing text/file paths', async() => {
    const events: string[] = [];
    const mids = [MID + 1, MID];
    const blob = new Blob(['file']);
    await forwardPhantomChatMessages(mids, false, {
      load: async(mid) => {
        events.push('load:' + mid);
        return mid === MID ? {text: 'text'} : {text: 'caption', blob, mediaType: 'file'};
      },
      sendText: async(text) => { events.push(text); },
      sendFile: async(content, caption) => {
        expect(content.blob).toBe(blob);
        events.push(caption);
      }
    });
    expect(events).toEqual(['load:' + MID, 'text', 'load:' + (MID + 1), 'caption']);
    expect(mids).toEqual([MID + 1, MID]);
  });

  it('drops only media captions, retaining ordinary text', async() => {
    const sendFile = vi.fn();
    const sendText = vi.fn();
    await forwardPhantomChatMessages([MID, MID + 1], true, {
      load: async(mid) => mid === MID ? {text: 'keep'} : {text: 'drop', blob: new Blob(['file'])},
      sendFile, sendText
    });
    expect(sendText).toHaveBeenCalledWith('keep');
    expect(sendFile).toHaveBeenCalledWith(expect.anything(), '');
  });

  it('rejects a refused send and stops before later messages', async() => {
    const load = vi.fn().mockResolvedValue({text: 'hello'});
    await expect(forwardPhantomChatMessages([MID, MID + 1], false, {
      load, sendText: vi.fn().mockRejectedValue(new Error('send refused')), sendFile: vi.fn()
    })).rejects.toThrow('send refused');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reports a partial batch with how many of the total landed', async() => {
    const load = vi.fn().mockResolvedValue({text: 'hello'});
    const sendText = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('send refused'));
    const err = await forwardPhantomChatMessages([MID, MID + 1, MID + 2], false, {
      load, sendText, sendFile: vi.fn()
    }).catch((e) => e) as ForwardPartialError;
    expect(isForwardPartialError(err)).toBe(true);
    expect(err.forwardSent).toBe(1);
    expect(err.forwardTotal).toBe(3);
    expect(err.originalError).toBe('send refused');
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it('keeps the partial-batch fields across the worker→main structured clone', async() => {
    const load = vi.fn().mockResolvedValue({text: 'hello'});
    const sendText = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('send refused'));
    // The rejection reaches the UI through SuperMessagePort postMessage,
    // whose structured clone strips an Error subclass and its own props —
    // assert the exact fields the input.ts branch reads, post-clone.
    const cloned = structuredClone(await forwardPhantomChatMessages([MID, MID + 1, MID + 2], false, {
      load, sendText, sendFile: vi.fn()
    }).catch((e) => e)) as ForwardPartialError;
    expect(cloned.type).toBe('FORWARD_PARTIAL');
    expect(cloned.forwardSent).toBe(1);
    expect(cloned.forwardTotal).toBe(3);
  });

  it('clones cleanly when the underlying failure is not a plain Error', async() => {
    const load = vi.fn().mockResolvedValue({text: 'hello'});
    const sendText = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce({uncloneable: () => 'fn'});
    const cloned = structuredClone(await forwardPhantomChatMessages([MID, MID + 1], false, {
      load, sendText, sendFile: vi.fn()
    }).catch((e) => e)) as ForwardPartialError;
    expect(cloned.type).toBe('FORWARD_PARTIAL');
    expect(cloned.forwardSent).toBe(1);
    expect(cloned).not.toHaveProperty('originalError');
  });

  it('does not wrap a failure that landed nothing', async() => {
    const load = vi.fn().mockResolvedValue({text: 'hello'});
    const err = await forwardPhantomChatMessages([MID, MID + 1], false, {
      load, sendText: vi.fn().mockRejectedValue(new Error('send refused')), sendFile: vi.fn()
    }).catch((e) => e);
    expect(isForwardPartialError(err as ApiError)).toBe(false);
    expect((err as Error).message).toBe('send refused');
    expect(load).toHaveBeenCalledTimes(1);
  });
});
