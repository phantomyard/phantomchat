import {BootGate, CompromiseAlertError} from '@lib/update/types';
import {BUILD_VERSION} from '@lib/update/build-version';
import {ServiceWorkerURL} from '@lib/update/service-worker-url';
import rootScope from '@lib/rootScope';

function resolveBundleSwUrl(): string {
  try {
    return new URL(ServiceWorkerURL as unknown as string, location.origin).href;
  } catch{
    return ServiceWorkerURL as unknown as string;
  }
}

const LS = {
  installedVersion: 'nostra.update.installedVersion',
  installedSwUrl: 'nostra.update.installedSwUrl',
  lastAcceptedVersion: 'nostra.update.lastAcceptedVersion',
  lastIntegrityCheck: 'nostra.update.lastIntegrityCheck',
  lastIntegrityResult: 'nostra.update.lastIntegrityResult',
  lastIntegrityDetails: 'nostra.update.lastIntegrityDetails',
  pendingFinalization: 'nostra.update.pendingFinalization',
  pendingManifest: 'nostra.update.pendingManifest'
};

let _bootGate: BootGate = BootGate.LocalChecksOnly;
let _networkCheckInFlight = false;

export interface BootstrapOptions {
  skipNetworkChecks?: boolean;
  skipManifestCheck?: boolean;
}

function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for(let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = isNaN(pa[i]) ? 0 : (pa[i] ?? 0);
    const y = isNaN(pb[i]) ? 0 : (pb[i] ?? 0);
    if(x > y) return true;
    if(x < y) return false;
  }
  return false;
}

