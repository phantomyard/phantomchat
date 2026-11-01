/*
 * PhantomChat desktop — main process.
 *
 * Security posture (issue #150):
 *  - contextIsolation: true, nodeIntegration: false, sandbox: true
 *  - narrow typed preload API only (see preload.ts)
 *  - the UI runs on the private app:// origin; its files come from the pinned
 *    live PWA origin, with a local copy for offline launches (frontendProxy.ts)
 *  - strict CSP on every app:// response (csp.ts), navigation away from app://
 *    is blocked, window.open is denied and vetted https links are handed to the
 *    OS browser
 */
import {app, BrowserWindow, session, shell, protocol, net, ipcMain, dialog} from 'electron';
import {readFileSync, writeFileSync, renameSync, mkdirSync} from 'fs';
import {join} from 'path';
import {installDesktopEntry, uninstallDesktopEntry} from './desktopIntegration';
import {attachEditableContextMenu} from './contextMenu';
import {APP_SCHEME_PRIVILEGES} from './scheme';
import {createFrontendProxy, ENTRY_PATH, resolveFrontendOrigin} from './frontendProxy';
import {SPLASH_PATH} from './splash';
import {piCliPath, runPiVersion} from './piHarness';
import {
  resolvePermissionRequest,
  isPermissionCheckAllowed,
  parsePermissionSettings,
  defaultPermissionSettings,
  grantAlways,
  PERMISSION_SETTINGS_FILE,
  isPermissionSetting,
  type PermissionSettings
} from './permissions';
import {initUpdater} from './updater';
import {attachWindowDiagnostics, logsDir, startDiagnosticsAfterReady, startDiagnosticsEarly} from './diagnosticsElectron';
import {LOG_FILE_NAME} from './diagnostics';

// NOTE: this module is bundled to CommonJS by electron/build.mjs, so the
// Node globals __dirname/__filename are available at runtime and point at
// the bundled main.cjs location (<asar>/electron/dist). Do not use
// import.meta.url here — it is not defined in CJS output.

// CLI integrations (--install / --uninstall) run headless and exit before
// the app spins up a GUI session.
if(process.argv.includes('--uninstall')) {
  process.exit(uninstallDesktopEntry());
}

if(process.argv.includes('--install')) {
  process.exit(installDesktopEntry());
}

// `phantomchat --log-path` prints where the diagnostics log lives (issue
// #243) so it can be found over SSH without knowing the platform layout.
if(process.argv.includes('--log-path')) {
  process.stdout.write(join(logsDir(), LOG_FILE_NAME) + '\n');
  process.exit(0);
}

// Packaging probe: proves the bundled Pi harness runs on this install.
if(process.argv.includes('--pi-version')) {
  process.exit(runPiVersion(process.execPath, piCliPath(app.isPackaged, process.resourcesPath, __dirname)));
}

// Standard, secure scheme so the renderer gets a proper origin (localStorage,
// crypto.subtle, fetch all behave like the web app). allowServiceWorkers is required: without it
// navigator.serviceWorker.register() rejects on app:// and the SW-backed
// features (media streaming, notifications, the message port) never start.
protocol.registerSchemesAsPrivileged([
  {scheme: 'app', privileges: APP_SCHEME_PRIVILEGES}
]);

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

// Single instance: a second launch focuses the existing window instead of
// forking a second app instance (matches the PWA tab model).
const hasInstanceLock = app.requestSingleInstanceLock();
if(!hasInstanceLock) {
  app.quit();
} else {
  // Freeze/crash logging (issue #243). Must run before 'ready',
  // and only in the primary instance: a second launch must not write into
  // the running instance's log or clear its unclean-exit marker.
  startDiagnosticsEarly();
}

// Permission prompt policy state (issue #215). Lives in userData, same
// contract as the update-ring file: unreadable degrades to defaults.
let permissionSettings: PermissionSettings = defaultPermissionSettings();

function permissionSettingsPath(): string {
  return join(app.getPath('userData'), PERMISSION_SETTINGS_FILE);
}

function loadPermissionSettings(): void {
  try {
    permissionSettings = parsePermissionSettings(JSON.parse(readFileSync(permissionSettingsPath(), 'utf8')));
  } catch{
    permissionSettings = defaultPermissionSettings();
  }
}

function savePermissionSettings(): void {
  const filePath = permissionSettingsPath();
  const tempPath = filePath + '.tmp';
  try {
    mkdirSync(app.getPath('userData'), {recursive: true});
    writeFileSync(tempPath, JSON.stringify(permissionSettings, null, 2));
    renameSync(tempPath, filePath);
  } catch(err) {
    console.error('could not persist permission settings', err);
  }
}

