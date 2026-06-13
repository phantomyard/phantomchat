/**
 * Baseline state helpers for the update subsystem.
 *
 * "Baseline" = the set of localStorage keys that updateBootstrap treats as
 * trusted ground-truth on boot (installed version, installed SW URL, last
 * integrity check, pending finalization, etc.). Exposing a snapshot + reset
 * lets the Settings UI show diagnostics and recover from a stuck compromise
 * alert loop on devices that legitimately changed SW URL (e.g. clearing cache,
 * switching origin) without wiping unrelated app state.
 */

const BASELINE_KEYS = [
  'nostra.update.installedVersion',
  'nostra.update.installedSwUrl',
  'nostra.update.lastAcceptedVersion',
  'nostra.update.lastIntegrityCheck',
  'nostra.update.lastIntegrityResult',
  'nostra.update.lastIntegrityDetails',
  'nostra.update.pendingFinalization',
  'nostra.update.pendingManifest'
] as const;

export function resetBaseline(): void {
  for(const k of BASELINE_KEYS) {
    try { localStorage.removeItem(k); } catch{}
  }
}

export interface IntegritySourceDetail {
  name: string;
  status: string;
  version?: string;
  gitSha?: string;
  swUrl?: string;
  error?: string;
}

export interface UpdateStateSnapshot {
  installedVersion: string | null;
  installedSwUrl: string | null;
  lastAcceptedVersion: string | null;
  lastIntegrityCheck: number | null;
  lastIntegrityResult: string | null;
  lastIntegrityDetails: IntegritySourceDetail[] | null;
  pendingFinalization: boolean;
  pendingManifest: {version: string; swUrl: string} | null;
  activeScriptUrl: string | null;
  waitingScriptUrl: string | null;
}

export async function getUpdateStateSnapshot(): Promise<UpdateStateSnapshot> {
  let activeScriptUrl: string | null = null;
  let waitingScriptUrl: string | null = null;
  try {
    if(typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      activeScriptUrl = reg?.active?.scriptURL ?? null;
      waitingScriptUrl = reg?.waiting?.scriptURL ?? null;
    }
  } catch{}

  const lastCheckRaw = localStorage.getItem('nostra.update.lastIntegrityCheck');
  let lastIntegrityDetails: IntegritySourceDetail[] | null = null;
  try {
    const raw = localStorage.getItem('nostra.update.lastIntegrityDetails');
    if(raw) lastIntegrityDetails = JSON.parse(raw);
  } catch{}

  let pendingManifest: UpdateStateSnapshot['pendingManifest'] = null;
  try {
    const raw = localStorage.getItem('nostra.update.pendingManifest');
    if(raw) {
      const m = JSON.parse(raw);
      if(m && typeof m.version === 'string' && typeof m.swUrl === 'string') {
        pendingManifest = {version: m.version, swUrl: m.swUrl};
      }
    }
  } catch{}

  return {
    installedVersion: localStorage.getItem('nostra.update.installedVersion'),
    installedSwUrl: localStorage.getItem('nostra.update.installedSwUrl'),
    lastAcceptedVersion: localStorage.getItem('nostra.update.lastAcceptedVersion'),
    lastIntegrityCheck: lastCheckRaw ? parseInt(lastCheckRaw, 10) : null,
    lastIntegrityResult: localStorage.getItem('nostra.update.lastIntegrityResult'),
    lastIntegrityDetails,
    pendingFinalization: localStorage.getItem('nostra.update.pendingFinalization') === '1',
    pendingManifest,
    activeScriptUrl,
    waitingScriptUrl
  };
}
