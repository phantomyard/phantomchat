import {readFileSync} from 'node:fs';

// Pin the policy emitted into electron/dist/csp.json, rather than a second
// copy of the policy that could drift away from the packaged desktop build.
const build = readFileSync('electron/build.mjs', 'utf8');
const scriptSrc = build.match(/`script-src ([^`]+)`/)?.[1];

describe('packaged desktop script-src', () => {
  test('allows rlottie WebAssembly compilation', () => {
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc?.split(' ')).toContain("'wasm-unsafe-eval'");
  });

  test('keeps JavaScript eval and arbitrary inline scripts blocked', () => {
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc?.split(' ')).not.toContain("'unsafe-eval'");
    expect(scriptSrc?.split(' ')).not.toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("${scriptHashes.join(' ')}");
  });
});