// Human labels for the permission prompt. Unknown permissions fall back to
// the raw Chromium name.
const PERMISSION_LABELS: Record<string, string> = {
  'media': 'use your microphone and camera',
  'clipboard-read': 'read your clipboard',
  'clipboard-sanitized-write': 'copy to your clipboard',
  'notifications': 'show notifications',
  'geolocation': 'know your location',
  'display-capture': 'capture your screen',
  'midi': 'use MIDI devices',
  'midiSysex': 'send full MIDI messages',
  'hid': 'use HID devices',
  'serial': 'use serial devices',
  'usb': 'use USB devices',
  'window-management': 'manage windows',
  // Electron 39 emits the camelCase 'fileSystem' permission identifier
  // (review blocker on #216) — the settings tab's entry must match.
  'fileSystem': 'read and write files',
  'local-fonts': 'see your installed fonts',
  'sensors': 'use motion sensors',
  'idle-detection': 'watch for idle state',
  'persistent-storage': 'keep persistent storage'
};

/**
 * Native permission prompt (issue #215): Electron shows no Chrome permission
 * bubbles, so the request handler pops a real dialog instead. 'Allow' once,
 * 'Always allow' persists to permissions.json, Esc/window-close denies.
 * Prompts are serialized so two simultaneous requests cannot stack dialogs.
 */
let promptChain: Promise<unknown> = Promise.resolve();

function promptForPermission(
  permission: string,
  mediaTypes?: string[]
): Promise<'allow' | 'always' | 'deny'> {
  const ask = async(): Promise<'allow' | 'always' | 'deny'> => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    let what = PERMISSION_LABELS[permission] ?? `access "${permission}"`;
    if(permission === 'media' && mediaTypes?.length) {
      const types = mediaTypes.includes('screen') ? 'your screen'
        : mediaTypes.includes('video') ? 'your camera'
          : mediaTypes.includes('audio') ? 'your microphone' : 'media devices';
      what = `use ${types}`;
    }
    try {
      const {response} = await dialog.showMessageBox(win!, {
        type: 'question',
        message: `phantomchat wants to ${what}`,
        detail: 'You can change this later in Settings → Privacy & Security → Permissions.',
        buttons: ['Allow', 'Always allow', 'Deny'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      });
      return response === 0 ? 'allow' : response === 1 ? 'always' : 'deny';
    } catch(err) {
      console.error('permission prompt failed', err);
      return 'deny';
    }
  };
  const result = promptChain.then(ask, ask);
  promptChain = result.catch(() => 'deny');
  return result;
}

let mainWindow: BrowserWindow | null = null;
let frontend: ReturnType<typeof createFrontendProxy> | undefined;

// IPC surface — keep it in lockstep with the preload allowlist.
ipcMain.handle('desktop:get-version', () => app.getVersion());
ipcMain.handle('desktop:get-platform', () => process.platform);
ipcMain.handle('desktop:open-external', (_event, url: unknown) => {
  if(typeof url === 'string') handOffToBrowser(url);
});

// Permission settings (issue #215): read for the Permissions tab, and
// per-permission overrides ('allow' | 'ask' | 'deny'). Strictly validated —
// the renderer is untrusted input for our own config file.
ipcMain.handle('desktop:get-permission-settings', () => permissionSettings);
// Atomic reset (review blocker on #216): the old renderer-side loop could
// only clear the 14 visible keys, so "Always allow" grants for unlisted
// permissions (midiSysex, idle-detection, a future Electron permission)
// silently survived "Reset to defaults". Main replaces the whole settings
// object in one step instead.
ipcMain.handle('desktop:reset-permission-settings', () => {
  permissionSettings = defaultPermissionSettings();
  savePermissionSettings();
  return permissionSettings;
});
ipcMain.handle('desktop:set-permission-setting', (_event, permission: unknown, setting: unknown) => {
  if(typeof permission !== 'string' || !/^[a-zA-Z-]{1,64}$/.test(permission)) return permissionSettings;
  if(!isPermissionSetting(setting)) return permissionSettings;
  if(setting === 'ask') {
    delete permissionSettings.overrides[permission];
    permissionSettings.granted = permissionSettings.granted.filter((p) => p !== permission);
  } else {
    permissionSettings.overrides[permission] = setting;
    // An override makes any remembered grant from the prompt redundant.
    permissionSettings.granted = permissionSettings.granted.filter((p) => p !== permission);
  }
  savePermissionSettings();
  return permissionSettings;
});

