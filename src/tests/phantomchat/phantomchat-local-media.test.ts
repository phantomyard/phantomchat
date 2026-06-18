/*
 * Local media store: persists own outgoing blobs for instant playback,
 * decoupled from the Blossom upload. Uses fake-indexeddb for real IDB behavior.
 */
import 'fake-indexeddb/auto';
import {describe, it, expect} from 'vitest';
import {
  putLocalMedia,
  getLocalMedia,
  deleteLocalMedia,
  clearLocalMedia
} from '@lib/phantomchat/phantomchat-local-media';

describe('phantomchat-local-media', () => {
  it('round-trips a blob by id (keyed by ciphertext sha256)', async() => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], {type: 'audio/ogg'});
    await putLocalMedia('sha-abc', blob);
    const got = await getLocalMedia('sha-abc');
    expect(got).not.toBeNull();
    expect(got!.size).toBe(4);
    expect([...new Uint8Array(await got!.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  it('returns null for a missing id (renderer falls back to Blossom)', async() => {
    expect(await getLocalMedia('missing-' + Date.now())).toBeNull();
  });

  it('deletes an entry', async() => {
    await putLocalMedia('sha-del', new Blob([new Uint8Array([9])]));
    await deleteLocalMedia('sha-del');
    expect(await getLocalMedia('sha-del')).toBeNull();
  });

  it('clear wipes the store (logout)', async() => {
    await putLocalMedia('sha-clear', new Blob([new Uint8Array([7])]));
    await clearLocalMedia();
    expect(await getLocalMedia('sha-clear')).toBeNull();
  });
});
