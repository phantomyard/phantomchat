/*
 * One Release channel radio driving BOTH update surfaces (owner batch 8).
 *
 * Split out of `desktop-update-view.ts` on purpose: `scripts/channels/build.mjs`
 * re-materialises the shared Updates tab into the pinned Stable tree, and Stable
 * predates these helpers — so the file they live in has to be one that does not
 * exist at `stableRef` (the same trick as `lib/folders-sidebar-layout.ts`). It
 * is copied into the Stable tree by the builder, and the compatibility review
 * records it as `stable: "absent"`.
 *
 * Deliberately dependency-free — no DOM, no Electron, no app singletons — so
 * both failure paths are testable without a runtime.
 */
import type {UpdateChannel} from './desktop-api';

/**
 * What the radio shows, and whether it may be touched at all, given whichever
 * surfaces this build actually has.
 *
 * The application channel wins when both exist — it is the surface the user is
 * looking at, and a desktop ring that disagrees must not be advertised as the
 * active one.
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
 *
 * Rollback only happens when there is a known ring to roll back to. Before the
 * first `getUpdateState()` resolves `targets.desktop.current` is `null`, and
 * electron/updater.ts rejects a null channel outright — asking it to would
 * leave the ring on the new channel while the radio snapped back, the exact
 * disagreement this control exists to remove.
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
    if(desktopChanged && previousDesktop && targets.desktop) {
      try {
        desktop = await targets.desktop.set(previousDesktop);
      } catch{
        // Leaving the ring where it is beats throwing at the user; the
        // outcome still reports the cancellation.
      }
    }
    return {application: targets.application.current, desktop, outcome: 'cancelled'};
  }

  return {application: channel, desktop, outcome: 'applied'};
}
