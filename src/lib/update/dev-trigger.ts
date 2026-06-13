// Dev-only helper for simulating the signed-update flow in localhost without
// a mainnet deploy. updateBootstrap() + runProbeIfDue() are guarded by
// import.meta.env.PROD so they never fire during `pnpm start`. This module
// registers the popup controller's listeners AND exposes
// window.__triggerUpdatePopup() that dispatches a fake `update_available_signed`
// (to populate window.__nostraPendingUpdate the same way probe() does) and
// then opens the UpdateConsent popup. Only loaded when import.meta.env.DEV
// is true — no prod footprint.
//
// Caveat: `acceptUpdate()` triggered from the dev popup will fail signature
// verification (the signature is a stub). Use for UI/UX testing only.
import rootScope from '@lib/rootScope';
import type {Manifest} from '@lib/update/types';

export interface TriggerOptions {
  version?: string;
  changelog?: string;
  swUrl?: string;
}

export async function install(): Promise<void> {
  // Ensure the popup controller's listeners are registered — otherwise the
  // dispatched events go nowhere.
  await import('@lib/update/update-popup-controller');

  (window as any).__triggerUpdatePopup = async(opts: TriggerOptions = {}) => {
    const version = opts.version ?? '99.0.0';
    const swUrl = opts.swUrl ?? '/sw.js';
    const manifest = {
      schemaVersion: 1,
      version,
      gitSha: 'devdev0deadbeef',
      published: new Date().toISOString(),
      swUrl,
      bundleHashes: {},
      changelog: opts.changelog ?? '## What\'s new\n- Dev trigger\n- Second item',
      signingKeyFingerprint: 'ed25519:dev-stub',
      rotation: null
    } as Manifest;
    const signature = 'DEV_STUB_SIGNATURE';
    const manifestText = JSON.stringify(manifest);

    // Dispatch the same event probe() emits in prod so the stash listener
    // in update-popup-controller populates window.__nostraPendingUpdate.
    rootScope.dispatchEventSingle('update_available_signed', {manifest, signature, manifestText} as any);

    const {showUpdateConsentPopup} = await import('@components/popups/updateConsent/mount');
    await showUpdateConsentPopup(manifest, signature);

    return {manifest, signature};
  };

  // UI-only progress preview: mounts the popup with a synthetic progress signal that
  // walks 0 → total over `durationMs`. No service worker involvement.
  (window as any).__previewUpdateProgress = async(opts: {total?: number; durationMs?: number} = {}) => {
    const {previewUpdateProgress} = await import('@components/popups/updateConsent/mount');
    previewUpdateProgress(opts);
    console.info('[DEV] preview popup mounted — click "Accept" to watch the synthetic progress bar');
  };

  console.info('[DEV] update popup trigger ready — call __triggerUpdatePopup() or __previewUpdateProgress() from the console');
}
