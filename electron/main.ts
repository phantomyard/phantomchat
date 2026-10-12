/*
 * PhantomChat desktop — main process.
 *
 * Security posture (issue #150):
 *  - contextIsolation: true, nodeIntegration: false, sandbox: true
 *  - narrow typed preload API only (see preload.ts)
 *  - production UI is loaded from the packaged bundle via the app:// protocol —
 *    never from a remote origin
 *  - strict CSP (build-time computed hashes for the boot-splash inline script,
 *    see build.mjs), navigation away from app:// is blocked, window.open is
 *    denied and vetted https links are handed to the OS browser
 */
import {app, BrowserWindow, session, shell, protocol, net, ipcMain, dialog} from 'electron';
import {readFileSync, writeFileSync, renameSync, mkdirSync, existsSync} from 'fs';
import {join, normalize, relative, isAbsolute, extname} from 'path';
import {installDesktopEntry, uninstallDesktopEntry} from './desktopIntegration';
import {APP_SCHEME_PRIVILEGES} from './scheme';
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

// Standard, secure scheme so the renderer gets a proper origin (localStorage,
// crypto.subtle, fetch all behave like the web app) while still serving the
// immutable packaged bundle. allowServiceWorkers is required: without it
// navigator.serviceWorker.register() rejects on app:// and the SW-backed
// features (media streaming, notifications, the message port) never start.
protocol.registerSchemesAsPrivileged([
  {scheme: 'app', privileges: APP_SCHEME_PRIVILEGES}
]);

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST_DIR = isDev ? undefined : join(__dirname, '../../dist');
const CSP_FILE = join(__dirname, 'csp.json');

// Single instance: a second launch focuses the existing window instead of
// forking a second app instance (matches the PWA tab model).
if(!app.requestSingleInstanceLock()) {
  app.quit();
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
  'file-system': 'read and write files',
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
// The strict CSP, resolved once at startup (throws — fail closed — when the
// packaged CSP is broken). createWindow consumes it after whenReady.
let activeCsp: string | undefined;

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

function serveFromDisk(filePath: string): Response {
  // net.fetch handles MIME types and is asar-transparent.
  return net.fetch('file://' + filePath) as unknown as Response;
}

function serveFile(url: URL): Response {
  // pathname is e.g. /index.html or /assets/js/xxx.js
  let pathname = decodeURIComponent(url.pathname);
  if(pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  // Resolve inside DIST_DIR only — reject any traversal attempt. path.relative
  // is the real containment check: a startsWith() prefix test would accept a
  // sibling directory sharing the prefix (<dist>/../dist-evil/x). An empty
  // relative path means DIST_DIR itself, also rejected.
  const resolved = normalize(join(DIST_DIR!, pathname));
  const rel = relative(DIST_DIR!, resolved);
  if(rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return new Response('forbidden', {status: 403});
  }

  const filePath = existsSync(resolved) ? resolved : join(DIST_DIR!, 'index.html');

  if(!existsSync(filePath)) {
    return new Response('not found', {status: 404});
  }

  return serveFromDisk(filePath);
}

function getCsp(): string | undefined {
  if(isDev) {
    // Dev builds load from the Vite dev server, which supplies its own
    // headers; there is no packaged CSP to apply.
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(CSP_FILE, 'utf8')) as {header?: string};
    if(typeof parsed.header !== 'string' || parsed.header.length === 0) {
      throw new Error('missing or empty "header" field');
    }
    return parsed.header;
  } catch(err) {
    // Fail closed: a packaged build without its strict CSP must not start —
    // shipping an unprotected renderer would silently void the security
    // posture this app is built around.
    throw new Error(
      `packaged CSP missing or malformed (${CSP_FILE}) — refusing to start without the Content-Security-Policy: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

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

  if(activeCsp) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // CSP only for the packaged app:// origin; the dev server is exempt.
      if(details.url.startsWith('app://')) {
        callback({responseHeaders: {...details.responseHeaders, 'Content-Security-Policy': [activeCsp!]}});
      } else {
        callback({});
      }
    });
  }

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
  // Electron 39 requires BOTH handlers — most APIs CHECK first and only
  // REQUEST after the check passes, so the check handler is not optional
  // (review blocker on #153). The check is now just the doorbell for the
  // app origin; the request handler below is the real gate.
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
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    return isPermissionCheckAllowed({
      permission,
      requestingOrigin,
      requestingUrl: (details as {requestingUrl?: string}).requestingUrl,
      mediaType: (details as {mediaType?: string}).mediaType
    }, isDev ? DEV_URL : undefined);
  });

  if(isDev) {
    mainWindow.loadURL(DEV_URL!);
  } else {
    mainWindow.loadURL('app://localhost/index.html');
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
  // Resolved before anything is served — a broken packaged CSP aborts the
  // boot instead of starting an unprotected renderer.
  activeCsp = getCsp();
  loadPermissionSettings();
  if(!isDev) {
    protocol.handle('app', (request) => serveFile(new URL(request.url)));
  }
  createWindow();

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
