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

/** The one place the repo is named; updater.ts builds its API URL from this. */
export const REPO_SLUG = 'phantomyard/phantomchat';
/** Release pages are the ONLY thing this feed may ever hand to the OS browser. */
const RELEASE_URL_HOST = 'github.com';
const RELEASE_URL_PATH_PREFIX = `/${REPO_SLUG}/releases/`;

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
 * Is `url` a release page of THIS repo?
 *
 * html_url arrives as untrusted API JSON and is the value we later pass to
 * shell.openExternal, so it is pinned here rather than merely scheme-checked:
 * https, host exactly github.com, path inside this repo's /releases/. A
 * release that fails this is dropped entirely — there is nothing safe to
 * offer the user for it.
 */
export function isReleasePageUrl(url: unknown): boolean {
  if(typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' &&
    parsed.hostname === RELEASE_URL_HOST &&
    parsed.pathname.startsWith(RELEASE_URL_PATH_PREFIX);
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

    if(!isReleasePageUrl(release.html_url)) continue;
    const url = release.html_url as string;

    if(best === null || compareVersions(version, best.version) > 0) {
      best = {version, tag: release.tag_name as string, url, prerelease};
    }
  }

  return best;
}

/** GitHub's maximum page size. */
export const RELEASES_PER_PAGE = 100;
/**
 * Paging bound. Generous but finite so a pathological repo (or a ring that
 * genuinely has no release at all) cannot spin here.
 */
export const RELEASES_MAX_PAGES = 10;

/**
 * Collect releases, page by page, until the requested ring is represented or
 * the list is exhausted.
 *
 * Why paging at all: a prerelease is cut on EVERY merge to main, so a long
 * preview streak pushes the newest stable release off the first page. With a
 * single fixed page, pickReleaseForChannel(.., 'stable') eventually returns
 * null and a stable install is told it is up to date while a newer stable
 * exists — silently stranded, which is the failure this feature exists to
 * prevent.
 *
 * List position is never trusted as ordering; the winner is still chosen by
 * VERSION across everything fetched. Order only tells us when it is safe to
 * stop asking for older pages.
 *
 * Takes the page fetcher as an argument so the paging rule is testable
 * without a network or an Electron runtime.
 */
export async function collectReleasesForChannel(
  channel: UpdateChannel,
  fetchPage: (page: number) => Promise<ReleaseSummary[]>,
  maxPages: number = RELEASES_MAX_PAGES,
  perPage: number = RELEASES_PER_PAGE
): Promise<ReleaseSummary[]> {
  const collected: ReleaseSummary[] = [];
  for(let page = 1; page <= maxPages; page++) {
    const batch = await fetchPage(page);
    collected.push(...batch);
    // A short page means GitHub has nothing older to give.
    if(batch.length < perPage) break;
    if(pickReleaseForChannel(collected, channel) !== null) break;
  }
  return collected;
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
