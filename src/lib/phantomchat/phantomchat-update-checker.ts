/**
 * PhantomChat update checker + hard cache buster.
 *
 * Two jobs, both aimed at killing the "am I on a stale cached build?" guessing
 * game:
 *
 *  1. Poll the deployed `version` file and, when it differs from the running
 *     build, drop a prominent floating **Update** pill onto the main UI (top
 *     centre, above everything). No more silently running yesterday's bundle.
 *
 *  2. When that pill (or the settings "Update" row) is tapped, do a REAL update:
 *     unregister every service worker and delete every CacheStorage bucket
 *     BEFORE reloading, so the browser can't re-serve the old assets. This is
 *     the sledgehammer the plain `location.reload()` never was.
 *
 * What it never touches: IndexedDB and localStorage — identity, keys, message
 * history all survive. Only the *app shell* cache is nuked.
 */

import App from '@config/app';
import {logger} from '@lib/logger';

const log = logger('PhantomchatUpdate');

// Don't fight the cold-boot network storm — let the app settle first, then poll
// on a relaxed cadence. A stale build is annoying, not an emergency.
const INITIAL_DELAY_MS = 20_000;
const POLL_INTERVAL_MS = 5 * 60_000;

let started = false;
let pill: HTMLButtonElement | null = null;

function currentVersion(): string {
  return App.versionFull || App.version || 'dev';
}

/**
 * Nuke every client-side app-shell cache and reload from the network.
 *
 * Order matters: unregister service workers FIRST (a live SW can re-populate
 * CacheStorage from its own copy), then delete every CacheStorage bucket, then
 * reload. IndexedDB / localStorage are deliberately left intact — this clears
 * the cached *code*, not the user's data.
 *
 * Exported so the settings "Update" row and the floating pill share one code
 * path. Best-effort throughout: a failure in any step still falls through to the
 * reload, because a reload with a partially-cleared cache still beats a stale
 * bundle.
 */
export async function hardReloadClearingCaches(): Promise<void> {
  try {
    if(typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
      log('unregistered', regs.length, 'service worker(s)');
    }
  } catch(err) {
    log.error('service worker unregister failed', err);
  }

  try {
    if(typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
      log('cleared', keys.length, 'cache bucket(s)');
    }
  } catch(err) {
    log.error('cache clear failed', err);
  }

  // With the SW gone and CacheStorage emptied, a normal reload fetches a fresh
  // index.html + bundle from the network.
  location.reload();
}

/**
 * Fetch the deployed `version` marker and compare to the running build. Shows
 * the update pill when they differ. Silent on any network/parse failure — a
 * missed poll just retries on the next interval.
 */
async function checkOnce(): Promise<void> {
  try {
    const res = await fetch('version', {cache: 'no-cache'});
    if(!res.ok) return;
    const latest = (await res.text()).trim();
    if(latest && latest !== currentVersion()) {
      log('newer build available:', latest, '(running', currentVersion() + ')');
      showUpdatePill(latest);
    }
  } catch{
    // offline / blocked / no version file — ignore, retry next tick
  }
}

function showUpdatePill(latest: string): void {
  if(pill || typeof document === 'undefined') return;

  pill = document.createElement('button');
  pill.type = 'button';
  pill.textContent = `⬆ Update ready (${latest}) — tap to reload`;
  pill.title = 'Clears the cached app files and reloads. Your messages and keys are kept.';
  pill.style.cssText = [
    'position:fixed',
    'top:calc(env(safe-area-inset-top, 0px) + 10px)',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:100000',
    'padding:8px 18px',
    'border:none',
    'border-radius:20px',
    'background:#3390ec',
    'color:#fff',
    'font-size:14px',
    'font-weight:500',
    'font-family:inherit',
    'line-height:1.2',
    'box-shadow:0 2px 14px rgba(0,0,0,.35)',
    'cursor:pointer',
    'max-width:92vw',
    'white-space:nowrap',
    'overflow:hidden',
    'text-overflow:ellipsis'
  ].join(';');

  pill.addEventListener('click', () => {
    pill.textContent = 'Updating…';
    pill.disabled = true;
    pill.style.opacity = '0.7';
    void hardReloadClearingCaches();
  });

  document.body.appendChild(pill);
}

/**
 * Start the periodic version poll. Idempotent — safe to call more than once.
 * Runs an initial check after a short delay, then every POLL_INTERVAL_MS.
 */
export function startUpdateChecker(): void {
  if(started) return;
  started = true;
  setTimeout(() => {
    void checkOnce();
    setInterval(() => void checkOnce(), POLL_INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}
