import type {Page} from 'playwright';
import {resolveSelector} from '../selector-resolver';

export type Expectation =
  | {type: 'element_appears'; page: 'A'|'B'; selector_hint: string; text_contains?: string; timeout_ms: number}
  | {type: 'element_disappears'; page: 'A'|'B'; selector_hint: string; timeout_ms: number}
  | {type: 'text_changes'; page: 'A'|'B'; selector_hint: string; from?: string; to_contains: string; timeout_ms: number}
  | {type: 'navigation_to'; page: 'A'|'B'; url_pattern: string; timeout_ms: number}
  | {type: 'count_equals'; page: 'A'|'B'; selector_hint: string; count: number; timeout_ms: number}
  | {type: 'value_changes'; page: 'A'|'B'; selector_hint: string; expected: string; timeout_ms: number}
  | {type: 'bilateral_message_propagation'; from: 'A'|'B'; text_contains: string; timeout_ms: number};

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  observed?: {url: string; html_excerpt?: string};
}

export interface Pages {
  pageA: Page;
  pageB: Page;
}

const pickPage = (pages: Pages, p: 'A'|'B'): Page => p === 'A' ? pages.pageA : pages.pageB;

export async function verifyExpectation(exp: Expectation, pages: Pages): Promise<VerifyResult> {
  const deadline = Date.now() + exp.timeout_ms;
  const page = exp.type === 'bilateral_message_propagation' ?
    pickPage(pages, exp.from) :
    pickPage(pages, exp.page);

  switch(exp.type) {
    case 'element_appears': {
      while(Date.now() < deadline) {
        const loc = await resolveSelector(page, exp.selector_hint);
        if(loc) {
          const count = await loc.count().catch(() => 0);
          if(count > 0) {
            if(exp.text_contains) {
              // Scan ALL matches — list selectors (e.g. `.bubble.is-in`) often
              // produce N elements; reading only the first misses targets that
              // haven't scrolled to the top yet.
              const texts = await loc.allTextContents().catch((): string[] => []);
              if(texts.some((t) => t.includes(exp.text_contains!))) return {ok: true};
            } else {
              return {ok: true};
            }
          }
        }
        await page.waitForTimeout(100);
      }
      return {ok: false, reason: `element_appears hint="${exp.selector_hint}" did not match within ${exp.timeout_ms}ms`};
    }
    case 'element_disappears': {
      while(Date.now() < deadline) {
        const loc = await resolveSelector(page, exp.selector_hint);
        if(!loc) return {ok: true};
        const count = await loc.count().catch(() => 0);
        if(count === 0) return {ok: true};
        await page.waitForTimeout(100);
      }
      return {ok: false, reason: `element_disappears hint="${exp.selector_hint}" still present after ${exp.timeout_ms}ms`};
    }
    case 'text_changes': {
      while(Date.now() < deadline) {
        const loc = await resolveSelector(page, exp.selector_hint);
        if(loc) {
          const text = await loc.textContent().catch(() => '') ?? '';
          if(exp.from && text.includes(exp.from)) {
            await page.waitForTimeout(100);
            continue;
          }
          if(text.includes(exp.to_contains)) return {ok: true};
        }
        await page.waitForTimeout(100);
      }
      return {ok: false, reason: `text_changes to_contains="${exp.to_contains}" not observed within ${exp.timeout_ms}ms`};
    }
    case 'navigation_to': {
      try {
        await page.waitForURL(new RegExp(exp.url_pattern), {timeout: exp.timeout_ms});
        return {ok: true};
      } catch{
        return {ok: false, reason: `navigation_to url_pattern="${exp.url_pattern}" did not occur within ${exp.timeout_ms}ms`, observed: {url: page.url()}};
      }
    }
    case 'count_equals': {
      while(Date.now() < deadline) {
        // Try the priority-chain resolver first; fall back to a raw CSS locator
        // for simple tag names (e.g. 'li', 'button') that have no data-testid.
        const candidate = await resolveSelector(page, exp.selector_hint) ??
          page.locator(exp.selector_hint);
        const count = await candidate.count().catch(() => 0);
        if(count === exp.count) return {ok: true};
        await page.waitForTimeout(100);
      }
      return {ok: false, reason: `count_equals expected ${exp.count} elements with hint="${exp.selector_hint}" within ${exp.timeout_ms}ms`};
    }
    case 'value_changes': {
      while(Date.now() < deadline) {
        const loc = await resolveSelector(page, exp.selector_hint);
        if(loc) {
          const value = await loc.inputValue().catch((): null => null);
          if(value === exp.expected) return {ok: true};
        }
        await page.waitForTimeout(100);
      }
      return {ok: false, reason: `value_changes expected="${exp.expected}" not observed within ${exp.timeout_ms}ms`};
    }
    case 'bilateral_message_propagation': {
      // Sender's outgoing bubble appears AND receiver's incoming bubble appears,
      // both containing text_contains. Implements design spec §4 Oracle B.
      const senderPage = pickPage(pages, exp.from);
      const receiverPage = pickPage(pages, exp.from === 'A' ? 'B' : 'A');
      const seen = {sender: false, receiver: false};
      while(Date.now() < deadline) {
        if(!seen.sender) {
          const text = await senderPage.locator('.bubbles-inner .bubble.is-out').last().textContent().catch(() => '') ?? '';
          if(text.includes(exp.text_contains)) seen.sender = true;
        }
        if(!seen.receiver) {
          const text = await receiverPage.locator('.bubbles-inner .bubble.is-in').last().textContent().catch(() => '') ?? '';
          if(text.includes(exp.text_contains)) seen.receiver = true;
        }
        if(seen.sender && seen.receiver) return {ok: true};
        await page.waitForTimeout(100);
      }
      return {ok: false, reason: `bilateral_message_propagation text="${exp.text_contains}" not propagated bilaterally within ${exp.timeout_ms}ms (sender=${seen.sender} receiver=${seen.receiver})`};
    }
  }
}
