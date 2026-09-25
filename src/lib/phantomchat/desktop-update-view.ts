/*
 * Presentation logic for the desktop Updates tab (issue #164).
 *
 * Deliberately dependency-free — no DOM, no Electron, no app singletons — so
 * the strings a user reads to decide whether to restart can be tested
 * directly. The tab imports these; nothing here imports the tab.
 */
import type {UpdateState} from './desktop-api';

/**
 * Status line shown under the version. Pure so it can be tested without a
 * DOM or an Electron runtime.
 */
export function describeUpdateStatus(state: UpdateState): string {
  switch(state.status) {
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return state.progressPercent === null ?
        `Downloading ${state.availableVersion ?? 'update'}…` :
        `Downloading ${state.availableVersion ?? 'update'}… ${state.progressPercent}%`;
    case 'ready':
      return `Version ${state.availableVersion} is ready — restart to finish installing.`;
    case 'available':
      return `Version ${state.availableVersion} is available.`;
    case 'up-to-date':
      return 'PhantomChat is up to date.';
    case 'error':
      // Surfaced, not swallowed: a silently failing updater is how an app
      // sits on an old build for months without anyone noticing.
      return `Could not check for updates: ${state.error ?? 'unknown error'}`;
    default:
      return 'Updates are checked automatically every 24 hours.';
  }
}

export function describeLastChecked(lastCheckedAt: number | null, now = Date.now()): string {
  if(lastCheckedAt === null) return 'Last checked: never';
  const minutes = Math.floor(Math.max(0, now - lastCheckedAt) / 60000);
  if(minutes < 1) return 'Last checked: just now';
  if(minutes < 60) return `Last checked: ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if(hours < 24) return `Last checked: ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `Last checked: ${days} day${days === 1 ? '' : 's'} ago`;
}

/** Is there something for the action button to do, and what is it called? */
export function describeActionButton(state: UpdateState): {label: string, enabled: boolean} | null {
  if(state.status === 'ready') return {label: 'Restart and install', enabled: true};
  if(state.status === 'available') return {label: 'Open release page', enabled: true};
  return null;
}
