// @ts-nocheck
import type {Postcondition, FuzzContext, Action, InvariantResult} from '../types';

export const POST_sendText_bubble_appears: Postcondition = {
  id: 'POST-sendText-bubble-appears',
  async check(ctx, action: Action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const sender = ctx.users[action.args.from as 'userA' | 'userB'];
    // tweb trims leading/trailing whitespace on send (expected behaviour),
    // so the stored message and rendered bubble show the trimmed text. Match
    // on the trimmed value, and skip entirely when the trimmed text is empty
    // (tweb drops no-op sends).
    const text: string = String(action.args.text).trim();
    if(!text) return {ok: true};
    const deadline = Date.now() + 2500;
    while(Date.now() < deadline) {
      const found = await sender.page.evaluate((needle: string) => {
        const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
        for(const b of bubbles) {
          const clone = b.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('.time, .time-inner, .reactions, .bubble-pin').forEach((e) => e.remove());
          // tweb may render emoji as <img alt="🔥"> (native-emoji off / custom
          // emoji pack); textContent ignores alt. Concat alt= of all imgs so
          // the needle match works in both rendering modes.
          const imgAlt = Array.from(clone.querySelectorAll('img[alt]'))
            .map((i) => i.getAttribute('alt') || '').join('');
          const fullText = (clone.textContent || '') + imgAlt;
          if(fullText.includes(needle)) return true;
        }
        return false;
      }, text);
      if(found) return {ok: true};
      await sender.page.waitForTimeout(200);
    }
    return {ok: false, message: `sent bubble with text "${text.slice(0, 40)}" never appeared on sender`};
  }
};

export const POST_sendText_input_cleared: Postcondition = {
  id: 'POST-sendText-input-cleared',
  async check(ctx, action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const sender = ctx.users[action.args.from as 'userA' | 'userB'];
    // Post-send clear is async: sendMessage awaits getConfig/slowMode/payment,
    // dispatches draft_updated via Worker, main-thread setDraft runs in
    // messagesQueuePromise + fastRaf. Under contention this can take >2s. Wait
    // up to 3s before declaring the input dirty.
    const deadline = Date.now() + 3000;
    let lastText = '';
    while(Date.now() < deadline) {
      const text = await sender.page.evaluate(() => {
        const el = document.querySelector('.chat-input [contenteditable="true"]') as HTMLElement | null;
        return ((el?.textContent) || '').trim();
      });
      lastText = text;
      if(text.length === 0) return {ok: true};
      await sender.page.waitForTimeout(100);
    }
    return {
      ok: false,
      message: `chat input not cleared after send (still contains "${lastText.slice(0, 40)}")`,
      evidence: {text: lastText}
    };
  }
};

export const POST_edit_preserves_mid: Postcondition = {
  id: 'POST-edit-preserves-mid',
  async check(ctx, action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const mid = action.meta?.editedMid;
    if(!mid) return {ok: true};
    const sender = ctx.users[action.args.user as 'userA' | 'userB'];
    const stillPresent = await sender.page.evaluate((m: string) => {
      return !!document.querySelector(`.bubbles-inner .bubble[data-mid="${m}"]`);
    }, mid);
    if(stillPresent) return {ok: true};
    return {ok: false, message: `edited bubble mid=${mid} disappeared after edit`};
  }
};

