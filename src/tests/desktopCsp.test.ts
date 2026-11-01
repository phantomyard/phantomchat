import {buildCsp, inlineScriptHashes} from '../../electron/csp';

const scriptSrcOf = (policy: string) => policy.split('; ').find((part) => part.startsWith('script-src'))?.split(' ');
const DOCUMENT = '<script>boot()</script><script src="x.js"></script><script> </script>';

describe('desktop script-src', () => {
  test('allows rlottie WebAssembly compilation', () => {
    expect(scriptSrcOf(buildCsp())).toContain("'wasm-unsafe-eval'");
  });

  test('keeps JavaScript eval and arbitrary inline scripts blocked', () => {
    const scriptSrc = scriptSrcOf(buildCsp(DOCUMENT));
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'self'");
  });

  test('allows only the inline script bodies in the served document', () => {
    const hashes = inlineScriptHashes(DOCUMENT);
    expect(hashes).toHaveLength(1);
    expect(scriptSrcOf(buildCsp(DOCUMENT))).toEqual(expect.arrayContaining(hashes));
    expect(scriptSrcOf(buildCsp()).some((source) => source.includes('sha256-'))).toBe(false);
  });
});
