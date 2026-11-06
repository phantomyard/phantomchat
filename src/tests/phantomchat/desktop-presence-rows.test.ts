/*
 * The Settings gate for the two desktop presence rows.
 *
 * Owner decision (2026-11-06): a row this PC cannot honour is HIDDEN, not
 * greyed — the same gate covers the PWA (no capability at all). These tests
 * pin the gate so a later refactor cannot quietly show a dead switch.
 */
import {describe, it, expect, afterEach, vi} from 'vitest';
import {
  hasDesktopPresenceApi,
  visiblePresenceRows,
  type PresenceCapability
} from '@lib/phantomchat/desktop-api';

const both: PresenceCapability = {tray: true, autostart: true, trayReason: null, autostartReason: null};
const bareGnome: PresenceCapability = {tray: false, autostart: true, trayReason: 'no owner for org.kde.StatusNotifierWatcher', autostartReason: null};

afterEach(() => {
  delete (window as any).phantomchatDesktop;
});

describe('visiblePresenceRows', () => {
  it('shows both rows where the desktop supports both', () => {
    expect(visiblePresenceRows(both)).toEqual(['startAtLogin', 'closeToTray']);
  });

  it('hides close-to-tray on a desktop with no tray (bare GNOME), keeps autostart', () => {
    expect(visiblePresenceRows(bareGnome)).toEqual(['startAtLogin']);
  });

  it('hides autostart when no login entry can be written', () => {
    expect(visiblePresenceRows({...both, autostart: false})).toEqual(['closeToTray']);
  });

  it('shows nothing in the PWA and on an unprobed desktop', () => {
    expect(visiblePresenceRows(null)).toEqual([]);
    expect(visiblePresenceRows(undefined)).toEqual([]);
    expect(visiblePresenceRows({tray: false, autostart: false, trayReason: 'x', autostartReason: 'y'})).toEqual([]);
  });
});

describe('hasDesktopPresenceApi', () => {
  it('is false in the PWA (no bridge at all)', () => {
    expect(hasDesktopPresenceApi()).toBe(false);
  });

  it('is false on a desktop build packaged before the presence API', () => {
    (window as any).phantomchatDesktop = {getVersion: () => Promise.resolve('1.1.470')};
    expect(hasDesktopPresenceApi()).toBe(false);
  });

  it('is true only with both methods present', () => {
    const presence = {
      getPresence: () => Promise.resolve({settings: both, capability: both, effective: both}),
      setPresence: () => Promise.resolve({settings: both, capability: both, effective: both})
    };
    (window as any).phantomchatDesktop = {getVersion: () => Promise.resolve('1.1.486'), ...presence};
    expect(hasDesktopPresenceApi()).toBe(true);
    (window as any).phantomchatDesktop = {getVersion: () => Promise.resolve('1.1.486'), getPresence: presence.getPresence};
    expect(hasDesktopPresenceApi()).toBe(false);
  });
});
