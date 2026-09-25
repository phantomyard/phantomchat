/*
 * PhantomChat desktop — update ring (channel) preference.
 *
 * Stored as a small JSON file in app.getPath('userData'), NOT in the
 * renderer. The updater has to know the ring before the window exists, so
 * localStorage (which lives behind the app:// origin) is too late to be the
 * source of truth.
 *
 * Everything here is deliberately defensive: a hand-edited, truncated or
 * half-written settings file must degrade to the default ring rather than
 * throw during boot. An unreadable preference is never a reason to fail to
 * start a chat client.
 */
import {readFileSync, writeFileSync, renameSync, mkdirSync} from 'fs';
import {dirname, join} from 'path';

/** Stable = /releases/latest. Preview = newest release including prereleases. */
export type UpdateChannel = 'stable' | 'preview';

export const UPDATE_CHANNELS: readonly UpdateChannel[] = ['stable', 'preview'];

/**
 * New installs land on stable. Preview is opt-in: every merge to main cuts a
 * preview build, so defaulting to it would hand unreviewed-in-the-field
 * builds to everyone who never opened settings.
 */
export const DEFAULT_CHANNEL: UpdateChannel = 'stable';

/** 24 hours, as requested in #164. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateSettings {
  channel: UpdateChannel;
  /** Epoch ms of the last completed check, or null if never checked. */
  lastCheckedAt: number | null;
}

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return typeof value === 'string' && (UPDATE_CHANNELS as readonly string[]).includes(value);
}

/**
 * Coerce anything at all into a valid settings object. Unknown fields are
 * dropped, bad fields fall back to their default INDEPENDENTLY — a corrupt
 * lastCheckedAt must not also throw away a deliberately chosen channel.
 */
export function normalizeUpdateSettings(raw: unknown): UpdateSettings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const channel = isUpdateChannel(source.channel) ? source.channel : DEFAULT_CHANNEL;

  const rawLast = source.lastCheckedAt;
  const lastCheckedAt =
    typeof rawLast === 'number' && Number.isFinite(rawLast) && rawLast > 0 ? rawLast : null;

  return {channel, lastCheckedAt};
}

/**
 * The two electron-updater flags a ring maps to.
 *
 * allowDowngrade is the non-obvious half. Leaving preview for stable is a
 * DOWNGRADE in version terms — an installed 1.0.50 preview against a 1.0.45
 * stable — and electron-updater refuses to move backwards by default. Without
 * it, choosing "Stable" looks like it worked and then silently keeps serving
 * preview builds until stable's counter overtakes, which can be weeks.
 */
export interface ChannelUpdaterFlags {
  allowPrerelease: boolean;
  allowDowngrade: boolean;
}

export function channelUpdaterFlags(channel: UpdateChannel): ChannelUpdaterFlags {
  return {
    allowPrerelease: channel === 'preview',
    allowDowngrade: channel === 'stable'
  };
}

export function updateSettingsPath(userDataDir: string): string {
  return join(userDataDir, 'update-settings.json');
}

export function readUpdateSettings(file: string): UpdateSettings {
  try {
    return normalizeUpdateSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // Missing (first run) or malformed — both mean "use the defaults".
    return normalizeUpdateSettings(undefined);
  }
}

/**
 * Write atomically: a crash mid-write must not leave a truncated file that
 * silently resets the user's ring on the next boot. Failures are swallowed —
 * losing the preference is bad, refusing to launch over it is worse.
 */
export function writeUpdateSettings(file: string, settings: UpdateSettings): void {
  try {
    mkdirSync(dirname(file), {recursive: true});
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(normalizeUpdateSettings(settings), null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
  } catch {
    // ignore
  }
}

/**
 * Is a check due? A machine that is asleep at the 24h mark never gets a timer
 * tick, so the schedule alone would mean "checks only while awake, forever".
 * Persisting lastCheckedAt and asking this question at launch turns that into
 * "checks on the first wake after 24h".
 */
export function isCheckDue(lastCheckedAt: number | null, now: number, intervalMs = CHECK_INTERVAL_MS): boolean {
  if(lastCheckedAt === null) return true;
  // A clock that jumped backwards (or a future timestamp copied between
  // machines) would otherwise wedge checks off until real time caught up.
  if(lastCheckedAt > now) return true;
  return now - lastCheckedAt >= intervalMs;
}
