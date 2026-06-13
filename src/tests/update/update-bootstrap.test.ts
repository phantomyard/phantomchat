import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

// Vitest can't resolve Vite's `?worker&url` suffix used inside service-worker-url.ts.
// Stub the module so the bootstrap sees a stable URL we can assert against.
// vi.mock is hoisted above imports, so the URL must be inline (no outer variable reference).
vi.mock('@lib/update/service-worker-url', () => ({ServiceWorkerURL: 'http://localhost/sw-TEST.js'}));

import {updateBootstrap, __resetForTest} from '@lib/update/update-bootstrap';

const BUNDLE_SW_URL = 'http://localhost/sw-TEST.js';

function mockSWRegistration(opts: {
  activeScriptURL: string;
  waiting?: {scriptURL: string} | null;
  updateImpl?: () => Promise<void>;
}): {registration: any; updateSpy: any} {
  const updateSpy = vi.fn(opts.updateImpl || (async() => {}));
  const registration: any = {
    active: {scriptURL: opts.activeScriptURL},
    waiting: opts.waiting ?? null,
    update: updateSpy
  };
  // Preserve userAgent so that userAgent.ts can read it when rootScope is first imported
  const ua = (global as any).navigator?.userAgent || 'Mozilla/5.0 (jsdom)';
  (global as any).navigator = {
    userAgent: ua,
    ...(global as any).navigator,
    serviceWorker: {ready: Promise.resolve(registration)}
  };
  return {registration, updateSpy};
}

describe('updateBootstrap — Step 0 first install', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetForTest();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('saves bundle-declared SW URL as baseline, not reg.active.scriptURL', async() => {
    // Simulates a pre-Phase-A → Phase-A upgrade: old SW still active, new SW waiting.
    // Step 0 must capture the URL the RUNNING bundle declares, otherwise the next
    // boot (after waiting auto-activates) would false-positive Step 1a.
    mockSWRegistration({activeScriptURL: 'https://app.example.com/sw-OLD.js'});
    await updateBootstrap({skipNetworkChecks: true});
    expect(localStorage.getItem('nostra.update.installedSwUrl')).toBe(BUNDLE_SW_URL);
    expect(localStorage.getItem('nostra.update.installedVersion')).toBeTruthy();
    expect(localStorage.getItem('nostra.update.lastAcceptedVersion')).toBeTruthy();
  });

  it('does not throw on first install', async() => {
    mockSWRegistration({activeScriptURL: 'https://app.example.com/sw-abc.js'});
    await expect(updateBootstrap({skipNetworkChecks: true})).resolves.not.toThrow();
  });
});

describe('updateBootstrap — Step 1a URL consistency', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetForTest();
    localStorage.setItem('nostra.update.installedVersion', 'test-version');
    localStorage.setItem('nostra.update.installedSwUrl', 'https://app.example.com/sw-abc.js');
    localStorage.setItem('nostra.update.lastAcceptedVersion', 'test-version');
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('throws CompromiseAlertError when scriptURL differs from installedSwUrl', async() => {
    mockSWRegistration({activeScriptURL: 'https://app.example.com/sw-EVIL.js'});
    await expect(updateBootstrap({skipNetworkChecks: true})).rejects.toThrow(/sw-url-changed/);
  });

  it('passes when scriptURL matches', async() => {
    mockSWRegistration({activeScriptURL: 'https://app.example.com/sw-abc.js'});
    await expect(updateBootstrap({skipNetworkChecks: true})).resolves.not.toThrow();
  });
});

describe('updateBootstrap — Step 1a.5 unexpected waiting SW', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetForTest();
    localStorage.setItem('nostra.update.installedVersion', 'test-version');
    localStorage.setItem('nostra.update.installedSwUrl', 'https://app.example.com/sw-abc.js');
    localStorage.setItem('nostra.update.lastAcceptedVersion', 'test-version');
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('throws when a waiting SW exists without pendingFinalization', async() => {
    mockSWRegistration({
      activeScriptURL: 'https://app.example.com/sw-abc.js',
      waiting: {scriptURL: 'https://app.example.com/sw-EVIL.js'}
    });
    await expect(updateBootstrap({skipNetworkChecks: true})).rejects.toThrow(/unexpected-waiting-sw/);
  });

  it('allows a waiting SW when pendingFinalization is set (legitimate update in progress)', async() => {
    localStorage.setItem('nostra.update.pendingFinalization', '1');
    mockSWRegistration({
      activeScriptURL: 'https://app.example.com/sw-abc.js',
      waiting: {scriptURL: 'https://app.example.com/sw-new.js'}
    });
    await expect(updateBootstrap({skipNetworkChecks: true})).resolves.not.toThrow();
  });
});

