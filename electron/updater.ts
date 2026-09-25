/*
 * PhantomChat desktop — update orchestration (issue #164).
 *
 * Two paths, chosen by platform fact rather than preference
 * (see updateCapability.ts):
 *
 *   'auto'   — electron-updater against the GitHub feed electron-builder
 *              publishes (latest.yml / latest-linux.yml). Downloads in the
 *              background and installs on quit.
 *   'notify' — a plain Releases API query against the same ring; the user is
 *              told, and clicking through opens the release page.
 *
 * The ring preference lives in the main process (updateSettings.ts) because
 * the first check runs before any renderer exists.
 *
 * PROVENANCE: these builds are unsigned. The only thing binding a downloaded
 * update to us is the sha512 in the feed, fetched over TLS from GitHub, and
 * electron-updater verifies it before installing. That is strictly weaker
 * than code signing and is the gap the Axelera Developer ID closes.
 */
import {app, ipcMain, shell, net, type BrowserWindow} from 'electron';
import type {AppUpdater} from 'electron-updater';
import {
  readUpdateSettings,
  writeUpdateSettings,
  updateSettingsPath,
  isUpdateChannel,
  isCheckDue,
  channelUpdaterFlags,
  CHECK_INTERVAL_MS,
  type UpdateChannel,
  type UpdateSettings
} from './updateSettings';
import {resolveUpdateCapability, describeNotifyReason, type UpdateCapability} from './updateCapability';
import {
  pickReleaseForChannel,
  isNotifiableUpdate,
  isReleasePageUrl,
  collectReleasesForChannel,
  RELEASES_PER_PAGE,
  REPO_SLUG,
  type ReleaseSummary,
  type ResolvedRelease
} from './updateFeed';

const RELEASES_API = `https://api.github.com/repos/${REPO_SLUG}/releases`;

/** Delay before the first check so it never competes with window startup. */
const FIRST_CHECK_DELAY_MS = 60_000;

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error';

export interface UpdateState {
  channel: UpdateChannel;
  capability: UpdateCapability;
  /** Why auto-install is unavailable, when capability is 'notify'. */
  capabilityReason: string | null;
  currentVersion: string;
  lastCheckedAt: number | null;
  status: UpdateStatus;
  availableVersion: string | null;
  /** Release page, for the notify path and the "what's new" link. */
  releaseUrl: string | null;
  /** 0-100 while downloading. */
  progressPercent: number | null;
  error: string | null;
}

let settings: UpdateSettings;
let settingsFile: string;
let capability: UpdateCapability;
let capabilityReason: string | null;
let getWindow: () => BrowserWindow | null = () => null;
let timer: NodeJS.Timeout | null = null;
let checkInFlight = false;

let state: UpdateState;

function capabilityInput() {
  return {platform: process.platform, env: process.env, isPackaged: app.isPackaged};
}

function publish(patch: Partial<UpdateState>): void {
  state = {...state, ...patch};
  const window = getWindow();
  // The renderer may not exist yet (first check can beat a slow window) or
  // may be tearing down; both are normal, so never let a send throw into the
  // updater's event handlers.
  if(window && !window.isDestroyed()) {
    try {
      window.webContents.send('desktop:update-state', state);
    } catch {
      // ignore
    }
  }
}

function markChecked(): void {
  settings = {...settings, lastCheckedAt: Date.now()};
  writeUpdateSettings(settingsFile, settings);
  publish({lastCheckedAt: settings.lastCheckedAt});
}

// --- electron-updater (capability 'auto') ------------------------------------

let updaterInstance: AppUpdater | null = null;

/**
 * Loaded lazily and ONLY on the auto path. Importing it eagerly would
 * construct a platform updater (including MacUpdater) on installs that can
 * never use one.
 */
function getUpdater(): AppUpdater {
  if(updaterInstance) return updaterInstance;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {autoUpdater} = require('electron-updater') as typeof import('electron-updater');
  updaterInstance = autoUpdater;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // We publish the installers and the feed, but not the .blockmap files a
  // differential download needs. Leaving it enabled means every update tries
  // a 404'd delta first and falls back — slower, and noisy in the log.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = null;

  applyChannelToUpdater(autoUpdater);

  autoUpdater.on('checking-for-update', () => publish({status: 'checking', error: null}));

  autoUpdater.on('update-available', (info) => {
    // Marked here, not after checkForUpdates() resolves: with autoDownload on,
    // that promise settles only once the DOWNLOAD finishes, so a slow transfer
    // would leave 'Last checked' reporting a stale time for its duration.
    markChecked();
    publish({
      status: 'downloading',
      availableVersion: info.version,
      progressPercent: 0,
      error: null
    });
  });

  autoUpdater.on('update-not-available', () => {
    markChecked();
    publish({status: 'up-to-date', availableVersion: null, progressPercent: null, error: null});
  });

  autoUpdater.on('download-progress', (progress) => {
    publish({status: 'downloading', progressPercent: Math.round(progress.percent)});
  });

  autoUpdater.on('update-downloaded', (info) => {
    publish({status: 'ready', availableVersion: info.version, progressPercent: 100, error: null});
  });

  autoUpdater.on('error', (err: Error) => {
    // A failed check is not fatal and must not surface as a crash: the user
    // keeps running the version they have.
    publish({status: 'error', progressPercent: null, error: err?.message || 'update failed'});
  });

  return autoUpdater;
}

