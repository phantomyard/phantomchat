/*
 * The update notification's decision rules. Every case here is a user-visible
 * promise: a failing check must not interrupt anyone, "Remind me later" must
 * mean 24h (even across a restart), and neither ring is special-cased.
 */
import {describe, it, expect} from 'vitest';
import {
  REMIND_LATER_MS,
  isNotifiableStatus,
  isSnoozed,
  shouldNotifyUpdate,
  nextRemindLaterUntil,
  snoozeReAskDelayMs,
  planSnoozeReAsk,
  snoozeClosedBefore,
  hasDecidedResult,
  type NotifyPrefs
} from './updateNotify';
import {CHECK_INTERVAL_MS} from './updateSettings';

const now = 1_700_000_000_000;
const noPrefs: NotifyPrefs = {remindLaterUntil: null, handledVersion: null};
const state = (status: string, availableVersion: string | null = '1.1.120') => ({status, availableVersion});

describe('isNotifiableStatus', () => {
  it('interrupts only when there is something to act on', () => {
    expect(isNotifiableStatus('available')).toBe(true);
    expect(isNotifiableStatus('ready')).toBe(true);
    for(const status of ['idle', 'checking', 'up-to-date', 'downloading', 'error', 'nonsense']) {
      expect(isNotifiableStatus(status)).toBe(false);
    }
  });
});

describe('isSnoozed', () => {
  it('is quiet before the remind time and loud from it onwards', () => {
    expect(isSnoozed(now + 1, now)).toBe(true);
    expect(isSnoozed(now, now)).toBe(false);
    expect(isSnoozed(now - 1, now)).toBe(false);
  });

  it('treats no snooze as not snoozed', () => {
    expect(isSnoozed(null, now)).toBe(false);
    expect(isSnoozed(NaN, now)).toBe(false);
  });

  it('ignores a snooze further out than one interval (clock jumped back)', () => {
    // A settings file copied from a machine running ahead, or a clock that
    // moved backwards, must not wedge the notification off for days.
    expect(isSnoozed(now + REMIND_LATER_MS + 1, now)).toBe(false);
    expect(isSnoozed(now + REMIND_LATER_MS, now)).toBe(true);
  });
});

describe('shouldNotifyUpdate', () => {
  it('raises the modal for an actionable update', () => {
    expect(shouldNotifyUpdate(state('available'), noPrefs, now)).toBe(true);
    expect(shouldNotifyUpdate(state('ready'), noPrefs, now)).toBe(true);
  });

  it('stays silent while checking, downloading after a failure, or up to date', () => {
    for(const status of ['idle', 'checking', 'downloading', 'up-to-date', 'error']) {
      expect(shouldNotifyUpdate(state(status, status === 'up-to-date' ? null : '1.1.120'), noPrefs, now)).toBe(false);
    }
  });

  it('honours "Remind me later" for exactly 24h, then asks again', () => {
    const snoozed: NotifyPrefs = {remindLaterUntil: nextRemindLaterUntil(now), handledVersion: null};
    expect(REMIND_LATER_MS).toBe(CHECK_INTERVAL_MS);
    expect(REMIND_LATER_MS).toBe(24 * 60 * 60 * 1000);
    expect(shouldNotifyUpdate(state('ready'), snoozed, now)).toBe(false);
    expect(shouldNotifyUpdate(state('ready'), snoozed, now + REMIND_LATER_MS - 1)).toBe(false);
    expect(shouldNotifyUpdate(state('ready'), snoozed, now + REMIND_LATER_MS)).toBe(true);
  });

  it('does not repeat itself for a version the user already acted on', () => {
    const handled: NotifyPrefs = {remindLaterUntil: null, handledVersion: '1.1.120'};
    expect(shouldNotifyUpdate(state('ready', '1.1.120'), handled, now)).toBe(false);
    // A newer build is a fresh question.
    expect(shouldNotifyUpdate(state('ready', '1.1.121'), handled, now)).toBe(true);
  });

  it('has no channel gate: Stable and Preview are both notified', () => {
    // The decision input carries no channel at all — this asserts the shape
    // stays that way, since notifying Preview too is the requirement.
    expect(Object.keys(state('ready')).sort()).toEqual(['availableVersion', 'status']);
    expect(shouldNotifyUpdate(state('ready'), noPrefs, now)).toBe(true);
  });

  it('never notifies without a version to show', () => {
    expect(shouldNotifyUpdate(state('ready', null), noPrefs, now)).toBe(false);
    expect(shouldNotifyUpdate(state('available', null), noPrefs, now)).toBe(false);
  });
});

