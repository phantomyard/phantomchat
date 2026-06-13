import {createSignal} from 'solid-js';
import {render} from 'solid-js/web';
import {UpdateConsent, type UpdateProgress} from './index';
import {acceptUpdate, declineUpdate} from '@lib/update/update-popup-controller';
import type {SignedUpdateResult} from '@lib/update/update-flow';
import {getActiveVersion} from '@lib/serviceWorker/shell-cache';
import I18n from '@lib/langPack';

function formatUpdateError(res: SignedUpdateResult): string {
  const o = res.outcome || 'unknown';
  switch(o) {
    case 'chunk-mismatch':
      return `chunk-mismatch on ${res.chunk}: expected ${shortHash(res.expected)}, got ${shortHash(res.actual)}`;
    case 'network-error':
      return `network-error fetching ${res.chunk}${res.reason ? `: ${res.reason}` : ''}`;
    case 'invalid-signature':
      return 'invalid-signature: manifest signature does not verify against the installed key';
    case 'rotation-cross-cert-invalid':
      return 'rotation-cross-cert-invalid: new key not cross-signed by the installed key';
    case 'quota-exceeded':
      return `quota-exceeded: storage full${res.reason ? ` (${res.reason})` : ''}`;
    case 'swap-failed':
      return `swap-failed${res.reason ? `: ${res.reason}` : ''}`;
    case 'no-active-sw':
      return 'no-active-sw: service worker not yet controlling this page (try reloading)';
    default:
      return res.reason ? `${o}: ${res.reason}` : o;
  }
}

function shortHash(h?: string): string {
  if(!h) return '?';
  // sha256-<64 hex> → sha256-abcd…1234
  const m = h.match(/^(sha256-)([a-f0-9]+)$/);
  if(!m || m[2].length < 12) return h;
  return `${m[1]}${m[2].slice(0, 6)}…${m[2].slice(-4)}`;
}

export function previewUpdateProgress(opts: {total?: number; durationMs?: number} = {}): void {
  const total = opts.total ?? 24;
  const durationMs = opts.durationMs ?? 4000;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center';
  document.body.appendChild(host);
  const [progress, setProgress] = createSignal<UpdateProgress | null>(null);
  const dispose = render(() => (
    <UpdateConsent
      currentVersion='0.0.0'
      newManifest={{
        version: '99.0.0',
        gitSha: 'devdev0deadbeef',
        published: new Date().toISOString(),
        signingKeyFingerprint: 'ed25519:dev-stub',
        rotation: null,
        changelog: '## Preview mode\n- Synthetic progress\n- No service worker'
      }}
      installedFingerprint='ed25519:dev-stub'
      progress={progress()}
      onAccept={async() => {
        const stepMs = Math.max(16, Math.floor(durationMs / total));
        for(let i = 1; i <= total; i++) {
          setProgress({done: i, total});
          await new Promise(r => setTimeout(r, stepMs));
        }
        await new Promise(r => setTimeout(r, 600));
        dispose();
        host.remove();
      }}
      onDecline={() => { dispose(); host.remove(); }}
    />
  ), host);
}

export async function showUpdateConsentPopup(manifest: any, signature: string, manifestText?: string) {
  const active = await getActiveVersion();
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center';
  document.body.appendChild(host);
  const [progress, setProgress] = createSignal<UpdateProgress | null>(null);
  const dispose = render(() => (
    <UpdateConsent
      currentVersion={active?.version ?? 'unknown'}
      newManifest={manifest}
      installedFingerprint={active?.keyFingerprint ?? ''}
      progress={progress()}
      onAccept={async() => {
        const total = Object.keys(manifest?.bundleHashes || {}).length || 1;
        setProgress({done: 0, total});
        const res = await acceptUpdate(manifest, signature, manifestText, {
          onProgress: (done, t) => setProgress({done, total: t || total})
        });
        if(res.ok) {
          setProgress({done: total, total});
          if(confirm(I18n.format('Update.Consent.AppliedReloadPrompt', true))) location.reload();
          dispose();
          host.remove();
        } else {
          setProgress(null);
          console.error('[update] failed', res);
          throw new Error(formatUpdateError(res));
        }
      }}
      onDecline={() => {
        declineUpdate(manifest.version);
        dispose();
        host.remove();
      }}
    />
  ), host);
}
