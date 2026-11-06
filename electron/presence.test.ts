/*
 * Tray presence: start at login and close to tray.
 *
 * The two properties that matter: a desktop that cannot deliver a feature
 * must fall back to the old behaviour (a visible window, close quits) rather
 * than to an invisible app, and a stored choice must survive a machine that
 * cannot honour it.
 */
import {describe, it, expect, afterEach} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {
  AUTOSTART_FILE,
  DEFAULT_PRESENCE,
  STATUS_NOTIFIER_NAME,
  autostartEntry,
  autostartExec,
  autostartPath,
  autostartTargetPath,
  effectivePresence,
  normalizePresenceSettings,
  presenceSettingsPath,
  probeStatusNotifier,
  readPresenceSettings,
  removeAutostartEntry,
  shouldStartHidden,
  trayIconCandidates,
  trayIconSize,
  trayProbeCandidates,
  writeAutostartEntry,
  writePresenceSettings,
  type PresenceCapability
} from './presence';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-presence-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while(dirs.length) rmSync(dirs.pop()!, {recursive: true, force: true});
});

const both: PresenceCapability = {tray: true, autostart: true, trayReason: null, autostartReason: null};
const none: PresenceCapability = {tray: false, autostart: false, trayReason: 'no', autostartReason: 'no'};

describe('normalizePresenceSettings', () => {
  it('defaults both flags to on', () => {
    expect(DEFAULT_PRESENCE).toEqual({closeToTray: true, startAtLogin: true});
    expect(normalizePresenceSettings(undefined)).toEqual(DEFAULT_PRESENCE);
    expect(normalizePresenceSettings({})).toEqual(DEFAULT_PRESENCE);
  });

  it('keeps one good flag when the other is corrupt', () => {
    expect(normalizePresenceSettings({closeToTray: false, startAtLogin: 'yes'})).toEqual({closeToTray: false, startAtLogin: true});
    expect(normalizePresenceSettings({closeToTray: 0, startAtLogin: false})).toEqual({closeToTray: true, startAtLogin: false});
  });

  it('rejects every non-boolean shape a hostile renderer could send', () => {
    for(const value of ['true', 1, 0, null, [], {}, 'false']) {
      expect(normalizePresenceSettings({closeToTray: value, startAtLogin: value})).toEqual(DEFAULT_PRESENCE);
    }
  });
});

describe('settings persistence', () => {
  it('round-trips through the userData file', () => {
    const file = presenceSettingsPath(scratch());
    writePresenceSettings(file, {closeToTray: false, startAtLogin: true});
    expect(readPresenceSettings(file)).toEqual({closeToTray: false, startAtLogin: true});
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({closeToTray: false, startAtLogin: true});
  });

  it('degrades to defaults on a missing, malformed or truncated file', () => {
    const file = presenceSettingsPath(scratch());
    expect(readPresenceSettings(file)).toEqual(DEFAULT_PRESENCE);
    writeFileSync(file, '{"closeToTray":');
    expect(readPresenceSettings(file)).toEqual(DEFAULT_PRESENCE);
    writeFileSync(file, 'null');
    expect(readPresenceSettings(file)).toEqual(DEFAULT_PRESENCE);
  });

  it('never throws when the target is not writable', () => {
    const dir = scratch();
    const blocked = join(dir, 'file');
    writeFileSync(blocked, 'x');
    // A file where a directory must be: mkdirSync throws, the write is dropped.
    expect(() => writePresenceSettings(join(blocked, 'nested', 'presence.json'), DEFAULT_PRESENCE)).not.toThrow();
  });
});

describe('effectivePresence', () => {
  it('is flag AND capability, so nothing unsupported is ever in force', () => {
    expect(effectivePresence({closeToTray: true, startAtLogin: true}, both)).toEqual({closeToTray: true, startAtLogin: true});
    expect(effectivePresence({closeToTray: true, startAtLogin: true}, none)).toEqual({closeToTray: false, startAtLogin: false});
    expect(effectivePresence({closeToTray: true, startAtLogin: true}, {...none, tray: true})).toEqual({closeToTray: true, startAtLogin: false});
  });

  it('keeps a user choice off when they turned it off', () => {
    expect(effectivePresence({closeToTray: false, startAtLogin: false}, both)).toEqual({closeToTray: false, startAtLogin: false});
  });
});

