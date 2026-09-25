/*
 * PhantomChat desktop — ring resolution for notify-only installs.
 *
 * Platforms that cannot auto-install (macOS, .deb — see updateCapability.ts)
 * still deserve to know a new version exists. electron-updater is not usable
 * for them: on macOS it refuses outright without a code signature, and we do
 * not publish a macOS feed at all. So we ask the GitHub Releases API the same
 * question the updater would, against the same rings.
 *
 * Ring semantics, identical to the auto path:
 *   stable  — newest release that is NOT a prerelease (what app-promote.yml
 *             produces by flipping a soaked preview build)
 *   preview — newest release of any kind
 *
 * Everything here is pure and fed a plain array, so the ring logic is
 * testable without a network or an Electron runtime.
 */
import type {UpdateChannel} from './updateSettings';

export interface ReleaseSummary {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  html_url?: unknown;
  published_at?: unknown;
}

export interface ResolvedRelease {
  version: string;
  tag: string;
  url: string;
  prerelease: boolean;
}

const TAG_PREFIX = 'phantomchat-v';
/** Strict: three numeric components, nothing else. Anything looser lets a
 *  stray tag in the repo masquerade as a shipped desktop build. */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Extract 1.0.50 from phantomchat-v1.0.50; null for any other tag shape. */
export function versionFromTag(tag: unknown): string | null {
  if(typeof tag !== 'string' || !tag.startsWith(TAG_PREFIX)) return null;
  const version = tag.slice(TAG_PREFIX.length);
  return VERSION_RE.test(version) ? version : null;
}

/**
 * Numeric component compare. Returns >0 when a is newer than b.
 * Deliberately NOT a string compare: '1.0.9' > '1.0.10' lexically, which
 * would strand everyone on an old build the moment the counter crossed a
 * power of ten.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for(let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if(diff !== 0) return diff;
  }
  return 0;
}

/**
 * Newest release in the requested ring. Ordering is by VERSION, not by the
 * API's list order or publish date — a release promoted or re-published
 * later must not be able to present itself as newer than a higher version.
 */
export function pickReleaseForChannel(releases: readonly ReleaseSummary[], channel: UpdateChannel): ResolvedRelease | null {
  let best: ResolvedRelease | null = null;

  for(const release of releases) {
    // A draft is not published to anyone, in either ring.
    if(release.draft === true) continue;

    const version = versionFromTag(release.tag_name);
    if(version === null) continue;

    const prerelease = release.prerelease === true;
    if(channel === 'stable' && prerelease) continue;

    const url = typeof release.html_url === 'string' ? release.html_url : '';
    if(!url) continue;

    if(best === null || compareVersions(version, best.version) > 0) {
      best = {version, tag: release.tag_name as string, url, prerelease};
    }
  }

  return best;
}

/**
 * Should we tell the user about `candidate` given they are running `current`?
 *
 * Strictly-newer only. Equal is a no-op, and OLDER is too: on the notify path
 * we cannot install anything, so nagging a preview user to "update" to a
 * lower stable version they cannot actually apply is pure noise. (The auto
 * path handles that case properly via allowDowngrade — see updater.ts.)
 */
export function isNotifiableUpdate(current: string, candidate: ResolvedRelease | null): boolean {
  if(candidate === null) return false;
  if(!VERSION_RE.test(current)) return false;
  return compareVersions(candidate.version, current) > 0;
}