export async function updateBootstrap(opts: BootstrapOptions = {}): Promise<void> {
  // In privacy mode, defer network ops until Tor settles and route through webtor.
  // This prevents the integrity checks from leaking the user's IP to CDN/GitHub/IPFS
  // gateways during the Tor bootstrap window. Intentionally best-effort — if privacy
  // integration modules are absent we fall back gracefully to direct fetch.
  try {
    const isTor = !!(window as any).__nostraTransport ||
      localStorage.getItem('nostra-relay-config')?.includes('privacy');
    if(isTor) {
      try {
        const pt = (window as any).__nostraPrivacyTransport;
        if(pt && typeof pt.getRuntimeState === 'function') {
          // Wait until the transport has reached an active state (tor-active,
          // direct-active, or offline after a failed boot) before firing any
          // update probes. Listens to nostra_tor_state and resolves on first
          // settled value; also resolves immediately if already settled.
          await new Promise<void>((resolve) => {
            const settled = (s: string) => s === 'tor-active' || s === 'direct-active' || s === 'offline';
            const current = pt.getRuntimeState?.();
            if(settled(current)) { resolve(); return; }
            const handler = (e: {state: string}) => {
              if(settled(e.state)) {
                rootScope.removeEventListener('nostra_tor_state', handler);
                resolve();
              }
            };
            rootScope.addEventListener('nostra_tor_state', handler);
          });
        }
        const webtorClient = (window as any).__nostraTransport?.webtorClient ||
          (window as any).__nostraPrivacyTransport?.webtorClient;
        if(webtorClient && typeof webtorClient.fetch === 'function') {
          const {setUpdateTransport} = await import('@lib/update/update-transport');
          setUpdateTransport((url, init) => webtorClient.fetch(url, init));
        }
      } catch(err) {
        console.warn('[UPDATE] privacy integration failed, falling back to direct fetch', err);
      }
    }
  } catch{}

  const reg = await navigator.serviceWorker.ready;

  // Phase 6 post-reload finalization (runs BEFORE Step 0 so pendingFinalization branch is handled on its own terms)
  const pendingFinalization = localStorage.getItem(LS.pendingFinalization) === '1';
  if(pendingFinalization) {
    const pendingManifestRaw = localStorage.getItem(LS.pendingManifest);
    if(pendingManifestRaw) {
      try {
        const pendingManifest = JSON.parse(pendingManifestRaw);
        const expectedSwUrl = new URL(pendingManifest.swUrl, location.origin).href;
        if(reg.active?.scriptURL === expectedSwUrl) {
          localStorage.setItem(LS.installedVersion, pendingManifest.version);
          localStorage.setItem(LS.installedSwUrl, expectedSwUrl);
          localStorage.setItem(LS.lastAcceptedVersion, pendingManifest.version);
          const rs = (await import('@lib/rootScope')).default;
          rs.dispatchEventSingle('update_completed', pendingManifest.version);
        }
      } catch{}
    }
    localStorage.removeItem(LS.pendingFinalization);
    localStorage.removeItem(LS.pendingManifest);
    _bootGate = BootGate.AllVerified;
    return;
  }

  const installedVersion = localStorage.getItem(LS.installedVersion);

  // Coherence check: the version recorded at first install should match the
  // bundle version currently running. A drift means the baseline was reset
  // mid-deploy, or localStorage was edited externally. Warn-only — Step 1a
  // already catches SW URL swaps, this is just observability for version
  // drift scenarios that bypass SW (e.g. rebuild without SW hash change).
  if(installedVersion && installedVersion !== BUILD_VERSION) {
    console.warn('[UPDATE] version drift:', {installed: installedVersion, bundle: BUILD_VERSION});
  }

  // Step 0: first install. Store the URL the *currently running bundle* declares,
  // not `reg.active.scriptURL` — on a pre-Phase-A upgrade the old SW is still
  // active while the new (Phase-A) SW sits in `waiting`. Capturing the active
  // URL here would false-positive Step 1a on the next boot once the waiting SW
  // auto-activates after tab close.
  if(!installedVersion) {
    localStorage.setItem(LS.installedVersion, BUILD_VERSION);
    localStorage.setItem(LS.installedSwUrl, resolveBundleSwUrl());
    localStorage.setItem(LS.lastAcceptedVersion, BUILD_VERSION);
    _bootGate = BootGate.AllVerified;
    return;
  }

  // Step 1a: local URL consistency
  const expectedUrl = localStorage.getItem(LS.installedSwUrl)!;
  if(reg.active!.scriptURL !== expectedUrl) {
    throw new CompromiseAlertError({type: 'sw-url-changed', expected: expectedUrl, got: reg.active!.scriptURL});
  }

  // Step 1a.5: no unexpected waiting SW. A waiting worker outside a legitimate
  // update flow means something (bundle or CDN) queued a SW swap without user
  // consent — treat it as compromise. `apiManagerProxy` only registers the
  // already-installed SW URL in steady state, so no waiting SW should exist.
  const pendingFinalizationActive = localStorage.getItem(LS.pendingFinalization) === '1';
  if(reg.waiting && !pendingFinalizationActive) {
    throw new CompromiseAlertError({
      type: 'unexpected-waiting-sw',
      waitingUrl: reg.waiting.scriptURL
    });
  }

  _bootGate = BootGate.LocalChecksOnly;

  if(opts.skipNetworkChecks) {
    _bootGate = BootGate.AllVerified;
    return;
  }

  // Step 1b: registration.update() byte comparison
  const waitingBefore = reg.waiting;
  try {
    // DO NOT call reg.update() here. Automatic SW revalidation triggers the
    // browser to re-download sw.js, potentially serving MITM content into the
    // waiting slot. Update checks are now explicit via probe().
    // Previous code: await reg.update();
  } catch{
    _bootGate = BootGate.AllVerified;
    return;
  }
  const waitingAfter = reg.waiting;
  if(waitingAfter && waitingAfter !== waitingBefore) {
    throw new CompromiseAlertError({
      type: 'sw-body-changed-at-same-url',
      url: reg.active?.scriptURL,
      waitingUrl: waitingAfter.scriptURL
    });
  }

  if(opts.skipManifestCheck) {
    _bootGate = BootGate.AllVerified;
    return;
  }

  // Step 2: manifest cross-source verification
  const {verifyManifestsAcrossSources} = await import('@lib/update/manifest-verifier');
  const result = await verifyManifestsAcrossSources();

  localStorage.setItem(LS.lastIntegrityCheck, String(result.checkedAt));
  localStorage.setItem(LS.lastIntegrityResult, result.verdict);
  localStorage.setItem(LS.lastIntegrityDetails, JSON.stringify(result.sources));

  _bootGate = BootGate.AllVerified;

  const rs = (await import('@lib/rootScope')).default;
  rs.dispatchEventSingle('update_integrity_check_completed', result);
  // Note: `update_available` was the pre-Phase-A event. Phase A wires the
  // signed-manifest probe in `update-popup-controller.runProbeIfDue()` which
  // dispatches `update_available_signed` (consent-gated) instead.
}