/**
 * Vet a renderer-originated URL. Only well-formed https links may leave the
 * app, and they are handed to the OS browser — never opened in a window.
 */
function handOffToBrowser(url: string): void {
  try {
    const parsed = new URL(url);
    if(parsed.protocol === 'https:' && parsed.hostname) {
      shell.openExternal(parsed.toString());
    }
  } catch {
    // ignore malformed targets
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 420,
    minHeight: 560,
    title: 'PhantomChat',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true
    }
  });

  // Native right-click menu for text fields: spell-check corrections + edit
  // commands. Electron has no default menu; Web K's own DOM menus cover
  // bubbles, the send button and search but not the composer.
  attachEditableContextMenu(mainWindow.webContents);
  attachWindowDiagnostics(mainWindow);

  // Deny all renderer-initiated window creation; https links go to the OS.
  mainWindow.webContents.setWindowOpenHandler(({url}) => {
    handOffToBrowser(url);
    return {action: 'deny'};
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev && !!DEV_URL && url.startsWith(DEV_URL);
    if(!allowed && !url.startsWith('app://')) {
      event.preventDefault();
      handOffToBrowser(url);
    }
  });

  // Permission policy (issue #215): the app's own pages get the local-app
  // contract — promptless clipboard, native Allow / Always allow / Deny
  // prompts for everything else, remembered grants, and settings-tab
  // overrides that win over all of it. Foreign origins are denied outright.
  // Electron 39 requires BOTH handlers — the check handler is not optional
  // (review blocker on #153). Both apply the SAME policy: the request
  // handler is the interactive gate (prompt / remembered grant), and the
  // check handler answers permission queries from the same settings so a
  // denied or un-granted permission is never reported as granted
  // (review blocker on #216).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const req = {
      permission,
      requestingUrl: details.requestingUrl,
      mediaTypes: (details as {mediaTypes?: string[]}).mediaTypes
    };
    const decision = resolvePermissionRequest(req, permissionSettings, isDev ? DEV_URL : undefined);
    if(decision !== 'prompt') {
      callback(decision === 'allow');
      return;
    }
    void promptForPermission(permission, req.mediaTypes).then((choice) => {
      if(choice === 'always') {
        grantAlways(permissionSettings, permission);
        savePermissionSettings();
      }
      callback(choice !== 'deny');
    });
  });
  // The check path mirrors the request policy exactly (review blocker on
  // #216): navigator.permissions.query reports granted only when the
  // effective decision is 'allow', so a deny override or an ungranted,
  // un-promptless permission can never be reported as granted — that is
  // what keeps a denied permission from bypassing its own denial.
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    return isPermissionCheckAllowed({
      permission,
      requestingOrigin,
      requestingUrl: (details as {requestingUrl?: string}).requestingUrl,
      mediaType: (details as {mediaType?: string}).mediaType
    }, permissionSettings, isDev ? DEV_URL : undefined);
  });

  if(isDev) {
    mainWindow.loadURL(DEV_URL!);
  } else {
    mainWindow.loadURL('app://localhost' + (frontend!.hasEntry() ? ENTRY_PATH : SPLASH_PATH));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('second-instance', () => {
  if(mainWindow) {
    if(mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  loadPermissionSettings();
  if(!isDev) {
    frontend = createFrontendProxy({
      origin: resolveFrontendOrigin(app.isPackaged, process.env.PHANTOMCHAT_FRONTEND_ORIGIN),
      cacheDir: join(app.getPath('userData'), 'frontend-cache'),
      fetch: (url, init) => net.fetch(url, init)
    });
    protocol.handle('app', (request) => frontend!.handle(request));
  }
  createWindow();
  startDiagnosticsAfterReady(() => mainWindow);

  // After the window exists: the updater pushes state to it, and a check is
  // deliberately deferred (see FIRST_CHECK_DELAY_MS) so it never competes
  // with startup. Failing to set updates up must not abort the boot — the
  // app is still perfectly usable on its current version.
  try {
    initUpdater(() => mainWindow);
  } catch(err) {
    console.error('updater init failed:', err instanceof Error ? err.message : err);
  }

  app.on('activate', () => {
    if(BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  app.exit(1);
});

app.on('window-all-closed', () => {
  // Desktop convention: quit on all platforms (PhantomChat has no tray).
  app.quit();
});
