// @ts-nocheck
import type {ActionSpec, Action, FuzzContext} from '../types';
import * as fc from 'fast-check';

const TEXT_ARB = fc.oneof(
  {weight: 70, arbitrary: fc.string({minLength: 1, maxLength: 120})},
  {weight: 20, arbitrary: fc.constantFrom('hi', 'hello', '👋', 'ok', 'test 123', '🔥🔥🔥', 'see you')},
  {weight: 10, arbitrary: fc.string({minLength: 1, maxLength: 500})}
);

export const sendText: ActionSpec = {
  name: 'sendText',
  weight: 40,
  generateArgs: () => fc.record({
    from: fc.constantFrom('userA', 'userB'),
    text: TEXT_ARB
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.from;
    const to: 'userA' | 'userB' = from === 'userA' ? 'userB' : 'userA';
    const sender = ctx.users[from];
    const recipient = ctx.users[to];

    // Open the chat to the recipient — but only if not already focused on it.
    // Calling setPeer({peerId}) when already on that peer still falls through
    // to chat.setPeer → bubbles.setPeer → tempId++ which invalidates any
    // in-flight history hydration from the prior send; that race is the root
    // of the FIND-79c70e73 bilateral-bubble-symmetry family (sender's own
    // history collapsed to last-message-only). Idempotent guard fixes most
    // reproductions without losing chat-switch coverage.
    await sender.page.evaluate((peerId: number) => {
      const aim = (window as any).appImManager;
      if(aim?.chat?.peerId === peerId) return;
      aim?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(300);

    // Find the chat input. Following CLAUDE.md: no space inside selectors, no Delete after Ctrl+A.
    const input = sender.page.locator('.chat-input [contenteditable="true"]').first();
    try{
      await input.waitFor({state: 'visible', timeout: 5000});
    } catch{
      action.skipped = true;
      return action;
    }

    await input.focus();
    await sender.page.keyboard.press('Control+A');
    await sender.page.keyboard.press('Backspace');
    // insertText preserves surrogate pairs (emoji). keyboard.type iterates
    // UTF-16 code units, which presses each half of a surrogate pair as its
    // own key — garbage/empty on contenteditable. See FIND-3c99f5a3.
    await sender.page.keyboard.insertText(action.args.text);

    const sendBtn = sender.page.locator('.chat-input button.btn-send').first();
    await sendBtn.click().catch(() => {});

    action.meta = {sentAt: Date.now(), fromId: from, toId: to, text: action.args.text};
    return action;
  }
};

async function pickRandomBubbleMid(
  ctx: FuzzContext,
  user: 'userA' | 'userB',
  ownOnly: boolean
): Promise<string | null> {
  const u = ctx.users[user];
  return u.page.evaluate((own: boolean) => {
    const selector = own
      ? '.bubbles-inner .bubble[data-mid].is-out, .bubbles-inner .bubble[data-mid].is-own'
      : '.bubbles-inner .bubble[data-mid]';
    // Exclude bubbles still in the send pipeline — their data-mid is a
    // temp (e.g. 0.0001), and acting on them races the message_sent rename.
    // Users would not interact with a spinning bubble either.
    const bubbles = Array.from(document.querySelectorAll(selector))
      .filter((b) => !(b as HTMLElement).classList.contains('is-sending') &&
                     !(b as HTMLElement).classList.contains('is-outgoing'));
    if(bubbles.length === 0) return null;
    const b = bubbles[Math.floor(Math.random() * bubbles.length)] as HTMLElement;
    return b.dataset.mid || null;
  }, ownOnly);
}

export const replyToRandomBubble: ActionSpec = {
  name: 'replyToRandomBubble',
  weight: 15,
  generateArgs: () => fc.record({from: fc.constantFrom('userA', 'userB'), text: TEXT_ARB}),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.from;
    const sender = ctx.users[from];
    await sender.page.evaluate((peerId: number) => {
      const aim = (window as any).appImManager;
      if(aim?.chat?.peerId === peerId) return;
      aim?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(300);

    const mid = await pickRandomBubbleMid(ctx, from, false);
    if(!mid) {action.skipped = true; return action;}

    // Trigger reply via API (context menu is flaky in headless).
    const ok = await sender.page.evaluate((targetMid: string) => {
      const chat = (window as any).appImManager?.chat;
      if(!chat) return false;
      try{
        chat.input.initMessageReply?.({mid: Number(targetMid)});
        return true;
      } catch{ return false; }
    }, mid);
    if(!ok) {action.skipped = true; return action;}

    const input = sender.page.locator('.chat-input [contenteditable="true"]').first();
    await input.focus();
    await sender.page.keyboard.press('Control+A');
    await sender.page.keyboard.press('Backspace');
    // insertText preserves surrogate pairs — see FIND-3c99f5a3 notes on sendText.
    await sender.page.keyboard.insertText(action.args.text);
    await sender.page.locator('.chat-input button.btn-send').first().click().catch(() => {});

    action.meta = {sentAt: Date.now(), replyToMid: mid, text: action.args.text, fromId: from};
    return action;
  }
};

export const editRandomOwnBubble: ActionSpec = {
  name: 'editRandomOwnBubble',
  weight: 8,
  generateArgs: () => fc.record({user: fc.constantFrom('userA', 'userB'), newText: TEXT_ARB}),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[from];
    await sender.page.evaluate((peerId: number) => {
      const aim = (window as any).appImManager;
      if(aim?.chat?.peerId === peerId) return;
      aim?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(300);

    const mid = await pickRandomBubbleMid(ctx, from, true);
    if(!mid) {action.skipped = true; return action;}

    const beforeSnapshot = await sender.page.evaluate((targetMid: string) => {
      const b = document.querySelector(`.bubbles-inner .bubble[data-mid="${targetMid}"]`);
      if(!b) return null;
      const clone = b.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.time, .time-inner, .reactions, .bubble-pin').forEach((e) => e.remove());
      return {
        mid: (b as HTMLElement).dataset.mid,
        timestamp: (b as HTMLElement).dataset.timestamp,
        content: (clone.textContent || '').trim()
      };
    }, mid);

    const started = await sender.page.evaluate((targetMid: string) => {
      const chat = (window as any).appImManager?.chat;
      if(!chat?.input?.initMessageEditing) return false;
      try{
        chat.input.initMessageEditing(Number(targetMid));
        return true;
      } catch{ return false; }
    }, mid);
    if(!started) {action.skipped = true; return action;}

    const input = sender.page.locator('.chat-input [contenteditable="true"]').first();
    await input.focus();
    await sender.page.keyboard.press('Control+A');
    await sender.page.keyboard.press('Backspace');
    // insertText preserves surrogate pairs — see FIND-3c99f5a3 notes on sendText.
    await sender.page.keyboard.insertText(action.args.newText);
    await sender.page.locator('.chat-input button.btn-send').first().click().catch(() => {});

    action.meta = {editedMid: mid, newText: action.args.newText, editedAt: Date.now(), beforeSnapshot};
    return action;
  }
};

export const deleteRandomOwnBubble: ActionSpec = {
  name: 'deleteRandomOwnBubble',
  weight: 5,
  generateArgs: () => fc.record({user: fc.constantFrom('userA', 'userB')}),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[from];
    await sender.page.evaluate((peerId: number) => {
      const aim = (window as any).appImManager;
      if(aim?.chat?.peerId === peerId) return;
      aim?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(300);

    const mid = await pickRandomBubbleMid(ctx, from, true);
    if(!mid) {action.skipped = true; return action;}

    // Drive via manager — context menu + modal confirmation is too flaky.
    const done = await sender.page.evaluate(async (targetMid: string) => {
      const rs = (window as any).rootScope;
      const peerId = (window as any).appImManager?.chat?.peerId;
      if(!rs?.managers?.appMessagesManager || !peerId) return false;
      try{
        await rs.managers.appMessagesManager.deleteMessages(peerId, [Number(targetMid)], true);
        return true;
      } catch{ return false; }
    }, mid);
    if(!done) {action.skipped = true; return action;}

    action.meta = {deletedMid: mid, deletedAt: Date.now()};
    return action;
  }
};

export const reactToRandomBubble: ActionSpec = {
  name: 'reactToRandomBubble',
  weight: 12,
  generateArgs: () => fc.record({
    user: fc.constantFrom('userA', 'userB'),
    fromTarget: fc.constantFrom('own', 'peer'),
    emoji: fc.constantFrom('❤️', '👍', '😂', '🔥', '🤔')
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[from];
    await sender.page.evaluate((peerId: number) => {
      const aim = (window as any).appImManager;
      if(aim?.chat?.peerId === peerId) return;
      aim?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(300);

    const ownOnly = action.args.fromTarget === 'own';
    const mid = await pickRandomBubbleMid(ctx, from, ownOnly);
    if(!mid) {action.skipped = true; return action;}

    const ok = await sender.page.evaluate(async ({targetMid, emoji}: any) => {
      const rs = (window as any).rootScope;
      const peerId = (window as any).appImManager?.chat?.peerId;
      const mgr = rs?.managers?.appReactionsManager;
      if(!mgr?.sendReaction || !peerId) return false;
      try{
        await mgr.sendReaction({
          message: {peerId, mid: Number(targetMid)},
          reaction: {_: 'reactionEmoji', emoticon: emoji}
        });
        return true;
      } catch{ return false; }
    }, {targetMid: mid, emoji: action.args.emoji});
    if(!ok) {action.skipped = true; return action;}

    action.meta = {reactedMid: mid, emoji: action.args.emoji, fromTarget: action.args.fromTarget};
    return action;
  }
};

export const removeReaction: ActionSpec = {
  name: 'removeReaction',
  weight: 4,
  generateArgs: () => fc.record({user: fc.constantFrom('userA', 'userB')}),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[from];
    await sender.page.evaluate((peerId: number) => {
      const aim = (window as any).appImManager;
      if(aim?.chat?.peerId === peerId) return;
      aim?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(200);

    const picked = await sender.page.evaluate(async () => {
      const store = (window as any).__phantomchatReactionsStore;
      if(!store) return null;
      const rows = await store.getAll();
      const own = rows.filter((r: any) => r.fromPubkey && r.reactionEventId);
      if(!own.length) return null;
      const p = own[Math.floor(Math.random() * own.length)];
      return {reactionEventId: p.reactionEventId, mid: p.targetMid, emoji: p.emoji};
    });
    if(!picked) {action.skipped = true; return action;}

    const ok = await sender.page.evaluate(async (reId: string) => {
      try {
        await (window as any).__phantomchatReactionsPublish.unpublish(reId);
        return true;
      } catch { return false; }
    }, picked.reactionEventId);
    if(!ok) {action.skipped = true; return action;}

    action.meta = {removedReactionId: picked.reactionEventId, mid: picked.mid, emoji: picked.emoji};
    return action;
  }
};

export const reactMultipleEmoji: ActionSpec = {
  name: 'reactMultipleEmoji',
  weight: 3,
  generateArgs: () => fc.record({
    user: fc.constantFrom('userA', 'userB'),
    emojis: fc.uniqueArray(fc.constantFrom('❤️', '👍', '😂', '🔥', '🤔'), {minLength: 2, maxLength: 3})
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[from];
    await sender.page.evaluate((peerId: number) => {
      const aim = (window as any).appImManager;
      if(aim?.chat?.peerId === peerId) return;
      aim?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(200);

    const mid = await pickRandomBubbleMid(ctx, from, false);
    if(!mid) {action.skipped = true; return action;}

    const emojis: string[] = action.args.emojis;
    for(const emoji of emojis) {
      const ok = await sender.page.evaluate(async ({targetMid, em}: any) => {
        const rs = (window as any).rootScope;
        const peerId = (window as any).appImManager?.chat?.peerId;
        try {
          await rs.managers.appReactionsManager.sendReaction({
            message: {peerId, mid: Number(targetMid)},
            reaction: {_: 'reactionEmoji', emoticon: em}
          });
          return true;
        } catch { return false; }
      }, {targetMid: mid, em: emoji});
      if(!ok) {action.skipped = true; return action;}
      await sender.page.waitForTimeout(300); // let each publish settle
    }

    action.meta = {targetMid: mid, emojis};
    return action;
  }
};
