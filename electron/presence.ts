/*
 * PhantomChat desktop — tray presence: start at login, close to tray.
 *
 * Two user preferences, both ON by default (owner decision, 2026-11-06):
 * the window closes to the tray instead of quitting, and a login entry starts
 * the app hidden in that tray.
 *
 * They are only real where the platform can deliver them, so every surface
 * asks the same question — `effectivePresence()` — which is
 * `user flag && capability`:
 *
 *  - Tray. macOS (menu bar) and Windows (notification area) always have one.
 *    On Linux Electron's tray is a StatusNotifierItem, which needs a watcher
 *    on the session bus: Plasma has one, stock Ubuntu Desktop has one because
 *    the appindicator extension ships enabled, bare GNOME has none. Probe it,
 *    don't guess from an env var.
 *  - Login entry. macOS and Windows have an Electron API. Linux has none:
 *    the entry is `~/.config/autostart/phantomchat.desktop`, which rpm, deb
 *    and AppImage can all write (a snap could not, and we don't ship one).
 *
 * A missing capability degrades to the status quo — no tray, close quits —
 * never to an invisible app with no way back. The stored flag is kept either
 * way, so a user who enabled close-to-tray under Plasma and later logs into
 * bare GNOME gets a normal window, then their tray back on Plasma.
 */
import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'fs';
import {dirname, join} from 'path';
import {execTokenForDesktopEntry} from './desktopIntegration';

export interface PresenceSettings {
  closeToTray: boolean;
  startAtLogin: boolean;
}

/** Both on by default; capability decides whether either actually applies. */
export const DEFAULT_PRESENCE: PresenceSettings = {closeToTray: true, startAtLogin: true};

export const PRESENCE_FILE = 'presence-settings.json';
export const AUTOSTART_FILE = 'phantomchat.desktop';

/** The freedesktop tray name every StatusNotifier host owns. */
export const STATUS_NOTIFIER_NAME = 'org.kde.StatusNotifierWatcher';

export interface PresenceCapability {
  tray: boolean;
  autostart: boolean;
  /** Why a capability is missing: shown in the log, useful in bug reports. */
  trayReason: string | null;
  autostartReason: string | null;
}

/**
 * Coerce anything at all into a settings object. Unknown fields are dropped
 * and bad fields fall back independently — a corrupt closeToTray must not
 * also throw away a deliberate startAtLogin.
 */
export function normalizePresenceSettings(raw: unknown): PresenceSettings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    closeToTray: typeof source.closeToTray === 'boolean' ? source.closeToTray : DEFAULT_PRESENCE.closeToTray,
    startAtLogin: typeof source.startAtLogin === 'boolean' ? source.startAtLogin : DEFAULT_PRESENCE.startAtLogin
  };
}

export function presenceSettingsPath(userDataDir: string): string {
  return join(userDataDir, PRESENCE_FILE);
}

export function readPresenceSettings(file: string): PresenceSettings {
  try {
    return normalizePresenceSettings(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // Missing (first run) or malformed — both mean "use the defaults".
    return normalizePresenceSettings(undefined);
  }
}

/**
 * Write atomically: a crash mid-write must not leave a truncated file that
 * silently resets the user's choice. Losing the preference is bad, refusing
 * to start over it is worse, so failures are swallowed.
 */
export function writePresenceSettings(file: string, settings: PresenceSettings): void {
  try {
    mkdirSync(dirname(file), {recursive: true});
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(normalizePresenceSettings(settings), null, 2) + '\n', 'utf8');
    renameSync(tmp, file);
  } catch {
    // ignore
  }
}

/** What the platform can actually do, given what the user asked for. */
export function effectivePresence(settings: PresenceSettings, capability: PresenceCapability): PresenceSettings {
  return {
    closeToTray: settings.closeToTray && capability.tray,
    startAtLogin: settings.startAtLogin && capability.autostart
  };
}

/**
 * Should this launch stay in the tray? Only when there is a tray to stay in:
 * without one the window is the only way back, so an unsupported desktop
 * always gets a visible window (the status quo).
 *
 * Rename: `--hidden` is what the login entry passes on Windows and Linux.
 * macOS login items carry no arguments, so the OS reports it instead.
 */
