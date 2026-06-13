import {z} from 'zod';
import type {IntentDef, IntentResult} from './types';
import type {AtomicAction} from '../types';
import type {FuzzContext} from '../../../src/tests/fuzz/types';

const OpenSettingsParams = z.object({page: z.enum(['userA', 'userB'])});
const OpenChatWithParams = z.object({
  page: z.enum(['userA', 'userB']),
  peer: z.enum(['userA', 'userB'])
});
const ScrollHistoryBackParams = z.object({
  page: z.enum(['userA', 'userB']),
  messageCount: z.number().int().min(1).max(200)
});

const pageOf = (u: 'userA'|'userB'): 'A'|'B' => u === 'userA' ? 'A' : 'B';

export const open_settings: IntentDef<z.infer<typeof OpenSettingsParams>> = {
  name: 'open_settings',
  area: 'navigation',
  paramsSchema: OpenSettingsParams,
  description: 'Open the settings panel on the given user.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.page];
    const trace: AtomicAction[] = [];
    try {
      // Clear any leftover menu/overlay from a previous failed intent.
      await u.page.keyboard.press('Escape').catch((): void => undefined);
      // Prefer the folders-sidebar menu button (visible when body.has-folders-sidebar);
      // fall back to the chatlist-header button on layouts where it isn't collapsed.
      const menuBtn = u.page.locator('.folders-sidebar .sidebar-tools-button, .sidebar-header__btn-container.is-visible .sidebar-tools-button, .sidebar-header .btn-menu-toggle').first();
      trace.push({type: 'click', page: pageOf(params.page), selector: 'visible menu-toggle button'});
      await menuBtn.click({timeout: 3000});
      // Match by inner `.btn-menu-item-text` span: parent `.btn-menu-item`
      // textContent includes a leading PUA glyph (e.g. ) from the
      // tgico icon, so anchored regexes against the parent never match.
      const settingsItem = u.page.locator('.btn-menu.active .btn-menu-item').filter({
        has: u.page.locator('.btn-menu-item-text', {hasText: /^Settings$/i})
      }).first();
      trace.push({type: 'click', page: pageOf(params.page), selector: 'menu Settings item'});
      await settingsItem.click({timeout: 3000});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      // Defensive cleanup — leftover menu blocks every subsequent click.
      await u.page.keyboard.press('Escape').catch((): void => undefined);
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const open_chat_with: IntentDef<z.infer<typeof OpenChatWithParams>> = {
  name: 'open_chat_with',
  area: 'navigation',
  paramsSchema: OpenChatWithParams,
  description: 'Open the chat with the OTHER peer (from the perspective of the page user) using the deterministic remotePeerId. Note: in F1 we only have 2 users, so this opens the chat to whichever user is NOT the page user — the params.peer field is informational.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.page];
    const trace: AtomicAction[] = [];
    try {
      trace.push({type: 'evaluate', page: pageOf(params.page),
        script: `appImManager.setPeer({peerId: ${u.remotePeerId}})`});
      await u.page.evaluate((peerId: number) => {
        (window as any).appImManager?.setPeer?.({peerId});
      }, u.remotePeerId);
      await u.page.waitForTimeout(300);
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const scroll_history_back: IntentDef<z.infer<typeof ScrollHistoryBackParams>> = {
  name: 'scroll_history_back',
  area: 'navigation',
  paramsSchema: ScrollHistoryBackParams,
  description: 'Scroll the open chat backwards by approximately N messages worth.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.page];
    const trace: AtomicAction[] = [];
    try {
      const container = u.page.locator('.bubbles-inner, .chat-bubbles').first();
      const scrolls = Math.min(params.messageCount, 50);
      for(let i = 0; i < scrolls; i++) {
        trace.push({type: 'evaluate', page: pageOf(params.page),
          script: 'el.scrollTop -= 800'});
        await container.evaluate((el) => {(el as HTMLElement).scrollTop -= 800;});
        await u.page.waitForTimeout(80);
      }
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const navigationIntents: Record<string, IntentDef<any>> = {
  open_settings: open_settings as IntentDef<any>,
  open_chat_with: open_chat_with as IntentDef<any>,
  scroll_history_back: scroll_history_back as IntentDef<any>
};
