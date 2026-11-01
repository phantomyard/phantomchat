/**
 * Source-text pins on the two `settleDialogTopAfterSend` call sites (#311).
 *
 * `settle-dialog-top-after-send.test.ts` proves the helper moves the dialog off
 * a send's temp mid — but it calls the helper directly, so deleting a CALL SITE
 * left the whole suite green, and with it the regression from #310 came back
 * silently. These assertions pin the wiring instead of the behaviour: the text
 * send path settles after the real row is stored, and the P2P `sendFile` path
 * settles off the stored row rather than the mid-only stub.
 *
 * Comments are stripped first so a commented-out call cannot satisfy the pin.
 * The rendered symptom (a group preview blanking on typing stop) is covered by
 * `src/tests/e2e/e2e-group-preview-typing.ts`, wired into run-all.sh alongside.
 */
import '../setup';
import {describe, it, expect} from 'vitest';
import fs from 'node:fs';

// Strip block and line comments. `[^:]` keeps `https://` inside string literals
// from being treated as a comment start.
const stripComments = (source: string) => source
.replace(/\/\*[\s\S]*?\*\//g, '')
.replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('settleDialogTopAfterSend call sites', () => {
  const source = stripComments(fs.readFileSync('src/lib/appManagers/appMessagesManager.ts', 'utf-8'));

  it('the text send path settles the dialog after the real row is stored', () => {
    // Order is load-bearing: the helper compares `message.mid` against the
    // dialog's top mid, so it has to run once the real row exists.
    expect(source).toMatch(/this\.setMessageToStorage\(storage, message\);\s*this\.settleDialogTopAfterSend\(message, tempId\);/);
  });

  it('the P2P sendFile path settles off the stored row, not the stub', () => {
    // The VMT send path stores the full row under the real mid; `finalMessage`
    // carries only enough to remid the bubble. Reading the row back is what
    // keeps media/sender intact in the preview.
    expect(source).toContain('this.settleDialogTopAfterSend((storage.get(realMid) as MyMessage) || finalMessage, tempMid);');
  });

  it('the helper itself still exists with the same signature', () => {
    expect(source).toContain('private settleDialogTopAfterSend(message: MyMessage, tempId: number)');
  });
});
