/**
 * Regression pin for #217 / PR #218 review round 1 (kaieriksen): the
 * cold-start ready gate must sit on the REAL PhantomChat.chat identity flow.
 *
 * The bug: `whenChatListReady` was awaited only in index.ts's fallback
 * Telegram-signed-in branches, while the identity flow in
 * phantomchat-onboarding-integration.ts dismissed the boot splash right
 * after `pageIm.mount()` — before ChatAPI / read-state sync / preview
 * wiring — so the splash still lifted with stale/empty chat-list state.
 *
 * CI runs unit tests only (no Playwright), so these source-contract tests
 * pin the wiring: the bare early dismissal is gone, the identity flow's
 * dismissal goes through the ready gate (scheduled, not awaited — init
 * keeps flowing while the splash holds), and both readiness signals are
 * marked inside this same file, so the gate and its producers cannot drift
 * apart again.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';

const SRC = join(__dirname, '../..');
const flowSrc = readFileSync(join(SRC, 'pages/phantomchat-onboarding-integration.ts'), 'utf8');
const gateSrc = readFileSync(join(SRC, 'lib/phantomchat/phantomchat-ready-gate.ts'), 'utf8');

describe('cold-start ready gate — PhantomChat identity flow (#217/#218)', () => {
  it('dismisses the boot splash ONLY through the ready gate', () => {
    // Exactly one dismissal in the identity flow, and it lives inside the
    // gate's then-callback — no bare early hide.
    const hides = flowSrc.match(/__hideBootSplash/g);
    expect(hides).toHaveLength(1);
    const gate = flowSrc.match(/void\s+whenChatListReady\(\)\s*\.\s*then\(([\s\S]*?)\}\s*\)\s*;/);
    expect(gate).toBeTruthy();
    expect(gate![1]).toContain('__hideBootSplash');
    // The dismissal is scheduled (void, not awaited) so the init below it
    // keeps flowing while the splash holds.
    expect(flowSrc).not.toMatch(/await\s+whenChatListReady/);
  });

  it('imports both the marker and the waiter from the ready-gate module', () => {
    expect(flowSrc).toMatch(
      /import\s*\{\s*markChatListReady,\s*whenChatListReady\s*\}\s*from\s*'@lib\/phantomchat\/phantomchat-ready-gate'/
    );
  });

  it('marks BOTH readiness signals inside the identity flow itself', () => {
    // The gate and its producers live on the same call path — if the wiring
    // of either half moves elsewhere, this fails and someone has to justify
    // the move (this is the drift the round-1 review caught).
    expect(flowSrc).toContain("markChatListReady('read-state')");
    expect(flowSrc).toContain("markChatListReady('previews')");
  });

  it('gate still resolves bounded — dead relay can never wedge the splash', () => {
    // Timeout escape hatch must stay in the gate module.
    expect(gateSrc).toMatch(/setTimeout\s*\(\s*finish\s*,\s*timeoutMs\s*\)/);
    expect(gateSrc).toMatch(/READY_TIMEOUT_MS\s*=\s*10_000/);
  });
});
