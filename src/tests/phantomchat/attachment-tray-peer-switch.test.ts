/**
 * Composer attachment tray — a chat switch during the batch.
 *
 * `sendMessageInner` reads the current chat and the composer *after* the staged
 * batch resolves, so without a guard the typed text of chat A is published into
 * chat B (with `clearDraft`) whenever the user opens another chat while the
 * files are uploading. The batch itself keeps the peer it started on, so the
 * text has to follow the files: the text is dropped, never re-targeted.
 */

import {
  sendBatchThenText,
  sendPendingAttachments,
  type PendingAttachment
} from '@lib/phantomchat/composer-attachments';
import {describe, expect, it, vi} from 'vitest';

function item(id: string): PendingAttachment {
  const file = new File(['x'], `${id}.jpg`, {type: 'image/jpeg'});
  Object.defineProperty(file, 'size', {value: 1024, configurable: true});
  return {id, file, previewURL: `blob:${id}`, kind: 'media', mediaType: 'image'};
}

/** Mirrors the caller: one batch, then the typed text, both against a peer id
 *  that the user can change while the batch is in flight. */
function makeComposer(startPeerId: number) {
  const state = {peerId: startPeerId};
  const sentToPeer: number[] = [];
  const batch = async() => sendPendingAttachments(
    [item('a'), item('b')],
    async(pending) => {
      sentToPeer.push(state.peerId);
      await Promise.resolve();
      void pending;
    }
  );

  return {state, sentToPeer, batch};
}

describe('sendBatchThenText', () => {
  it('sends the batch and then the text when the chat does not change', async() => {
    const {state, sentToPeer, batch} = makeComposer(1);
    const sendText = vi.fn();
    const ok = await sendBatchThenText(
      1,
      async() => !(await batch()).failed,
      sendText,
      () => state.peerId
    );

    expect(ok).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sentToPeer).toEqual([1, 1]);
  });

  it('drops the text when the user switches chat mid-batch', async() => {
    const {state, sentToPeer, batch} = makeComposer(1);
    // The user opens chat 2 while the batch is uploading.
    const switchedBatch = async() => {
      const result = await batch();
      state.peerId = 2;
      return !result.failed;
    };
    const sendText = vi.fn();
    const ok = await sendBatchThenText(1, switchedBatch, sendText, () => state.peerId);

    expect(ok).toBe(false);
    // Nothing is published into chat 2: the text is dropped, not re-targeted.
    expect(sendText).not.toHaveBeenCalled();
    // The files that already published stayed with the batch's peer.
    expect(sentToPeer).toEqual([1, 1]);
  });

  it('drops the text when the tray vanished mid-batch (an empty batch reads as success)', async() => {
    const state = {peerId: 1};
    const sendText = vi.fn();
    // `sendPendingAttachments` returns an empty success when the tray was
    // removed by `cleanup()`, which is exactly the peer-switch path.
    const emptyBatch = async() => {
      state.peerId = 7;
      const result = await sendPendingAttachments([], async() => undefined);
      return !result.failed;
    };
    const ok = await sendBatchThenText(1, emptyBatch, sendText, () => state.peerId);

    expect(ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('drops the text when the batch reports a failure', async() => {
    const state = {peerId: 1};
    const sendText = vi.fn();
    // `ChatInput.sendPendingAttachments` already flattens a failed publish into
    // `false` (and toasts, keeping the file staged), so the helper only has to
    // honour it.
    const ok = await sendBatchThenText(1, async() => false, sendText, () => state.peerId);

    expect(ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('real failure path: a thrown publish reads as a failed batch at the caller', async() => {
    const result = await sendPendingAttachments([item('a')], async() => {
      throw new Error('upload failed');
    });

    expect(result.failed).toBeTruthy();
    expect(result.sent).toHaveLength(0);
    expect(result.remaining).toHaveLength(1);
  });
});
