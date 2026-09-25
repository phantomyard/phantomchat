/*
 * Desktop update settings — renderer side (issue #164).
 *
 * The tab itself needs a slider and a DOM, so what is tested here is the part
 * that carries the decisions: whether the row appears at all, and the status
 * text a user reads to decide whether to restart.
 */
import {describe, it, expect, afterEach} from 'vitest';
import {readFileSync} from 'fs';
import {resolve} from 'path';
import {getDesktopApi, isDesktopApp, hasDesktopUpdateApi, type UpdateState} from '../../lib/phantomchat/desktop-api';
import {describeUpdateStatus, describeLastChecked, describeActionButton} from '../../lib/phantomchat/desktop-update-view';

const baseState: UpdateState = {
  channel: 'stable',
  capability: 'auto',
  capabilityReason: null,
  currentVersion: '1.0.45',
  lastCheckedAt: null,
  status: 'idle',
  availableVersion: null,
  releaseUrl: null,
  progressPercent: null,
  error: null
};

const state = (patch: Partial<UpdateState>): UpdateState => ({...baseState, ...patch});

afterEach(() => {
  delete (window as any).phantomchatDesktop;
});

describe('desktop bridge detection', () => {
  it('reports web when the bridge is absent', () => {
    expect(getDesktopApi()).toBeNull();
    expect(isDesktopApp()).toBe(false);
    expect(hasDesktopUpdateApi()).toBe(false);
  });

  it('reports desktop when the bridge is present', () => {
    (window as any).phantomchatDesktop = {getUpdateState: () => {}, onUpdateState: () => () => {}};
    expect(isDesktopApp()).toBe(true);
    expect(hasDesktopUpdateApi()).toBe(true);
  });

  it('does NOT claim the update API on a desktop build packaged before #164', () => {
    // The bridge exists (getVersion/openExternal) but the update methods do
    // not. Showing the Updates row there would open a tab that can only
    // throw, so the row must stay hidden.
    (window as any).phantomchatDesktop = {getVersion: () => {}, openExternal: () => {}};
    expect(isDesktopApp()).toBe(true);
    expect(hasDesktopUpdateApi()).toBe(false);
  });

  it('ignores a non-object bridge', () => {
    (window as any).phantomchatDesktop = 'yes';
    expect(getDesktopApi()).toBeNull();
  });
});

describe('describeUpdateStatus', () => {
  it('explains each state in words a user can act on', () => {
    expect(describeUpdateStatus(state({status: 'checking'}))).toMatch(/checking/i);
    expect(describeUpdateStatus(state({status: 'up-to-date'}))).toMatch(/up to date/i);
    expect(describeUpdateStatus(state({status: 'available', availableVersion: '1.0.50'}))).toContain('1.0.50');
    expect(describeUpdateStatus(state({status: 'ready', availableVersion: '1.0.50'}))).toMatch(/restart/i);
  });

  it('shows download progress when there is a percentage', () => {
    expect(describeUpdateStatus(state({status: 'downloading', availableVersion: '1.0.50', progressPercent: 42})))
      .toContain('42%');
  });

  it('still reads sensibly before the first progress event', () => {
    const text = describeUpdateStatus(state({status: 'downloading', availableVersion: '1.0.50', progressPercent: null}));
    expect(text).toContain('1.0.50');
    expect(text).not.toContain('null');
  });

  it('surfaces the error instead of silently claiming everything is fine', () => {
    // A quietly failing updater is how an install sits on an old build for
    // months with nobody noticing.
    const text = describeUpdateStatus(state({status: 'error', error: 'GitHub returned 503'}));
    expect(text).toContain('503');
  });
});

describe('describeLastChecked', () => {
  const now = 1_700_000_000_000;

  it('says never before the first check', () => {
    expect(describeLastChecked(null, now)).toMatch(/never/i);
  });

  it('scales the unit with the age', () => {
    expect(describeLastChecked(now - 10_000, now)).toMatch(/just now/i);
    expect(describeLastChecked(now - 5 * 60_000, now)).toContain('5 minutes ago');
    expect(describeLastChecked(now - 3 * 3_600_000, now)).toContain('3 hours ago');
    expect(describeLastChecked(now - 2 * 86_400_000, now)).toContain('2 days ago');
  });

  it('singularises', () => {
    expect(describeLastChecked(now - 60_000, now)).toContain('1 minute ago');
    expect(describeLastChecked(now - 3_600_000, now)).toContain('1 hour ago');
  });

  it('never renders a negative age from a future timestamp', () => {
    expect(describeLastChecked(now + 3_600_000, now)).toMatch(/just now/i);
  });
});

describe('describeActionButton', () => {
  it('offers a restart once an update is downloaded', () => {
    expect(describeActionButton(state({status: 'ready', availableVersion: '1.0.50'})))
      .toEqual({label: 'Restart and install', enabled: true});
  });

  it('offers the release page on notify-only installs', () => {
    expect(describeActionButton(state({status: 'available', capability: 'notify', releaseUrl: 'https://x'})))
      .toEqual({label: 'Open release page', enabled: true});
  });

  it('offers nothing while idle, checking or up to date', () => {
    for(const status of ['idle', 'checking', 'up-to-date', 'downloading', 'error'] as const) {
      expect(describeActionButton(state({status}))).toBeNull();
    }
  });
});

describe('settings list wiring', () => {
  const settingsSrc = readFileSync(resolve(__dirname, '../../components/sidebarLeft/tabs/settings.ts'), 'utf8');

  it('gates the Updates row on the desktop update API, not merely on the bridge', () => {
    expect(settingsSrc).toContain('hasDesktopUpdateApi()');
  });

  it('loads the tab behind a dynamic import so the PWA never bundles it', () => {
    expect(settingsSrc).toContain("await import('@components/sidebarLeft/tabs/phantomchatDesktopUpdates')");
  });
});