export async function runNetworkChecks(opts: {force?: boolean} = {}): Promise<void> {
  if(_networkCheckInFlight) return;
  if(!opts.force && _bootGate === BootGate.AllVerified) {
    // Allow forced re-run from the Settings panel even when already verified
  }

  _networkCheckInFlight = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const waitingBefore = reg.waiting;
    try { await reg.update(); } catch{}
    const waitingAfter = reg.waiting;
    const expectingUpdate = localStorage.getItem(LS.pendingFinalization) === '1';
    if(waitingAfter && waitingAfter !== waitingBefore && !expectingUpdate) {
      throw new CompromiseAlertError({
        type: 'sw-body-changed-at-same-url',
        url: reg.active?.scriptURL,
        waitingUrl: waitingAfter.scriptURL
      });
    }

    const {verifyManifestsAcrossSources} = await import('@lib/update/manifest-verifier');
    const result = await verifyManifestsAcrossSources();

    localStorage.setItem(LS.lastIntegrityCheck, String(result.checkedAt));
    localStorage.setItem(LS.lastIntegrityResult, result.verdict);
    localStorage.setItem(LS.lastIntegrityDetails, JSON.stringify(result.sources));

    const rs = (await import('@lib/rootScope')).default;
    rs.dispatchEventSingle('update_integrity_check_completed', result);
    // See note in `updateBootstrap()` above — `update_available` was the
    // legacy event; Phase A uses `update_available_signed` via the probe.

    _bootGate = BootGate.AllVerified;
  } finally {
    _networkCheckInFlight = false;
  }
}

export function getBootGate(): BootGate {
  return _bootGate;
}

export function assertBootGateOpen(): void {
  if(_bootGate !== BootGate.AllVerified) {
    throw new Error('updateBootstrap not complete — network-dependent operations forbidden');
  }
}

export function __resetForTest(): void {
  _bootGate = BootGate.LocalChecksOnly;
  _networkCheckInFlight = false;
}

/**
 * Migration shim for users upgrading from pre-consent-gate versions.
 * If shell-v* caches exist but no active-version record in IDB (fresh SW
 * install before T8's setActiveVersion hook ran), derive active from the
 * newest shell-v cache. Non-destructive: on any error, logs and returns.
 */
export async function ensureMigrated(): Promise<void> {
  if(typeof caches === 'undefined' || typeof indexedDB === 'undefined') return;
  try {
    const {getActiveVersion, setActiveVersion} = await import('@lib/serviceWorker/shell-cache');
    const active = await getActiveVersion();
    if(active) return;
    const keys = await caches.keys();
    const shellCaches = keys.filter((k) => k.startsWith('shell-v') && !k.endsWith('-pending'));
    if(shellCaches.length === 0) return;
    const latest = shellCaches.map((k) => k.slice('shell-v'.length)).sort().pop();
    if(latest) await setActiveVersion(latest, 'ed25519:migrated');
  } catch(e) {
    console.warn('[update] migration check failed', e);
  }
}

// Retry on reconnect
if(typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    runNetworkChecks().catch(err => {
      console.warn('[UPDATE] retry on online failed:', err);
    });
  });
}
