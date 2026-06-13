import {z} from 'zod';
import type {IntentDef, IntentResult} from './types';
import type {AtomicAction} from '../types';
import type {FuzzContext} from '../../../src/tests/fuzz/types';
import type {Page} from 'playwright';

const ForwardMessageParams = z.object({
  from: z.enum(['userA', 'userB']),
  toPeer: z.string()
});

const PinMessageParams = z.object({
  user: z.enum(['userA', 'userB'])
});

const DeleteForEveryoneParams = z.object({
  user: z.enum(['userA', 'userB'])
});

const SearchInChatParams = z.object({
  user: z.enum(['userA', 'userB']),
  query: z.string().min(1).max(100)
});

const DeepScrollParams = z.object({
  user: z.enum(['userA', 'userB']),
  totalScrolls: z.number().int().min(1).max(200)
});

const pageOf = (u: 'userA'|'userB'): 'A'|'B' => u === 'userA' ? 'A' : 'B';

async function rightClickRandomBubble(page: Page, ownOnly: boolean): Promise<void> {
  // Clear any leftover menu/overlay from a previous failed intent before
  // opening a new context menu. The .btn-menu-overlay covers the whole
  // viewport (z-index:4, pointer-events:auto) and blocks every subsequent
  // click — including the right-click we're about to attempt.
  await page.keyboard.press('Escape').catch((): void => undefined);
  const selector = ownOnly ?
    '.bubbles-inner .bubble[data-mid].is-out, .bubbles-inner .bubble[data-mid].is-own' :
    '.bubbles-inner .bubble[data-mid]';
  const bubble = page.locator(selector).filter({hasNot: page.locator('.is-sending, .is-outgoing')}).last();
  await bubble.click({button: 'right', timeout: 3000});
}

// Match a context-menu item by inner `.btn-menu-item-text` span. The parent
// `.btn-menu-item` textContent includes a leading PUA glyph from the tgico
// icon (e.g. ), so anchored regexes against the parent never match.
function contextMenuItem(page: Page, label: RegExp) {
  return page.locator('#bubble-contextmenu.active .btn-menu-item').filter({
    has: page.locator('.btn-menu-item-text', {hasText: label})
  }).first();
}

export const forward_message: IntentDef<z.infer<typeof ForwardMessageParams>> = {
  name: 'forward_message',
  area: 'edge',
  paramsSchema: ForwardMessageParams,
  description: 'Right-click a bubble, choose Forward, select target peer from the picker.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.from];
    const trace: AtomicAction[] = [];
    try {
      await rightClickRandomBubble(u.page, false);
      trace.push({type: 'click', page: pageOf(params.from), selector: 'bubble (right-click)'});
      const forwardBtn = contextMenuItem(u.page, /^Forward$/i);
      await forwardBtn.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.from), selector: 'menu Forward'});
      const peerOpt = u.page.getByText(params.toPeer, {exact: false}).first();
      await peerOpt.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.from), selector: `peer ${params.toPeer}`});
      const sendBtn = u.page.getByRole('button', {name: /send|forward/i}).first();
      await sendBtn.click({timeout: 3000});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      // Defensive cleanup — leftover .btn-menu-overlay covers the viewport.
      await u.page.keyboard.press('Escape').catch((): void => undefined);
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const pin_message: IntentDef<z.infer<typeof PinMessageParams>> = {
  name: 'pin_message',
  area: 'edge',
  paramsSchema: PinMessageParams,
  description: 'Right-click a bubble and pin it.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      await rightClickRandomBubble(u.page, false);
      trace.push({type: 'click', page: pageOf(params.user), selector: 'bubble (right-click)'});
      const pinBtn = contextMenuItem(u.page, /^Pin$/i);
      await pinBtn.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'menu Pin'});
      const confirmBtn = u.page.getByRole('button', {name: /^pin|confirm|ok/i}).first();
      if(await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click({timeout: 1000});
      }
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      // Defensive cleanup — leftover .btn-menu-overlay covers the viewport.
      await u.page.keyboard.press('Escape').catch((): void => undefined);
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const delete_for_everyone: IntentDef<z.infer<typeof DeleteForEveryoneParams>> = {
  name: 'delete_for_everyone',
  area: 'edge',
  paramsSchema: DeleteForEveryoneParams,
  description: 'Right-click a user-owned bubble, choose Delete, then check "for everyone" if available.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      await rightClickRandomBubble(u.page, true);
      trace.push({type: 'click', page: pageOf(params.user), selector: 'own bubble (right-click)'});
      const delBtn = contextMenuItem(u.page, /^Delete$/i);
      await delBtn.click({timeout: 3000});
      // Real popup label is "Also delete for {peer-name}" — neither "everyone" nor "all".
      const forEveryone = u.page.getByLabel(/^Also delete for /i).first();
      if(await forEveryone.isVisible().catch(() => false)) {
        await forEveryone.check({timeout: 1000});
        trace.push({type: 'click', page: pageOf(params.user), selector: 'for everyone checkbox'});
      }
      const confirmBtn = u.page.locator('.popup-container.active button.btn-primary', {hasText: /^DELETE$/i}).first();
      await confirmBtn.click({timeout: 3000});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      // Defensive cleanup — leftover .btn-menu-overlay covers the viewport.
      await u.page.keyboard.press('Escape').catch((): void => undefined);
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const search_in_chat: IntentDef<z.infer<typeof SearchInChatParams>> = {
  name: 'search_in_chat',
  area: 'edge',
  paramsSchema: SearchInChatParams,
  description: 'Open the in-chat search and type a query.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      const searchBtn = u.page.locator('.chat-info .btn-search, [data-testid="search-in-chat"]').first();
      if(await searchBtn.isVisible().catch(() => false)) {
        await searchBtn.click({timeout: 3000});
        trace.push({type: 'click', page: pageOf(params.user), selector: 'search button'});
      } else {
        await u.page.keyboard.press('Control+F');
      }
      const searchInput = u.page.locator('.chat-search input, input[placeholder*="search" i]').first();
      await searchInput.fill(params.query);
      trace.push({type: 'fill', page: pageOf(params.user), selector: 'search input', value: params.query});
      await u.page.waitForTimeout(500);
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const deep_scroll: IntentDef<z.infer<typeof DeepScrollParams>> = {
  name: 'deep_scroll',
  area: 'edge',
  paramsSchema: DeepScrollParams,
  description: 'Scroll the open chat backwards aggressively (more than scroll_history_back) — exercises history loading at depth.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      const container = u.page.locator('.bubbles-inner, .chat-bubbles').first();
      for(let i = 0; i < params.totalScrolls; i++) {
        await container.evaluate((el) => {(el as HTMLElement).scrollTop -= 1500;});
        await u.page.waitForTimeout(60);
      }
      trace.push({type: 'evaluate', page: pageOf(params.user), script: `${params.totalScrolls} scroll iterations`});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const messagingEdgeIntents: Record<string, IntentDef<any>> = {
  forward_message: forward_message as IntentDef<any>,
  pin_message: pin_message as IntentDef<any>,
  delete_for_everyone: delete_for_everyone as IntentDef<any>,
  search_in_chat: search_in_chat as IntentDef<any>,
  deep_scroll: deep_scroll as IntentDef<any>
};
