/*
 * PhantomChat desktop — when to raise the update notification.
 *
 * The 24h check already runs (updater.ts / #164); this module only decides
 * whether the result is worth interrupting the user with. Deliberately pure —
 * no Electron, no fs, no clock of its own — so every rule below is testable
 * as a plain function.
 *
 * The rules, in order:
 *   1. There must be something to act on ('available' = we can send you to the
 *      download, 'ready' = downloaded, restart to install). A check that found
 *      nothing, failed, or is still running never interrupts anyone.
 *   2. "Remind me later" silences it until that moment passes — persisted, so
 *      quitting and relaunching does not defeat the snooze.
 *   3. Once the user has acted on a version in THIS session we stop asking
 *      about that version: on the notify ring "Update now" hands them to the
 *      browser and the app keeps running, and re-opening the modal behind them
 *      would be noise. A newer version is a fresh question.
 *
 * Channel-independent by request (2026-11-06): Stable and Preview are both
 * notified, each about its own release feed.
 */
import {CHECK_INTERVAL_MS} from './updateSettings';

/** "Remind me later" means exactly one check interval. */
export const REMIND_LATER_MS = CHECK_INTERVAL_MS;

/** Update states the user can act on; everything else is silent. */
export type NotifiableStatus = 'available' | 'ready';

export interface NotifyState {
  status: string;
  availableVersion: string | null;
}

export interface NotifyPrefs {
  /** From update-settings.json; null when the user never snoozed. */
  remindLaterUntil: number | null;
  /** Newest version the user already acted on in this session, or null. */
  handledVersion: string | null;
}

export function isNotifiableStatus(status: string): status is NotifiableStatus {
  return status === 'available' || status === 'ready';
}

/**
 * Is the notification inside a "Remind me later" window?
 *
 * Also guards the clock: a snooze timestamp further ahead than one interval
 * (a machine whose clock jumped backwards, or a settings file copied between
 * machines) is ignored rather than trusted, otherwise the notification would
 * stay suppressed until real time caught up.
 */
export function isSnoozed(remindLaterUntil: number | null, now: number): boolean {
  if(remindLaterUntil === null || !Number.isFinite(remindLaterUntil)) return false;
  if(remindLaterUntil - now > REMIND_LATER_MS) return false;
  return now < remindLaterUntil;
}

export function shouldNotifyUpdate(
  input: NotifyState,
  prefs: NotifyPrefs,
  now: number = Date.now()
): boolean {
  if(!isNotifiableStatus(input.status)) return false;
  // Nothing to render and nothing to act on without a version.
  if(input.availableVersion === null) return false;
  if(prefs.handledVersion === input.availableVersion) return false;
  return !isSnoozed(prefs.remindLaterUntil, now);
}

/** Where "Remind me later" points: one interval from now. */
export function nextRemindLaterUntil(now: number = Date.now()): number {
  return now + REMIND_LATER_MS;
}

/**
 * How long until a persisted "Remind me later" window closes, or null when
 * there is nothing left to wait for.
 *
 * The check cadence alone cannot keep the 24h promise: the modal is raised by
 * one check and answered whenever the user comes back to it, so the next
 * check is usually still inside the window (suppressed) and the one after
 * that lands up to a full interval later. The caller schedules a re-ask from
 * this value instead, which fires the moment the window closes.
 */
export function snoozeReAskDelayMs(remindLaterUntil: number | null, now: number = Date.now()): number | null {
  // isSnoozed also applies the clock-jump guard: a timestamp further out than
  // one interval is bogus, so it must not arm a timer for days either.
  if(!isSnoozed(remindLaterUntil, now)) return null;
  return (remindLaterUntil as number) - now;
}

/**
 * Statuses that are a decided answer about the feed, as opposed to never having
 * checked in this process ('idle', 'checking') or a check that failed outright
 * ('error'). Only a decided answer can honestly say "nothing to notify about".
 */
export function hasDecidedResult(status: string): boolean {
  return status === 'up-to-date' || status === 'available' || status === 'downloading' || status === 'ready';
}

/**
 * What a fired re-ask timer must do.
 *
 *  - 'wait'    — the window has not actually closed yet. Timers are not
 *                guaranteed to land at or after their instant and Date.now()
 *                truncates to the millisecond, so a fire can arrive inside the
 *                window it was armed for; re-arm with the smaller remainder
 *                instead of publishing a false that nothing ever corrects.
 *  - 'check'   — the window is closed but this process has no decided answer to
 *                notify from (a relaunch resets status to idle while the
 *                persisted lastCheckedAt can suppress the launch check). Asking
 *                the user nothing here would drop the reminder until the next
 *                periodic check, up to a day late, so fetch a fresh result.
 *  - 'publish' — the window is closed and there is a decided answer; publish
 *                notifyPending from it.
 */
export type SnoozeReAskStep = 'wait' | 'check' | 'publish';

export function planSnoozeReAsk(input: NotifyState, prefs: NotifyPrefs, now: number = Date.now()): SnoozeReAskStep {
  if(snoozeReAskDelayMs(prefs.remindLaterUntil, now) !== null) return 'wait';
  if(shouldNotifyUpdate(input, prefs, now)) return 'publish';
  return hasDecidedResult(input.status) ? 'publish' : 'check';
}

/**
 * Did a persisted window close before this launch, so the re-ask is owed now?
 * The clock-jump guard applies: a timestamp further out than one interval is
 * bogus and is not treated as an owed reminder.
 */
export function snoozeClosedBefore(remindLaterUntil: number | null, now: number = Date.now()): boolean {
  if(remindLaterUntil === null || !Number.isFinite(remindLaterUntil)) return false;
  if(remindLaterUntil - now > REMIND_LATER_MS) return false;
  return now >= remindLaterUntil;
}
