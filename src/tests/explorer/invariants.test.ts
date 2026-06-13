import {describe, expect, it, beforeAll, afterAll} from 'vitest';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright';
import {compileInvariant, runInvariant, type SandboxContext} from '../../../scripts/explorer/oracles/invariants';

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

describe('Oracle D — invariant vm sandbox', () => {
  it('compileInvariant accepts a syntactically valid fn body', () => {
    const inv = compileInvariant({
      name: 'INV-test',
      description: 'Always true',
      fnBody: 'return {ok: true};'
    });
    expect(inv.name).toBe('INV-test');
  });

  it('runInvariant executes a true invariant against live pages', async() => {
    await pageA.setContent('<div class="bubble">a</div><div class="bubble">b</div>');
    const inv = compileInvariant({
      name: 'INV-bubble-count-pos',
      description: 'pageA has at least 1 bubble',
      fnBody: `
        const c = await ctx.pageA.locator('.bubble').count();
        return {ok: c >= 1, value: {bubbles: c}};
      `
    });
    const ctx: SandboxContext = {pageA, pageB};
    const result = await runInvariant(inv, ctx, 5000);
    expect(result.ok).toBe(true);
  });

  it('runInvariant detects a false invariant', async() => {
    await pageA.setContent('<div>nothing</div>');
    const inv = compileInvariant({
      name: 'INV-bubble-count-fail',
      description: 'pageA always has bubbles',
      fnBody: `
        const c = await ctx.pageA.locator('.bubble').count();
        return {ok: c > 0};
      `
    });
    const result = await runInvariant(inv, {pageA, pageB}, 5000);
    expect(result.ok).toBe(false);
  });

  it('compileInvariant rejects body containing require/import/process', () => {
    expect(() => compileInvariant({
      name: 'INV-bad',
      description: 'malicious',
      fnBody: 'const fs = require("fs"); return {ok: true};'
    })).toThrow(/banned/i);

    expect(() => compileInvariant({
      name: 'INV-bad2',
      description: 'malicious',
      fnBody: 'process.exit(1); return {ok: true};'
    })).toThrow(/banned/i);
  });

  it('runInvariant times out and reports ok=false', async() => {
    const inv = compileInvariant({
      name: 'INV-slow',
      description: 'never resolves',
      fnBody: 'await new Promise(r => setTimeout(r, 10_000)); return {ok: true};'
    });
    const result = await runInvariant(inv, {pageA, pageB}, 200);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/timeout/i);
  });
});
