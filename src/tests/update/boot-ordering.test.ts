import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import {resolve} from 'path';

// Regression: the update popup controller MUST be imported (and awaited) before
// `updateBootstrap()` runs. Bootstrap dispatches `update_integrity_check_completed`
// and `update_available` synchronously via dispatchEventSingle — if the controller
// hasn't registered its listeners yet, both events are silently lost and the popup
// never appears on production boot. See update-bootstrap.ts:167-174 and
// update-popup-controller.ts:7-17.
describe('src/index.ts — update popup controller boot ordering', () => {
  const source = readFileSync(resolve(__dirname, '../../index.ts'), 'utf-8');

  it('imports update-popup-controller before calling updateBootstrap', () => {
    const popupImportIdx = source.indexOf('@lib/update/update-popup-controller');
    const bootstrapCallIdx = source.indexOf('await updateBootstrap(');
    expect(popupImportIdx, 'update-popup-controller import not found').toBeGreaterThan(-1);
    expect(bootstrapCallIdx, 'await updateBootstrap() call not found').toBeGreaterThan(-1);
    expect(
      popupImportIdx,
      'update-popup-controller import must appear BEFORE updateBootstrap() call so listeners register before events fire'
    ).toBeLessThan(bootstrapCallIdx);
  });

  it('awaits the controller import so listeners are attached before bootstrap dispatches', () => {
    // Match `await import('...update-popup-controller...')` with any quote style.
    const awaitedImport = /await\s+import\(\s*['"]@lib\/update\/update-popup-controller['"]\s*\)/;
    expect(
      awaitedImport.test(source),
      'update-popup-controller import must be awaited — a non-awaited import() resolves after bootstrap has already dispatched'
    ).toBe(true);
  });
});
