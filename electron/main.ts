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
import {app, BrowserWindow, session, shell, protocol, net, ipcMain} from 'electron';
import {readFileSync, existsSync} from 'fs';
import {join, normalize, extname} from 'path';
import {installDesktopEntry, uninstallDesktopEntry} from './desktopIntegration';

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
// immutable packaged bundle.
protocol.registerSchemesAsPrivileged([
  {scheme: 'app', privileges: {standard: true, secure: true, supportFetchAPI: true}}
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

let mainWindow: BrowserWindow | null = null;

// IPC surface — keep it in lockstep with the preload allowlist.
ipcMain.handle('desktop:get-version', () => app.getVersion());
ipcMain.handle('desktop:get-platform', () => process.platform);
ipcMain.handle('desktop:open-external', (_event, url: unknown) => {
  if(typeof url === 'string') handOffToBrowser(url);
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

  // Resolve inside DIST_DIR only — reject any traversal attempt.
  const resolved = normalize(join(DIST_DIR!, pathname));
  if(!resolved.startsWith(DIST_DIR!)) {
    return new Response('forbidden', {status: 403});
  }

  const filePath = existsSync(resolved) ? resolved : join(DIST_DIR!, 'index.html');

  if(!existsSync(filePath)) {
    return new Response('not found', {status: 404});
  }

  return serveFromDisk(filePath);
}

function getCsp(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(CSP_FILE, 'utf8')) as {header?: string};
    return parsed.header;
  } catch {
    // csp.json ships inside the package; a missing file would be a packaging
    // bug. Dev builds (VITE_DEV_SERVER_URL) legitimately have no packaged CSP.
    return undefined;
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

  const csp = getCsp();
  if(csp) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // CSP only for the packaged app:// origin; the dev server is exempt.
      if(details.url.startsWith('app://')) {
        callback({responseHeaders: {...details.responseHeaders, 'Content-Security-Policy': [csp]}});
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

  // Lock permissions: the desktop app needs none of Chromium's power APIs.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
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
  if(!isDev) {
    protocol.handle('app', (request) => serveFile(new URL(request.url)));
  }
  createWindow();

  app.on('activate', () => {
    if(BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Desktop convention: quit on all platforms (PhantomChat has no tray).
  app.quit();
});
