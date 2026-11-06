/*
 * "Remind me later" — the re-ask, driven through the real updater.
 *
 * The pure rules are covered in updateNotify.test.ts; what those tests cannot
 * see is the cadence: what state the timer fires against, and whether the
 * reminder survives a fire that lands inside the window or a relaunch where the
 * persisted lastCheckedAt suppresses the launch check. Both were review
 * findings on #459, so this file drives initUpdater and the real IPC handlers
 * against a scratch settings file and a stubbed Releases API.
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const harness = vi.hoisted(() => ({
  userData: '',
  releases: [] as unknown[],
  fetchCalls: 0,
  handlers: new Map<string, (...args: any[]) => any>(),
  version: '1.1.100'
}));

vi.mock('electron', () => ({
  app: {
    // Unpackaged ⇒ capability 'notify' ⇒ the Releases API path, which is the
    // one that needs no electron-updater instance.
    isPackaged: false,
    getVersion: () => harness.version,
    getPath: (name: string) => (name === 'userData' ? harness.userData : '/tmp/fake-phantomchat-exe')
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: any[]) => any) => {
      harness.handlers.set(channel, fn);
    }
  },
  shell: {openExternal: () => Promise.resolve()},
  net: {
    fetch: async () => {
      harness.fetchCalls += 1;
      return {ok: true, status: 200, json: async () => harness.releases};
    }
  }
}));

import {initUpdater, getUpdateState} from './updater';
import {updateSettingsPath, writeUpdateSettings} from './updateSettings';
import {REMIND_LATER_MS} from './updateNotify';

function seedSettings(next: {lastCheckedAt: number | null; remindLaterUntil: number | null}): void {
  writeUpdateSettings(updateSettingsPath(harness.userData), {
    channel: 'stable',
    lastCheckedAt: next.lastCheckedAt,
    remindLaterUntil: next.remindLaterUntil
  });
}

function handler(channel: string): (...args: any[]) => any {
  const fn = harness.handlers.get(channel);
  if(!fn) throw new Error(`no handler registered for ${channel}`);
  return fn;
}

beforeEach(() => {
  harness.userData = mkdtempSync(join(tmpdir(), 'pc-update-snooze-'));
  harness.fetchCalls = 0;
  harness.handlers.clear();
  harness.releases = [{
    tag_name: 'phantomchat-v1.1.200',
    html_url: 'https://github.com/phantomyard/phantomchat/releases/tag/phantomchat-v1.1.200',
    draft: false,
    prerelease: false
  }];
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(harness.userData, {recursive: true, force: true});
});

describe('the re-ask survives the two paths review found', () => {
  it('fetches on relaunch when the persisted window already closed', async() => {
    // The launch check is NOT due (lastCheckedAt is an hour old), which is the
    // state in which publishing a false would have dropped the reminder until
    // the next periodic check — up to a day late.
    seedSettings({lastCheckedAt: T0 - HOUR, remindLaterUntil: T0 - 60_000});

    initUpdater(() => null);
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.fetchCalls).toBeGreaterThan(0);
    const state = getUpdateState();
    expect(state.status).toBe('available');
    expect(state.availableVersion).toBe('1.1.200');
    expect(state.notifyPending).toBe(true);
  });

  it('re-arms when the timer fires inside the window it was armed for', async() => {
    seedSettings({lastCheckedAt: T0 - 1000, remindLaterUntil: null});
    initUpdater(() => null);
    await vi.advanceTimersByTimeAsync(0);

    await handler('desktop:update-check-now')();
    expect(getUpdateState().notifyPending).toBe(true);

    handler('desktop:update-remind-later')();
    expect(getUpdateState().notifyPending).toBe(false);
    // From here the reminder must come from the timer, not from a fresh check.
    harness.fetchCalls = 0;

    // Timer jitter: the clock is 60s behind the timer's own schedule, so the
    // fire lands inside the window (17 of 300 windows in the review's probe).
    vi.setSystemTime(Date.now() - 60_000);
    await vi.advanceTimersByTimeAsync(REMIND_LATER_MS);
    expect(getUpdateState().notifyPending).toBe(false);
    expect(harness.fetchCalls).toBe(0); // re-armed, not re-checked

    // The remainder is armed, so the ask still arrives when the window closes.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getUpdateState().notifyPending).toBe(true);
  });

  it('stays quiet through a relaunch inside an open window, then asks when it closes', async() => {
    seedSettings({lastCheckedAt: T0 - 1000, remindLaterUntil: T0 + 10 * 60_000});

    initUpdater(() => null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.fetchCalls).toBe(0);
    expect(getUpdateState().notifyPending).toBe(false);

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    const state = getUpdateState();
    expect(state.status).toBe('available');
    expect(state.notifyPending).toBe(true);
  });
});
