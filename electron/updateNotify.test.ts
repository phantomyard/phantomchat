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