export const POST_edit_content_updated: Postcondition = {
  id: 'POST-edit-content-updated',
  async check(ctx, action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const mid = action.meta?.editedMid;
    const newText = action.meta?.newText as string;
    if(!mid || !newText) return {ok: true};
    const sender = ctx.users[action.args.user as 'userA' | 'userB'];
    // 10s polling window: a 3s window flakes on cold-start iterations where
    // the VMT's local `message_edit` dispatch runs before the chat view has
    // fully mounted its listener — the bubble is updated in mirrors but the
    // DOM catches up on the next mount pass. Extending to 10s matches the
    // `waitForReactionOnPeer` / `waitForBubbleOnPeer` warmup budgets and
    // closes the FIND-1d3adc13 cold-start flake.
    const deadline = Date.now() + 10000;
    while(Date.now() < deadline) {
      const ok = await sender.page.evaluate(({m, t}: any) => {
        const b = document.querySelector(`.bubbles-inner .bubble[data-mid="${m}"]`);
        if(!b) return false;
        const clone = b.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.time, .time-inner, .reactions, .bubble-pin').forEach((e) => e.remove());
        return (clone.textContent || '').includes(t);
      }, {m: mid, t: newText});
      if(ok) return {ok: true};
      await sender.page.waitForTimeout(200);
    }
    return {ok: false, message: `edited bubble mid=${mid} content not updated to "${newText.slice(0, 40)}"`};
  }
};

export const POST_delete_local_bubble_gone: Postcondition = {
  id: 'POST-delete-local-bubble-gone',
  async check(ctx, action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const mid = action.meta?.deletedMid;
    if(!mid) return {ok: true};
    const sender = ctx.users[action.args.user as 'userA' | 'userB'];
    const deadline = Date.now() + 2500;
    while(Date.now() < deadline) {
      const gone = await sender.page.evaluate((m: string) => {
        return !document.querySelector(`.bubbles-inner .bubble[data-mid="${m}"]`);
      }, mid);
      if(gone) return {ok: true};
      await sender.page.waitForTimeout(200);
    }
    return {ok: false, message: `deleted bubble mid=${mid} still present locally`};
  }
};

export const POST_react_emoji_appears: Postcondition = {
  id: 'POST-react-emoji-appears',
  async check(ctx, action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const mid = action.meta?.reactedMid;
    const emoji = action.meta?.emoji as string;
    if(!mid || !emoji) return {ok: true};
    const sender = ctx.users[action.args.user as 'userA' | 'userB'];
    const deadline = Date.now() + 2500;
    while(Date.now() < deadline) {
      const ok = await sender.page.evaluate(({m, e}: any) => {
        const bubble = document.querySelector(`.bubbles-inner .bubble[data-mid="${m}"]`);
        return !!bubble && !!bubble.querySelector('.reactions') && (bubble.textContent || '').includes(e);
      }, {m: mid, e: emoji});
      if(ok) return {ok: true};
      await sender.page.waitForTimeout(200);
    }
    return {ok: false, message: `reaction ${emoji} not visible on mid=${mid}`};
  }
};

export const POST_react_peer_sees_emoji: Postcondition = {
  id: 'POST_react_peer_sees_emoji',
  async check(ctx: FuzzContext, action: Action) {
    if(action.skipped) return {ok: true};
    const fromUser: 'userA' | 'userB' = action.args.user;
    const toUser: 'userA' | 'userB' = fromUser === 'userA' ? 'userB' : 'userA';
    const peer = ctx.users[toUser];
    const emoji = action.args.emoji;
    const mid = action.meta?.reactedMid;
    if(!mid) return {ok: true};
    // Poll up to 3s.
    const deadline = Date.now() + 3000;
    while(Date.now() < deadline) {
      const has = await peer.page.evaluate((target) => {
        const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
        for(const b of bubbles) {
          if((b as HTMLElement).dataset.mid !== String(target.mid)) continue;
          const rt = b.querySelector('.reactions');
          if(rt && rt.textContent?.includes(target.emoji)) return true;
        }
        return false;
      }, {mid, emoji});
      if(has) return {ok: true};
      await peer.page.waitForTimeout(250);
    }
    return {ok: false, message: `peer ${toUser} never saw emoji ${emoji} on bubble ${mid}`, evidence: {from: fromUser, to: toUser, mid, emoji}};
  }
};

