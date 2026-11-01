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

  it('forwards the staged image size to the bridge', () => {
    const body = methodBody(inputTs, 'sendPendingAttachments');
    expect(body).toContain('width: item.width');
    expect(body).toContain('height: item.height');
  });
});
