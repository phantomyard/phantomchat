import {z} from 'zod';
import type {IntentDef, IntentResult} from './types';
import type {AtomicAction} from '../types';
import type {FuzzContext} from '../../../src/tests/fuzz/types';
import type {Page} from 'playwright';

const ToggleThemeParams = z.object({
  user: z.enum(['userA', 'userB'])
});

const SetLanguageParams = z.object({
  user: z.enum(['userA', 'userB']),
  langCode: z.enum(['en', 'it', 'es', 'fr', 'de', 'pt', 'ru'])
});

const pageOf = (u: 'userA'|'userB'): 'A'|'B' => u === 'userA' ? 'A' : 'B';

async function openSettings(page: Page): Promise<void> {
  // Clear any leftover menu/overlay from a previous failed intent.
  await page.keyboard.press('Escape').catch((): void => undefined);
  // Prefer folders-sidebar menu button (visible when body.has-folders-sidebar);
  // fall back to chatlist-header on layouts without it.
  await page.locator('.folders-sidebar .sidebar-tools-button, .sidebar-header__btn-container.is-visible .sidebar-tools-button, .sidebar-header .btn-menu-toggle').first().click({timeout: 3000});
  // Match by inner `.btn-menu-item-text` span — parent `.btn-menu-item`
  // textContent includes a leading PUA glyph (e.g. ) so anchored
  // regexes against the parent never match.
  await page.locator('.btn-menu.active .btn-menu-item').filter({
    has: page.locator('.btn-menu-item-text', {hasText: /^Settings$/i})
  }).first().click({timeout: 3000});
}

export const toggle_theme: IntentDef<z.infer<typeof ToggleThemeParams>> = {
  name: 'toggle_theme',
  area: 'settings',
  paramsSchema: ToggleThemeParams,
  description: 'Toggle between light and dark theme via the appearance settings.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      await openSettings(u.page);
      const appearanceItem = u.page.getByText(/appearance|theme/i).first();
      await appearanceItem.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'Appearance'});
      const toggleBtn = u.page.getByRole('button', {name: /dark|light/i}).first()
      .or(u.page.locator('input[type="checkbox"][name="theme"]').first());
      await toggleBtn.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'theme toggle'});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      // Defensive cleanup — leftover menu blocks every subsequent click.
      await u.page.keyboard.press('Escape').catch((): void => undefined);
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const set_language: IntentDef<z.infer<typeof SetLanguageParams>> = {
  name: 'set_language',
  area: 'settings',
  paramsSchema: SetLanguageParams,
  description: 'Change the UI language to the given language code.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      await openSettings(u.page);
      const langItem = u.page.getByText(/language/i).first();
      await langItem.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'Language'});
      const langOption = u.page.locator(`[data-lang="${params.langCode}"]`).first()
      .or(u.page.getByText(new RegExp(`\\b${params.langCode}\\b`, 'i')).first());
      await langOption.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: `lang ${params.langCode}`});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      // Defensive cleanup — leftover menu blocks every subsequent click.
      await u.page.keyboard.press('Escape').catch((): void => undefined);
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const settingsIntents: Record<string, IntentDef<any>> = {
  toggle_theme: toggle_theme as IntentDef<any>,
  set_language: set_language as IntentDef<any>
};