export const POST_remove_reaction_peer_disappears: Postcondition = {
  id: 'POST_remove_reaction_peer_disappears',
  async check(ctx: FuzzContext, action: Action) {
    if(action.skipped) return {ok: true};
    const fromUser: 'userA' | 'userB' = action.args.user;
    const toUser: 'userA' | 'userB' = fromUser === 'userA' ? 'userB' : 'userA';
    const peer = ctx.users[toUser];
    const emoji = action.meta?.emoji;
    const mid = action.meta?.mid;
    if(!emoji || !mid) return {ok: true};
    const deadline = Date.now() + 3000;
    while(Date.now() < deadline) {
      const stillThere = await peer.page.evaluate((target) => {
        const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
        for(const b of bubbles) {
          if((b as HTMLElement).dataset.mid !== String(target.mid)) continue;
          const rt = b.querySelector('.reactions');
          if(rt && rt.textContent?.includes(target.emoji)) return true;
        }
        return false;
      }, {mid, emoji});
      if(!stillThere) return {ok: true};
      await peer.page.waitForTimeout(250);
    }
    return {ok: false, message: `peer ${toUser} still shows removed emoji ${emoji} on bubble ${mid}`, evidence: {from: fromUser, to: toUser, mid, emoji}};
  }
};

export const POST_deleteWhileSending_consistent: Postcondition = {
  id: 'POST_deleteWhileSending_consistent',
  async check(ctx: FuzzContext, action: Action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const text: string = action.meta?.text || '';
    if(!text) return {ok: true};
    // If no tempMid was found, the delete was never actually issued — action
    // effectively became a plain send. Relay delivery timing (especially on
    // first-action cold-start) is not this postcondition's concern; skip.
    if(action.meta?.tempMid == null) return {ok: true};
    // Poll up to 6s (enough for relay publish + peer subscribe roundtrip);
    // outcome must be symmetric: both sides see the msg, or neither does.
    const deadline = Date.now() + 6000;
    while(Date.now() < deadline) {
      const states: Record<string, boolean> = {};
      for(const id of ['userA', 'userB'] as const) {
        const user: any = ctx.users[id];
        states[id] = await user.page.evaluate((needle: string) => {
          const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
          return bubbles.some((b) => (b.textContent || '').includes(needle));
        }, text);
      }
      if(states.userA === states.userB) return {ok: true};
      await ctx.users.userA.page.waitForTimeout(250);
    }
    // Final read
    const sender = ctx.users[action.args.user as 'userA' | 'userB'];
    const peer = ctx.users[action.args.user === 'userA' ? 'userB' : 'userA'];
    const senderHas = await sender.page.evaluate((n: string) => Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]')).some((b) => (b.textContent || '').includes(n)), text);
    const peerHas = await peer.page.evaluate((n: string) => Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]')).some((b) => (b.textContent || '').includes(n)), text);
    if(senderHas === peerHas) return {ok: true};
    return {ok: false, message: `asymmetric deleteWhileSending outcome: sender=${senderHas}, peer=${peerHas} for text "${text}"`, evidence: {senderHas, peerHas, text}};
  }
};

export const POST_react_multi_emoji_separate: Postcondition = {
  id: 'POST_react_multi_emoji_separate',
  async check(ctx: FuzzContext, action: Action) {
    if(action.skipped) return {ok: true};
    const fromUser: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[fromUser];
    const emojis: string[] = action.meta?.emojis || [];
    const mid = action.meta?.targetMid;
    if(!emojis.length || !mid) return {ok: true};
    const deadline = Date.now() + 3000;
    while(Date.now() < deadline) {
      const visible = await sender.page.evaluate((target) => {
        const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
        for(const b of bubbles) {
          if((b as HTMLElement).dataset.mid !== String(target.mid)) continue;
          const rt = b.querySelector('.reactions');
          return rt?.textContent || '';
        }
        return '';
      }, {mid});
      if(emojis.every((em) => visible.includes(em))) return {ok: true};
      await sender.page.waitForTimeout(250);
    }
    return {ok: false, message: `sender ${fromUser} missing one of ${emojis.join(',')} on bubble ${mid}`, evidence: {user: fromUser, mid, emojis}};
  }
};