describe('updateBootstrap — Step 1b registration.update byte check', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetForTest();
    localStorage.setItem('nostra.update.installedVersion', 'test-version');
    localStorage.setItem('nostra.update.installedSwUrl', 'https://app.example.com/sw-abc.js');
    localStorage.setItem('nostra.update.lastAcceptedVersion', 'test-version');
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // Obsolete: reg.update() call removed in the consent-gated update design (2026-04-21).
  // The sw-byte-change-at-same-url detection is no longer applicable; SW revalidation
  // is entirely browser-driven and the new waiting SW is not activated without user
  // consent (enforced by the SKIP_WAITING gate in signed-update-sw.ts).
  it.skip('throws CompromiseAlertError when unexpected waiting SW appears after update()', async() => {
    const newWaiting = {scriptURL: 'https://app.example.com/sw-abc.js'};
    const registration: any = {
      active: {scriptURL: 'https://app.example.com/sw-abc.js'},
      waiting: null,
      update: vi.fn(async function(this: any) { registration.waiting = newWaiting; })
    };
    const ua = (global as any).navigator?.userAgent || 'Mozilla/5.0 (jsdom)';
    (global as any).navigator = {userAgent: ua, ...(global as any).navigator, serviceWorker: {ready: Promise.resolve(registration)}};

    await expect(updateBootstrap({skipManifestCheck: true})).rejects.toThrow(/sw-body-changed-at-same-url/);
  });

  it('does not throw if update() produces no waiting', async() => {
    mockSWRegistration({activeScriptURL: 'https://app.example.com/sw-abc.js'});
    await expect(updateBootstrap({skipManifestCheck: true})).resolves.not.toThrow();
  });

  it('does not throw if pendingFinalization is set (expected waiting)', async() => {
    localStorage.setItem('nostra.update.pendingFinalization', '1');
    const newWaiting = {scriptURL: 'https://app.example.com/sw-abc.js'};
    const registration: any = {
      active: {scriptURL: 'https://app.example.com/sw-abc.js'},
      waiting: null,
      update: vi.fn(async function() { registration.waiting = newWaiting; })
    };
    const ua = (global as any).navigator?.userAgent || 'Mozilla/5.0 (jsdom)';
    (global as any).navigator = {userAgent: ua, ...(global as any).navigator, serviceWorker: {ready: Promise.resolve(registration)}};

    await expect(updateBootstrap({skipManifestCheck: true})).resolves.not.toThrow();
  });
});

describe('updateBootstrap — Step 2 manifest cross-source verification', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetForTest();
    localStorage.setItem('nostra.update.installedVersion', 'test-version');
    localStorage.setItem('nostra.update.installedSwUrl', 'https://app.example.com/sw-abc.js');
    localStorage.setItem('nostra.update.lastAcceptedVersion', 'test-version');
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('writes integrity result to localStorage', async() => {
    mockSWRegistration({activeScriptURL: 'https://app.example.com/sw-abc.js'});
    const mv = await import('@lib/update/manifest-verifier');
    vi.spyOn(mv, 'verifyManifestsAcrossSources').mockResolvedValue({
      verdict: 'offline', sources: [], checkedAt: 12345
    });
    await updateBootstrap();
    expect(localStorage.getItem('nostra.update.lastIntegrityResult')).toBe('offline');
    expect(Number(localStorage.getItem('nostra.update.lastIntegrityCheck'))).toBe(12345);
  });

  // Legacy test removed: `update_available` was the pre-Phase-A event, dispatched
  // on any verified newer version with no consent gate. Phase A moved update
  // notification to `update-popup-controller.runProbeIfDue()` which performs
  // signature verification + downgrade check and dispatches `update_available_signed`.
  // Coverage for that path lives in tests for the controller / probe, not bootstrap.
});

describe('updateBootstrap — Phase 6 post-reload finalization', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetForTest();
    localStorage.setItem('nostra.update.installedVersion', '0.7.0');
    localStorage.setItem('nostra.update.installedSwUrl', 'http://localhost:3000/sw-old.js');
    localStorage.setItem('nostra.update.lastAcceptedVersion', '0.7.0');
    localStorage.setItem('nostra.update.pendingFinalization', '1');
    localStorage.setItem('nostra.update.pendingManifest', JSON.stringify({
      schemaVersion: 1, version: '0.8.0', gitSha: 'xxx', published: 'x',
      swUrl: './sw-new.js', bundleHashes: {'./sw-new.js': 'sha256-y'},
      changelog: ''
    }));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('promotes pending manifest to installed state when active SW matches', async() => {
    mockSWRegistration({activeScriptURL: 'http://localhost:3000/sw-new.js'});

    // Stub location so new URL(manifest.swUrl, location.origin) resolves cleanly
    const savedLocation = (global as any).location;
    (global as any).location = {origin: 'http://localhost:3000'};

    try {
      await updateBootstrap({skipManifestCheck: true});
    } finally {
      (global as any).location = savedLocation;
    }

    expect(localStorage.getItem('nostra.update.installedVersion')).toBe('0.8.0');
    expect(localStorage.getItem('nostra.update.installedSwUrl')).toBe('http://localhost:3000/sw-new.js');
    expect(localStorage.getItem('nostra.update.pendingFinalization')).toBeNull();
    expect(localStorage.getItem('nostra.update.pendingManifest')).toBeNull();
  });
});
