import {describe, it, expect, beforeEach, vi} from 'vitest';

// Vitest can't resolve Vite's `?worker&url` suffix. Stub the module so tests
// get a deterministic bundle URL to compare against. vi.mock is hoisted above
// imports, so the URL must be inline.
vi.mock('@lib/update/service-worker-url', () => ({ServiceWorkerURL: 'http://localhost/sw-BUNDLE.js'}));

import {resolveSwRegistrationUrl} from '@lib/update/sw-register-url';

describe('resolveSwRegistrationUrl', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns bundle URL on first install (no installedSwUrl stored)', () => {
    expect(resolveSwRegistrationUrl()).toBe('http://localhost/sw-BUNDLE.js');
  });

  it('returns stored installedSwUrl in steady state, ignoring new bundle hash', () => {
    // Regression: a new deploy gives the bundle a different ServiceWorkerURL
    // hash. If the register call uses the bundle URL instead of the stored one,
    // the browser installs a waiting SW → update-bootstrap Step 1a.5 throws
    // CompromiseAlertError('unexpected-waiting-sw') on every subsequent boot.
    // See nostra.chat/src/lib/update/update-bootstrap.ts:121.
    localStorage.setItem('nostra.update.installedSwUrl', 'http://localhost/sw-HASH1.js');
    expect(resolveSwRegistrationUrl()).toBe('http://localhost/sw-HASH1.js');
  });

  it('falls back to bundle URL if stored value is an empty string', () => {
    localStorage.setItem('nostra.update.installedSwUrl', '');
    expect(resolveSwRegistrationUrl()).toBe('http://localhost/sw-BUNDLE.js');
  });
});