export function shouldStartHidden(opts: {
  argv: readonly string[];
  platform: NodeJS.Platform;
  openedAtLogin: boolean;
  capability: PresenceCapability;
}): boolean {
  if(!opts.capability.tray) return false;
  if(opts.argv.includes('--hidden')) return true;
  return opts.platform === 'darwin' && opts.openedAtLogin;
}

/**
 * The path a login entry must point at. An AppImage runs from a temporary
 * mount but the .AppImage file itself is stable, so prefer $APPIMAGE there;
 * a deb/rpm install runs from its own execPath anyway.
 */
export function autostartTargetPath(appImage: string | undefined, execPath: string): string {
  return appImage ? appImage : execPath;
}

export function autostartPath(home: string): string {
  return join(home, '.config', 'autostart', AUTOSTART_FILE);
}

/** The Exec line: the app path plus the flag that keeps it in the tray. */
export function autostartExec(execPath: string): string {
  return `${execTokenForDesktopEntry(execPath)} --hidden`;
}

export function autostartEntry(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=PhantomChat',
    'Comment=Privacy-first messaging with end-to-end encryption',
    `Exec=${autostartExec(execPath)}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'StartupWMClass=PhantomChat'
  ].join('\n') + '\n';
}

export function writeAutostartEntry(file: string, execPath: string): boolean {
  try {
    mkdirSync(dirname(file), {recursive: true});
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, autostartEntry(execPath), {mode: 0o644});
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function removeAutostartEntry(file: string): boolean {
  try {
    rmSync(file, {force: true});
    return true;
  } catch {
    return false;
  }
}

export type ProbeRunner = (command: string, args: string[]) => {status: number | null; missing: boolean};

/**
 * Three ways to ask the session bus whether anything owns the StatusNotifier
 * watcher name. Tools are tried in order because none of them is guaranteed
 * on a minimal install: dbus-send (dbus), gdbus (glib2, present with GNOME)
 * and busctl (systemd).
 */
export function trayProbeCandidates(): {command: string; args: string[]}[] {
  const name = STATUS_NOTIFIER_NAME;
  return [
    {
      command: 'dbus-send',
      args: ['--session', '--dest=org.freedesktop.DBus', '--type=method_call', '--print-reply', '/org/freedesktop/DBus', 'org.freedesktop.DBus.GetNameOwner', `string:${name}`]
    },
    {
      command: 'gdbus',
      args: ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.GetNameOwner', name]
    },
    {
      command: 'busctl',
      args: ['--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner', 's', name]
    }
  ];
}

/**
 * A successful GetNameOwner means a tray host is running — that is the whole
 * capability test. No tool available is reported as absent, which degrades to
 * the status quo rather than to a window that can vanish.
 */
export function probeStatusNotifier(run: ProbeRunner): {present: boolean; detail: string} {
  let sawTool = false;
  for(const {command, args} of trayProbeCandidates()) {
    const result = run(command, args);
    if(result.missing) continue;
    sawTool = true;
    if(result.status === 0) return {present: true, detail: `${command}: ${STATUS_NOTIFIER_NAME} has an owner`};
  }
  return {
    present: false,
    detail: sawTool ? `no owner for ${STATUS_NOTIFIER_NAME}` : `no dbus tool available to probe ${STATUS_NOTIFIER_NAME}`
  };
}

/** Pixel size of the tray image per platform (menu bar, notification area). */
export function trayIconSize(platform: NodeJS.Platform): number {
  if(platform === 'darwin') return 18;
  if(platform === 'win32') return 16;
  return 22;
}

/**
 * Where the tray image can live: the packaged extraResource first, then the
 * build directory for an unpackaged run.
 */
export function trayIconCandidates(opts: {resourcesPath: string; devBuildDir: string}): string[] {
  return [
    join(opts.resourcesPath || '', 'icon.png'),
    join(opts.devBuildDir || '', 'icon.png'),
    join(opts.resourcesPath || '', 'phantomchat.png')
  ].filter((path) => path.length > 0);
}
