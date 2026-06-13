// @ts-nocheck
import type {Invariant, FuzzContext, UserHandle, InvariantResult, Action} from '../types';

type BubbleSnapshot = {
  bubbles: Array<{dataset: Record<string, string>; classList: string[]}>;
};

/**
 * Browser-side DOM collector. Serialised and sent into the page by
 * `page.evaluate` — MUST be a pure arrow with no closures. Unit tests mock
 * `page.evaluate` to return a canned snapshot and don't run this collector.
 */
const COLLECT_BUBBLES = (): BubbleSnapshot => {
  const nodes = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
  return {
    bubbles: nodes.map((n) => ({
      dataset: {...(n as HTMLElement).dataset},
      classList: Array.from((n as HTMLElement).classList)
    }))
  };
};

/**
 * Two-phase invariant runner: (1) collect a DOM snapshot in the browser,
 * (2) run the invariant predicate against it in Node. Keeps browserScript a
 * pure function on plain data so tests can mock `page.evaluate` to return the
 * snapshot directly.
 */
async function forEachUser(
  ctx: FuzzContext,
  browserScript: (args: BubbleSnapshot) => InvariantResult | Promise<InvariantResult>
): Promise<InvariantResult> {
  for(const id of ['userA', 'userB'] as const) {
    const user: UserHandle = ctx.users[id];
    const snapshot: BubbleSnapshot = await user.page.evaluate(COLLECT_BUBBLES);
    const result = await browserScript(snapshot);
    if(!result.ok) return {...result, evidence: {...(result.evidence || {}), user: id}};
  }
  return {ok: true};
}

export const noDupMid: Invariant = {
  id: 'INV-no-dup-mid',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    return forEachUser(ctx, (args) => {
      const mids = args.bubbles.map((b) => b.dataset.mid);
      const set = new Set(mids);
      if(set.size === mids.length) return {ok: true};
      const dupes = mids.filter((m, i) => mids.indexOf(m) !== i);
      return {
        ok: false,
        message: `duplicate mid(s) in DOM: ${[...new Set(dupes)].join(', ')}`,
        evidence: {totalBubbles: mids.length, uniqueMids: set.size, duplicates: [...new Set(dupes)]}
      };
    });
  }
};

export const bubbleChronological: Invariant = {
  id: 'INV-bubble-chronological',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    return forEachUser(ctx, (args) => {
      const ts = args.bubbles.map((b) => Number(b.dataset.timestamp)).filter((n) => !Number.isNaN(n));
      for(let i = 1; i < ts.length; i++) {
        if(ts[i] < ts[i - 1]) {
          return {
            ok: false,
            message: `bubbles not chronological: idx ${i - 1}=${ts[i - 1]} > idx ${i}=${ts[i]}`,
            evidence: {timestamps: ts}
          };
        }
      }
      return {ok: true};
    });
  }
};

export const noAutoPin: Invariant = {
  id: 'INV-no-auto-pin',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    return forEachUser(ctx, (args) => {
      const pinned = args.bubbles.filter((b) => (b.classList as any as string[]).includes('is-pinned'));
      if(pinned.length === 0) return {ok: true};
      return {
        ok: false,
        message: `found ${pinned.length} pinned bubble(s) without a pin action`,
        evidence: {pinnedMids: pinned.map((b) => b.dataset.mid)}
      };
    });
  }
};

export const sentBubbleVisibleAfterSend: Invariant = {
  id: 'INV-sent-bubble-visible-after-send',
  tier: 'cheap',
  async check(ctx: FuzzContext, action?: Action): Promise<InvariantResult> {
    if(!action || action.name !== 'sendText' || action.skipped) return {ok: true};
    // tweb trims leading/trailing whitespace on send, and drops empty sends —
    // match on the trimmed value, skip when the trimmed text is empty.
    const text: string = String(action.args.text).trim();
    if(!text) return {ok: true};
    const fromId: 'userA' | 'userB' = action.args.from;
    const user = ctx.users[fromId];
    const found = await user.page.evaluate((needle: string) => {
      const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
      for(const b of bubbles) {
        const clone = b.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.time, .time-inner, .reactions, .bubble-pin').forEach((e) => e.remove());
        // tweb may render emoji as <img alt="🔥"> (native-emoji off / custom
        // emoji pack); textContent ignores alt. Concat alt= of all imgs so
        // the needle match works in both rendering modes. Mirrors the fix in
        // postconditions/messaging.ts (POST-sendText-bubble-appears, FIND-3c99f5a3).
        const imgAlt = Array.from(clone.querySelectorAll('img[alt]'))
          .map((i) => i.getAttribute('alt') || '').join('');
        const fullText = (clone.textContent || '') + imgAlt;
        if(fullText.includes(needle)) return true;
      }
      return false;
    }, text);
    if(found) return {ok: true};
    return {
      ok: false,
      message: `sent text "${text.slice(0, 30)}" not visible on sender ${fromId}`,
      evidence: {sender: fromId, text: text.slice(0, 100)}
    };
  }
};
