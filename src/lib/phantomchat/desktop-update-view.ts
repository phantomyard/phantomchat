/*
 * Presentation logic for the desktop Updates tab (issue #164).
 *
 * Deliberately dependency-free — no DOM, no Electron, no app singletons — so
 * the strings a user reads to decide whether to restart can be tested
 * directly. The tab imports these; nothing here imports the tab.
 */
import type {UpdateChannel, UpdateState} from './desktop-api';

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

/**
 * One Release channel radio now drives BOTH surfaces (owner batch 8): the
 * application channel and the desktop installer ring. This decides what the
 * radio shows and whether it may be touched at all, given whichever surfaces
 * this build actually has.
 *
 * The application channel wins when both exist — it is the surface the user
 * is looking at, and a desktop ring that disagrees must not be advertised as
 * the active one.
 */
export function getChannelChoiceState(sources: {
  application: UpdateChannel | null;
  desktop: UpdateChannel | null;
}): {selected: UpdateChannel; interactive: boolean} {
  return {
    selected: sources.application ?? sources.desktop ?? 'stable',
    interactive: sources.application !== null || sources.desktop !== null
  };
}

export interface ChannelChoiceTargets {
  /** The application channel shell, or null when this build has none. */
  application: {current: UpdateChannel; choose(channel: UpdateChannel): boolean} | null;
  /** The desktop installer ring, or null when this build has no bridge. */
  desktop: {current: UpdateChannel | null; set(channel: UpdateChannel): Promise<UpdateChannel>} | null;
}

export interface ChannelChoiceResult {
  application: UpdateChannel | null;
  desktop: UpdateChannel | null;
  outcome: 'applied' | 'cancelled' | 'desktop-rejected';
}

/**
 * Push one radio choice to every surface this build actually has.
 *
 * The desktop ring goes first: it is a local IPC that completes even though
 * the application side may navigate the page away immediately afterwards.
 * Two failure paths must not leave the control lying:
 *   - the desktop ring rejects the channel → the application side is never
 *     touched, and the outcome says so;
 *   - the user cancels the application switch (Preview asks for a
 *     confirmation) → the desktop ring is rolled back to where it was.
 */
export async function applyChannelChoice(
  targets: ChannelChoiceTargets,
  channel: UpdateChannel
): Promise<ChannelChoiceResult> {
  const previousDesktop = targets.desktop?.current ?? null;
  let desktop = previousDesktop;
  let desktopChanged = false;

  if(targets.desktop && previousDesktop !== channel) {
    try {
      desktop = await targets.desktop.set(channel);
      desktopChanged = desktop !== previousDesktop;
    } catch{
      return {application: targets.application?.current ?? null, desktop, outcome: 'desktop-rejected'};
    }
  }

  if(!targets.application) {
    return {application: null, desktop, outcome: 'applied'};
  }

  if(!targets.application.choose(channel)) {
    if(desktopChanged && targets.desktop) {
      try {
        desktop = await targets.desktop.set(previousDesktop as UpdateChannel);
      } catch{
        // Leaving the ring where it is beats throwing at the user; the
        // outcome still reports the cancellation.
      }
    }
    return {application: targets.application.current, desktop, outcome: 'cancelled'};
  }

  return {application: channel, desktop, outcome: 'applied'};
}
