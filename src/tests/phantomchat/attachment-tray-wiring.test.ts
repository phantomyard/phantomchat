/**
 * Composer attachment tray — wiring guard.
 *
 * The first cut of the tray was built from `ChatInput.construct()`, which
 * `Chat.init()` runs from `setPeer` BEFORE `chat.peerId` is assigned, so the
 * peer guard always saw `NULL_PEER_ID` and the tray was never created. Every
 * unit test still passed: they pinned `shouldUseAttachmentTray()` in
 * isolation, which is exactly what hid a dead feature.
 *
 * These assertions pin the CALL SITES that make the tray reachable, not the
 * predicate: tray ownership is per peer (`finishPeerChange` builds it,
 * `cleanup`/`destroy` drop it), and there is exactly one construction site.
 * A source-level guard is the honest shape here — mounting `ChatInput`
 * needs the whole Chat/DOM stack, and the failure mode is a moved call, not
 * a wrong return value.
 */

import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

const SRC = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

/** Body of the first `name(`, brace-matched from its opening `{`. */
function methodBody(source: string, name: string): string {
  const start = source.indexOf(`${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const open = source.indexOf('{', start);
  let depth = 0;
  for(let index = open; index < source.length; ++index) {
    const char = source[index];
    if(char === '{') ++depth;
    else if(char === '}') {
      --depth;
      if(!depth) return source.slice(open, index + 1);
    }
  }

  throw new Error(`unbalanced braces after ${name}`);
}

const inputTs = read('components/chat/input.ts');

describe('attachment tray wiring', () => {
  it('builds the tray from finishPeerChange, where the peer id is assigned', () => {
    expect(methodBody(inputTs, 'finishPeerChange')).toContain('this.updateAttachmentTray(');
  });

  it('never builds a tray at construct time', () => {
    // `Chat.init()` runs `construct()` from `setPeer` before `chat.peerId` is
    // set, so anything peer-dependent there is dead code.
    expect(methodBody(inputTs, 'construct')).not.toContain('AttachmentTray');
    expect(inputTs.match(/new AttachmentTray\(\)/g)).toHaveLength(1);
  });

  it('drops the tray on peer change and on teardown', () => {
    expect(methodBody(inputTs, 'cleanup')).toContain('removeAttachmentTray(');
    expect(methodBody(inputTs, 'destroy')).toContain('removeAttachmentTray(');
  });

  it('routes picker, paste and drop through the tray with a popup fallback', () => {
    expect(methodBody(inputTs, 'addFilesToTray')).toContain('this.stageAttachments(files)');
    expect(methodBody(inputTs, 'sendPendingAttachments')).toContain('sendPhantomChatAttachment(');
  });

  it('sends the typed text through the peer-switch guard, after the batch', () => {
    // `sendMessageInner` re-reads the chat after the batch resolves, so an
    // inlined batch would publish chat A's text into chat B on a mid-batch
    // switch. The order matters: the batch is handed to `sendBatchThenText`
    // together with the peer id captured BEFORE it runs.
    const start = inputTs.indexOf('public async sendMessage(');
    expect(start).toBeGreaterThan(-1);
    const body = inputTs.slice(start, inputTs.indexOf('private async sendMessageInner(', start));
    expect(body).toContain('sendBatchThenText(');
    expect(body.indexOf('this.chat.peerId')).toBeLessThan(body.indexOf('this.sendPendingAttachments()'));
  });

  it('carries the typed text as the caption instead of a second message', () => {
    const start = inputTs.indexOf('public async sendMessage(');
    const body = inputTs.slice(start, inputTs.indexOf('private async sendMessageInner(', start));

    // The caption is read BEFORE the batch runs, on the same composer the text
    // would otherwise have been sent from, and it is handed to the batch.
    expect(body).toContain('this.getPendingAttachmentCaption()');
    expect(body.indexOf('getPendingAttachmentCaption()')).toBeLessThan(body.indexOf('this.sendPendingAttachments(caption)'));
    // Once the wording travels inside the first file's message, the composer is
    // consumed rather than publishing the same text again.
    expect(body).toContain('this.onMessageSent(true, true)');
    // The peer-switch guard still wraps the coalesced path.
    expect(body).toContain('peerIdBeforeBatch');
  });

  it('attaches the caption to one file, not to every publish in the batch', () => {
    const body = methodBody(inputTs, 'sendPendingAttachments');

    // The picker lives in the batch runner, which hands each publish its own
    // caption; the composer passes the text in once and never re-derives it.
    expect(body).toContain('tray.sendAll(');
    expect(body).toContain('caption: itemCaption || undefined');
  });

  it('consumes the composer after a failed batch that already published the caption', () => {
    const start = inputTs.indexOf('public async sendMessage(');
    const body = inputTs.slice(start, inputTs.indexOf('private async sendMessageInner(', start));

    // A later file failing must not leave the text in the composer: the retry
    // would caption the next file with it and the recipient would act twice.
    expect(body.indexOf('if(batch.failed)')).toBeGreaterThan(-1);
    expect(body.indexOf('if(batch.failed)')).toBeLessThan(body.indexOf('shouldConsumeComposerAfterFailedBatch('));
    expect(body).toContain('shouldConsumeComposerAfterFailedBatch(batch, peerIdBeforeBatch, this.chat.peerId)');
    // ...and the successful path only clears it when a file actually carried it.
    expect(body).toContain('if(batch.captionPublished)');
  });

  it('forwards the staged image size to the bridge', () => {
    const body = methodBody(inputTs, 'sendPendingAttachments');
    expect(body).toContain('width: item.width');
    expect(body).toContain('height: item.height');
  });
});
