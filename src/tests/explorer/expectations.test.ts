import {describe, expect, it, beforeAll, afterAll} from 'vitest';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright';
import {verifyExpectation, type Expectation} from '../../../scripts/explorer/oracles/expectations';

let browser: Browser;
let ctxA: BrowserContext;
let ctxB: BrowserContext;
let pageA: Page;
let pageB: Page;

beforeAll(async() => {
  browser = await chromium.launch({headless: true});
  ctxA = await browser.newContext();
  ctxB = await browser.newContext();
  pageA = await ctxA.newPage();
  pageB = await ctxB.newPage();
}, 30_000);

afterAll(async() => {
  await ctxA.close();
  await ctxB.close();
  await browser.close();
});

describe('Oracle B — typed expectation verifier', () => {
  it('element_appears resolves true when an element with the hint exists', async() => {
    await pageA.setContent('<button data-testid="send-button">Send</button>');
    const exp: Expectation = {
      type: 'element_appears',
      page: 'A',
      selector_hint: 'send-button',
      timeout_ms: 1000
    };
    const result = await verifyExpectation(exp, {pageA, pageB});
    expect(result.ok).toBe(true);
  });

  it('element_appears resolves false when the element is missing', async() => {
    await pageA.setContent('<div>nothing here</div>');
    const exp: Expectation = {
      type: 'element_appears',
      page: 'A',
      selector_hint: 'send-button',
      timeout_ms: 200
    };
    const result = await verifyExpectation(exp, {pageA, pageB});
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('text_changes resolves true when the element\'s text contains the expected substring', async() => {
    await pageA.setContent('<div data-testid="status">loading</div>');
    setTimeout(() => {
      pageA.evaluate(() => {
        document.querySelector('[data-testid="status"]')!.textContent = 'ready';
      });
    }, 100);
    const exp: Expectation = {
      type: 'text_changes',
      page: 'A',
      selector_hint: 'status',
      to_contains: 'ready',
      timeout_ms: 2000
    };
    const result = await verifyExpectation(exp, {pageA, pageB});
    expect(result.ok).toBe(true);
  });

  it('count_equals resolves true when the count matches', async() => {
    await pageA.setContent('<ul><li>a</li><li>b</li><li>c</li></ul>');
    const exp: Expectation = {
      type: 'count_equals',
      page: 'A',
      selector_hint: 'li',
      count: 3,
      timeout_ms: 500
    };
    const result = await verifyExpectation(exp, {pageA, pageB});
    expect(result.ok).toBe(true);
  });
});