describe('snoozeReAskDelayMs', () => {
  it('re-asks when the window closes, not at the check that follows it', () => {
    // The ordinary case: the launch check raises the modal at T, the user
    // answers it at T+30min. The next check is T+24h10m — still inside the
    // window, so the check cadence alone would delay the re-ask to T+48h10m.
    const answeredAt = now + 30 * 60 * 1000;
    const until = nextRemindLaterUntil(answeredAt);
    const snoozed: NotifyPrefs = {remindLaterUntil: until, handledVersion: null};
    const nextCheck = now + CHECK_INTERVAL_MS + 10 * 60 * 1000;

    expect(shouldNotifyUpdate(state('available'), snoozed, nextCheck)).toBe(false);
    //...so the re-ask has to be scheduled off the window itself, from the
    // moment the snooze was written.
    expect(snoozeReAskDelayMs(until, answeredAt)).toBe(REMIND_LATER_MS);
    // And at that moment the notification is due again.
    expect(shouldNotifyUpdate(state('available'), snoozed, until)).toBe(true);
  });

  it('has nothing to schedule when no window is open', () => {
    expect(snoozeReAskDelayMs(null, now)).toBeNull();
    expect(snoozeReAskDelayMs(NaN, now)).toBeNull();
    expect(snoozeReAskDelayMs(now, now)).toBeNull();
    expect(snoozeReAskDelayMs(now - 1, now)).toBeNull();
    // The clock-jump guard applies here too: a bogus far-future timestamp must
    // not arm a timer for days.
    expect(snoozeReAskDelayMs(now + REMIND_LATER_MS + 1, now)).toBeNull();
    expect(snoozeReAskDelayMs(now + REMIND_LATER_MS, now)).toBe(REMIND_LATER_MS);
  });
});

describe('planSnoozeReAsk', () => {
  const snoozed: NotifyPrefs = {remindLaterUntil: now + 60_000, handledVersion: null};

  it('waits while the window is still open, even if the timer already fired', () => {
    // Timers are not guaranteed to land at or after their instant, and
    // Date.now() truncates, so a fire can arrive inside the window it was armed
    // for. Publishing a false there would drop the ask silently.
    expect(planSnoozeReAsk(state('available'), snoozed, now)).toBe('wait');
    expect(planSnoozeReAsk(state('available'), snoozed, now + 59_999)).toBe('wait');
  });

  it('publishes once the window has closed and the result is decided', () => {
    const closed = now + REMIND_LATER_MS;
    const prefs: NotifyPrefs = {remindLaterUntil: closed, handledVersion: null};
    expect(planSnoozeReAsk(state('available'), prefs, closed)).toBe('publish');
    // A decided "nothing to say" is also a publish: the up-to-date result needs
    // no fetch to be believed.
    expect(planSnoozeReAsk(state('up-to-date', null), prefs, closed)).toBe('publish');
    // Already acted on this version ⇒ quiet, and no check is needed to know it.
    expect(planSnoozeReAsk(state('available'), {remindLaterUntil: closed, handledVersion: '1.1.120'}, closed))
      .toBe('publish');
  });

  it('fetches when the window has closed with no result to notify from', () => {
    const closed = now + REMIND_LATER_MS;
    const prefs: NotifyPrefs = {remindLaterUntil: closed, handledVersion: null};
    // A relaunch resets status to idle with no availableVersion, and the
    // persisted lastCheckedAt can suppress the launch check — publishing a
    // false would delay the reminder by up to a day.
    expect(planSnoozeReAsk(state('idle', null), prefs, closed)).toBe('check');
    expect(planSnoozeReAsk(state('checking', null), prefs, closed)).toBe('check');
    // A failed check is not an answer either: nobody knows whether an update
    // exists, so re-validate rather than stay silent.
    expect(planSnoozeReAsk(state('error', null), prefs, closed)).toBe('check');
  });

  it('treats a bogus far-future window as nothing to wait for', () => {
    const bogus: NotifyPrefs = {remindLaterUntil: now + REMIND_LATER_MS + 1, handledVersion: null};
    expect(planSnoozeReAsk(state('available'), bogus, now)).toBe('publish');
  });
});

describe('snoozeClosedBefore', () => {
  it('reports a window that closed while the app was not running', () => {
    expect(snoozeClosedBefore(now - 1, now)).toBe(true);
    expect(snoozeClosedBefore(now, now)).toBe(true);
    expect(snoozeClosedBefore(now + 1, now)).toBe(false);
    expect(snoozeClosedBefore(null, now)).toBe(false);
    expect(snoozeClosedBefore(NaN, now)).toBe(false);
    // Bogus timestamps follow the clock-jump guard: not an owed reminder.
    expect(snoozeClosedBefore(now + REMIND_LATER_MS + 1, now)).toBe(false);
  });
});

describe('hasDecidedResult', () => {
  it('separates a decided answer from the absence of one', () => {
    expect(hasDecidedResult('up-to-date')).toBe(true);
    expect(hasDecidedResult('available')).toBe(true);
    expect(hasDecidedResult('downloading')).toBe(true);
    expect(hasDecidedResult('ready')).toBe(true);
    for(const undecided of ['idle', 'checking', 'error']) {
      expect(hasDecidedResult(undecided)).toBe(false);
    }
  });
});
