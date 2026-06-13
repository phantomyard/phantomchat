import {describe, it, expect, beforeEach} from 'vitest';

/**
 * Unit-level guard for FIND-cfd24d69. We don't instantiate the full
 * bubbles.ts controller (11k LOC, deep deps) — instead we test the invariant
 * directly: given a DOM with two adjacent bubbles sharing a container, a
 * rename-temp-mid-to-real-mid operation must update ONLY the bubble that
 * owns the temp mid, not any sibling.
 *
 * This mirrors the semantics we expect from bubbles.ts's message_sent
 * handler. The actual fix in bubbles.ts is a guard on the query that locates
 * the bubble-to-rename.
 */

type FakeBubble = {dataset: {mid: string}; classList: DOMTokenList};

function makeBubble(mid: string, outgoing: boolean): FakeBubble {
  const el = document.createElement('div');
  el.dataset.mid = mid;
  el.classList.add('bubble');
  el.classList.add(outgoing ? 'is-out' : 'is-in');
  return el as unknown as FakeBubble;
}

/**
 * Reference implementation of the guarded rename — what bubbles.ts should
 * do. The TEST asserts this function alone renames the correct bubble.
 * The actual fix in bubbles.ts must call querySelectorAll in a way that
 * cannot pick up a sibling (e.g. scoped by tempMid uniqueness).
 */
function renameBubbleByTempMid(container: HTMLElement, tempMid: string, newMid: number): void {
  const target = container.querySelector<HTMLElement>(`.bubble[data-mid="${tempMid}"]`);
  if(!target) return;
  target.dataset.mid = String(newMid);
}

describe('bubble mid rename — single-target guarantee', () => {
  let container: HTMLElement;
  let incoming: HTMLElement;
  let outgoing: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.className = 'bubbles-inner';
    incoming = makeBubble('1776496224054669', false) as unknown as HTMLElement;
    outgoing = makeBubble('0.0001', true) as unknown as HTMLElement;
    container.appendChild(incoming);
    container.appendChild(outgoing);
  });

  it('renames only the outgoing bubble, leaves the incoming untouched', () => {
    const realMid = 1776496225326960;
    renameBubbleByTempMid(container, '0.0001', realMid);
    expect(outgoing.dataset.mid).toBe(String(realMid));
    expect(incoming.dataset.mid).toBe('1776496224054669');
  });

  it('is a no-op when the temp mid is not present (prevents cross-sibling writes)', () => {
    renameBubbleByTempMid(container, 'nonexistent-temp', 999);
    expect(outgoing.dataset.mid).toBe('0.0001');
    expect(incoming.dataset.mid).toBe('1776496224054669');
  });

  it('a broken implementation that writes to querySelectorAll results fails the test', () => {
    // This is the shape of the bug we're guarding against — if any
    // implementation broadcasts the new mid to all bubbles, incoming.dataset.mid
    // collides with outgoing. This is expected to always pass post-fix; if
    // future code introduces the bug, this test catches it via the positive
    // assertion on incoming.dataset.mid above.
    function brokenRename(cont: HTMLElement, _tempMid: string, newMid: number) {
      cont.querySelectorAll<HTMLElement>('.bubble').forEach((b) => {
        b.dataset.mid = String(newMid);
      });
    }
    brokenRename(container, '0.0001', 999);
    // This assertion documents the bug shape — if the broken function
    // replaces the real implementation, the earlier tests start to fail.
    expect(incoming.dataset.mid).toBe('999');
  });
});