function applyChannelToUpdater(updater: AppUpdater): void {
  const flags = channelUpdaterFlags(settings.channel);
  updater.allowPrerelease = flags.allowPrerelease;
  updater.allowDowngrade = flags.allowDowngrade;
}

// --- GitHub Releases API (capability 'notify') -------------------------------

async function fetchReleasePage(page: number): Promise<ReleaseSummary[]> {
  const response = await net.fetch(`${RELEASES_API}?per_page=${RELEASES_PER_PAGE}&page=${page}`, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': `PhantomChat/${app.getVersion()}`
    }
  });
  if(!response.ok) throw new Error(`GitHub returned ${response.status}`);
  const body: unknown = await response.json();
  if(!Array.isArray(body)) throw new Error('unexpected releases payload');
  return body as ReleaseSummary[];
}

async function checkViaReleasesApi(): Promise<void> {
  publish({status: 'checking', error: null});

  let releases: ReleaseSummary[];
  try {
    releases = await collectReleasesForChannel(settings.channel, fetchReleasePage);
  } catch(err) {
    publish({status: 'error', error: err instanceof Error ? err.message : 'update check failed'});
    return;
  }

  // The API response is untrusted input: pickReleaseForChannel accepts only
  // well-formed phantomchat-v<x.y.z> tags and ignores everything else.
  const picked: ResolvedRelease | null = pickReleaseForChannel(releases, settings.channel);
  markChecked();

  if(isNotifiableUpdate(app.getVersion(), picked)) {
    publish({status: 'available', availableVersion: picked!.version, releaseUrl: picked!.url, error: null});
  } else {
    publish({status: 'up-to-date', availableVersion: null, releaseUrl: null, error: null});
  }
}

// --- shared entry points -----------------------------------------------------

async function runCheck(): Promise<void> {
  // Two checks at once (the launch check racing a user's "Check now") would
  // interleave their state transitions and leave a stale status behind.
  if(checkInFlight) return;
  checkInFlight = true;
  try {
    if(capability === 'auto') {
      const updater = getUpdater();
      applyChannelToUpdater(updater);
      // markChecked() is driven by the updater's own result events.
      await updater.checkForUpdates();
    } else {
      await checkViaReleasesApi();
    }
  } catch(err) {
    publish({status: 'error', error: err instanceof Error ? err.message : 'update check failed'});
  } finally {
    checkInFlight = false;
  }
}

function scheduleChecks(): void {
  if(timer) clearInterval(timer);
  // Persisted lastCheckedAt is what makes this survive sleep: a laptop that
  // is shut at hour 12 and opened at hour 40 checks on open, instead of
  // waiting for an interval tick that never fired.
  const dueNow = isCheckDue(settings.lastCheckedAt, Date.now());
  setTimeout(() => {
    if(dueNow) void runCheck();
  }, FIRST_CHECK_DELAY_MS).unref?.();

  timer = setInterval(() => {
    if(isCheckDue(settings.lastCheckedAt, Date.now())) void runCheck();
  }, 60 * 60 * 1000);
  timer.unref?.();
}

export function initUpdater(resolveWindow: () => BrowserWindow | null): void {
  getWindow = resolveWindow;
  settingsFile = updateSettingsPath(app.getPath('userData'));
  settings = readUpdateSettings(settingsFile);
  capability = resolveUpdateCapability(capabilityInput());
  capabilityReason = capability === 'notify' ? describeNotifyReason(capabilityInput()) : null;

  state = {
    channel: settings.channel,
    capability,
    capabilityReason,
    currentVersion: app.getVersion(),
    lastCheckedAt: settings.lastCheckedAt,
    status: 'idle',
    availableVersion: null,
    releaseUrl: null,
    progressPercent: null,
    error: null
  };

  ipcMain.handle('desktop:update-get-state', () => state);

  ipcMain.handle('desktop:update-set-channel', async(_event, channel: unknown) => {
    // Renderer input is validated here, not trusted: the preload is a
    // convenience, not a security boundary.
    if(!isUpdateChannel(channel)) return state;
    if(channel === settings.channel) return state;

    settings = {...settings, channel, lastCheckedAt: null};
    writeUpdateSettings(settingsFile, settings);
    publish({
      channel,
      lastCheckedAt: null,
      status: 'idle',
      availableVersion: null,
      releaseUrl: null,
      progressPercent: null,
      error: null
    });
    // Switching ring is an explicit act — check immediately rather than
    // leaving the user on the other ring for up to a day.
    await runCheck();
    return state;
  });

  ipcMain.handle('desktop:update-check-now', async() => {
    await runCheck();
    return state;
  });

  ipcMain.handle('desktop:update-install-now', () => {
    if(capability === 'auto' && state.status === 'ready') {
      // isSilent=true, isForceRunAfter=true — relaunch into the new version.
      getUpdater().quitAndInstall(true, true);
      return true;
    }
    // Re-validated at the boundary, not just at parse time: this is the one
    // place a release URL leaves the app for the OS browser.
    if(state.releaseUrl && isReleasePageUrl(state.releaseUrl)) {
      shell.openExternal(state.releaseUrl);
      return true;
    }
    return false;
  });

  scheduleChecks();
}

/** Test/debug seam: the current state without going through IPC. */
export function getUpdateState(): UpdateState {
  return state;
}

export {CHECK_INTERVAL_MS};