describe('shouldStartHidden', () => {
  it('honours --hidden when there is a tray', () => {
    expect(shouldStartHidden({argv: ['phantomchat', '--hidden'], platform: 'linux', openedAtLogin: false, capability: both})).toBe(true);
    expect(shouldStartHidden({argv: ['phantomchat'], platform: 'linux', openedAtLogin: false, capability: both})).toBe(false);
  });

  it('never starts hidden without a tray, whatever the arguments say', () => {
    // No tray means no way back to a hidden window: the status quo wins.
    expect(shouldStartHidden({argv: ['phantomchat', '--hidden'], platform: 'linux', openedAtLogin: false, capability: none})).toBe(false);
    expect(shouldStartHidden({argv: ['phantomchat', '--hidden'], platform: 'linux', openedAtLogin: true, capability: {...both, tray: false}})).toBe(false);
  });

  it('uses the OS login-item report on macOS, where args do not travel', () => {
    expect(shouldStartHidden({argv: ['/Applications/PhantomChat'], platform: 'darwin', openedAtLogin: true, capability: both})).toBe(true);
    expect(shouldStartHidden({argv: ['/Applications/PhantomChat'], platform: 'darwin', openedAtLogin: false, capability: both})).toBe(false);
    // wasOpenedAtLogin is meaningless elsewhere, and must not leak in.
    expect(shouldStartHidden({argv: ['phantomchat'], platform: 'win32', openedAtLogin: true, capability: both})).toBe(false);
  });
});

describe('autostart entry', () => {
  it('starts the app in the tray, with the path quoted and escaped', () => {
    const entry = autostartEntry('/opt/Phantom Chat/phantomchat');
    expect(entry).toContain('Exec="/opt/Phantom Chat/phantomchat" --hidden');
    expect(entry).toContain('Type=Application');
    expect(entry).toContain('X-GNOME-Autostart-enabled=true');
    expect(entry.endsWith('\n')).toBe(true);
  });

  it('doubles a literal % so it is never parsed as a field code', () => {
    expect(autostartExec('/opt/100%/phantomchat')).toContain('100%%');
  });

  it('lands in ~/.config/autostart under the app id', () => {
    expect(autostartPath('/home/ana')).toBe(join('/home/ana', '.config/autostart', AUTOSTART_FILE));
  });

  it('writes and removes an entry, creating the folder', () => {
    const file = autostartPath(scratch());
    expect(writeAutostartEntry(file, '/opt/phantomchat')).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('--hidden');
    expect(removeAutostartEntry(file)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(removeAutostartEntry(file)).toBe(true);
  });

  it('reports failure instead of throwing when the folder cannot be created', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'blocked'));
    const blocked = join(dir, 'blocked', 'file');
    writeFileSync(blocked, 'x');
    expect(writeAutostartEntry(join(blocked, 'phantomchat.desktop'), '/opt/phantomchat')).toBe(false);
  });

  it('points an AppImage at the image file, a package at its execPath', () => {
    expect(autostartTargetPath('/home/ana/Apps/PhantomChat.AppImage', '/tmp/.mount_x/phantomchat')).toBe('/home/ana/Apps/PhantomChat.AppImage');
    expect(autostartTargetPath(undefined, '/opt/PhantomChat/phantomchat')).toBe('/opt/PhantomChat/phantomchat');
    expect(autostartTargetPath('', '/opt/PhantomChat/phantomchat')).toBe('/opt/PhantomChat/phantomchat');
  });
});

describe('probeStatusNotifier', () => {
  it('asks GetNameOwner for the StatusNotifier watcher', () => {
    const candidates = trayProbeCandidates();
    expect(candidates.length).toBeGreaterThan(0);
    for(const {args} of candidates) {
      expect(args.join(' ')).toContain(STATUS_NOTIFIER_NAME);
      expect(args.join(' ')).toContain('GetNameOwner');
    }
  });

  it('is present when any tool finds an owner', () => {
    expect(probeStatusNotifier(() => ({status: 0, missing: false})).present).toBe(true);
    // dbus-send missing, gdbus answers: still present.
    const run = (command: string) => command === 'dbus-send' ? {status: null, missing: true} : {status: 0, missing: false};
    expect(probeStatusNotifier(run).present).toBe(true);
  });

  it('is absent when the tools run and nobody owns the name', () => {
    const result = probeStatusNotifier(() => ({status: 1, missing: false}));
    expect(result.present).toBe(false);
    expect(result.detail).toContain('no owner');
  });

  it('is absent, not present, when no probe tool exists at all', () => {
    const result = probeStatusNotifier(() => ({status: null, missing: true}));
    expect(result.present).toBe(false);
    expect(result.detail).toContain('no dbus tool');
  });

  it('keeps probing after a tool fails, so one broken tool cannot hide a tray', () => {
    const seen: string[] = [];
    probeStatusNotifier((command) => {
      seen.push(command);
      return {status: command === 'busctl' ? 0 : 1, missing: false};
    });
    expect(seen).toEqual(trayProbeCandidates().map((candidate) => candidate.command));
  });
});

describe('tray icon helpers', () => {
  it('sizes the image per platform', () => {
    expect(trayIconSize('darwin')).toBe(18);
    expect(trayIconSize('win32')).toBe(16);
    expect(trayIconSize('linux')).toBe(22);
  });

  it('looks for the packaged resource before the build directory', () => {
    const candidates = trayIconCandidates({resourcesPath: '/res', devBuildDir: '/repo/electron/build'});
    expect(candidates[0]).toBe(join('/res', 'icon.png'));
    expect(candidates).toContain(join('/repo/electron/build', 'icon.png'));
  });
});
