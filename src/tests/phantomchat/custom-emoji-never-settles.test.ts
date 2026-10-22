/**
 * #246 — custom-emoji lookups must always settle.
 *
 * PhantomChat stubs messages.getCustomEmojiDocuments to [] (no custom-emoji
 * server). The batcher used to resolve only the ids the server returned, so
 * every getCustomEmojiDocument() call stayed pending forever and the batch
 * re-ran in an endless pause(0) loop. In the field that showed up as worker
 * invoke TIMEOUTs and a blank window.
 */
import '../setup';
import {describe, it, expect, vi} from 'vitest';
import {AppEmojiManager} from '@lib/appManagers/appEmojiManager';

function makeManager(invokeApi: (...args: any[]) => Promise<any>) {
  const manager = Object.create(AppEmojiManager.prototype) as AppEmojiManager;
  Object.assign(manager as any, {
    getCustomEmojiDocumentPromises: new Map(),
    getCustomEmojiDocumentsPromise: undefined,
    apiManager: {invokeApi: vi.fn(invokeApi)},
    appDocsManager: {
      getDoc: vi.fn((): any => undefined),
      saveDoc: vi.fn((doc: any) => doc)
    }
  });
  return manager as any;
}

const within = <T>(p: Promise<T>, ms = 1000) => Promise.race([
  p,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('never settled')), ms))
]);

describe('appEmojiManager.getCustomEmojiDocument (#246)', () => {
  it('settles with undefined when the stub returns [] and stops re-batching', async() => {
    const m = makeManager(async() => []);
    const results = await within(Promise.all([
      m.getCustomEmojiDocument('1'),
      m.getCustomEmojiDocument('2')
    ]));
    expect(results).toEqual([undefined, undefined]);
    expect(m.getCustomEmojiDocumentPromises.size).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(m.apiManager.invokeApi).toHaveBeenCalledTimes(1);
  });

  it('matches docs by id when the server omits or reorders some', async() => {
    const m = makeManager(async() => [{_: 'document', id: '3'}, {_: 'document', id: '1'}]);
    const [a, b, c] = await within(Promise.all([
      m.getCustomEmojiDocument('1'),
      m.getCustomEmojiDocument('2'),
      m.getCustomEmojiDocument('3')
    ]));
    expect(a?.id).toBe('1');
    expect(b).toBeUndefined();
    expect(c?.id).toBe('3');
    expect(m.getCustomEmojiDocumentPromises.size).toBe(0);
  });

  it('settles every id when the request fails', async() => {
    const m = makeManager(async() => {
      throw {type: 'TIMEOUT'};
    });
    const results = await within(Promise.all([m.getCustomEmojiDocument('9')]));
    expect(results).toEqual([undefined]);
    expect(m.getCustomEmojiDocumentPromises.size).toBe(0);
  });

  it('settles every id when saving a returned doc throws', async() => {
    const m = makeManager(async() => [{_: 'document', id: '5'}]);
    m.appDocsManager.saveDoc = vi.fn(() => {
      throw new Error('boom');
    });
    const results = await within(Promise.all([m.getCustomEmojiDocument('5')]));
    expect(results).toEqual([undefined]);
    expect(m.getCustomEmojiDocumentPromises.size).toBe(0);
  });
});
