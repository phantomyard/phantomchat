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
import {app, BrowserWindow, session, shell, protocol, net, ipcMain, dialog, safeStorage} from 'electron';
import {readFileSync, writeFileSync, renameSync, mkdirSync, existsSync} from 'fs';
import {join} from 'path';
import {installDesktopEntry, uninstallDesktopEntry} from './desktopIntegration';
import {attachEditableContextMenu} from './contextMenu';
import {APP_SCHEME_PRIVILEGES} from './scheme';
import {createFrontendProxy, ENTRY_PATH, resolveFrontendOrigin} from './frontendProxy';
import {SPLASH_PATH} from './splash';
import {VoiceModels} from './voiceModels';
import {hostBinaryPath, isAllowedCaller, checkRequest, PhantombotHostClient} from './phantombot/client';
import type {PhantombotMethod} from './phantombot/methods';
import {runPhantombotProbe} from './phantombot/probe';
import {allowOnLocalPersona, findPhantombot, listLocalPersonas, phantombotCandidates} from './localPersonas/scan';
import {LocalToolsHost, type ToolResult} from './localTools/host';
import {DecisionModelSettings, inheritOnCreate, type KeyCipher} from './decisionModel';
import {EmbeddingsSettings} from './embeddings';
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

// Packaging probe: proves the bundled phantombot engine runs on this install.
// It is async, so the rest of startup is skipped while it runs (no instance
// lock, no window, no diagnostics).
const isPhantombotProbe = process.argv.includes('--phantombot-probe');
if(isPhantombotProbe) {
  void runPhantombotProbe(hostBinaryPath(app.isPackaged, process.resourcesPath, __dirname)).then((code) => process.exit(code), () => process.exit(1));
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
const hasInstanceLock = !isPhantombotProbe && app.requestSingleInstanceLock();
if(isPhantombotProbe) {
  // Nothing else to start: the probe exits the process when it is done.
} else if(!hasInstanceLock) {
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
let phantombot: PhantombotHostClient | undefined;

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

// The phantombot bridge: one general channel into the bundled engine, so a
// new PWA feature needs no new desktop build. Only the app's own top frame may
// call it (isAllowedCaller); the method allowlist and shape checks run here and
// again in the host. Turn events go back to the frame that started the turn.
ipcMain.handle('desktop:phantombot:call', async(event, method: unknown, params: unknown) => {
  if(!isAllowedCaller(event.senderFrame?.url, event.senderFrame === event.sender.mainFrame, isDev ? DEV_URL : undefined)) {
    return {ok: false, error: {code: 'forbidden', message: 'not available to this page'}};
  }
  const request = checkRequest(method, params);
  if('code' in request) return {ok: false, error: request};
  const sender = event.sender;
  const result = await ensurePhantombot().call(request.method, request.params, (turnId, data) => {
    if(!sender.isDestroyed()) sender.send('desktop:phantombot-event', {turnId, event: data});
  });
  // Every new persona inherits the Decision Model setting (issue #449), here
  // in main so the key never reaches the page.
  await inheritOnCreate(ensureDecisionModel(), request.method, request.params, result);
  await inheritOnCreate(ensureEmbeddings(), request.method, request.params, result);
  if(result.ok && request.method === 'personas.create') {
    // Constructing the voice store is not a voice failure of this persona: a
    // broken store must not roll persona creation back. applyNewPersona only
    // fails (and rolls back) when an enabled default fails to apply.
    const voice = ensureVoiceModels();
    try { await voice.applyNewPersona(String(request.params.persona)); }
    catch {
      await ensurePhantombot().call('personas.delete', {persona: request.params.persona});
      return {ok: false, error: {code: 'voice_settings', message: 'Could not apply voice defaults to the new persona'}};
    }
  }
  return result;
});

function ensurePhantombot(): PhantombotHostClient {
  phantombot ??= new PhantombotHostClient({
    binary: hostBinaryPath(app.isPackaged, process.resourcesPath, __dirname),
    root: join(app.getPath('userData'), 'phantombot'),
    log: (line) => console.log('[phantombot]', line),
    // Provider contacts' channels: every window hears restarts and failures.
    onChannelStatus: (persona, status) => {
      for(const win of BrowserWindow.getAllWindows()) {
        if(!win.isDestroyed()) win.webContents.send('desktop:phantombot-event', {persona, phantomchat: status});
      }
    }
  });
  return phantombot;
}

// Decision Model (issue #449): one setting for every engine persona. The key
// stays in main, encrypted with safeStorage; the page learns only `hasKey`.
const decisionModelCipher: KeyCipher = {
  // Linux without a keyring falls back to `basic_text`, a hardcoded key:
  // that is not encryption, so the key is then not kept at all.
  available: () => safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (encrypted) => safeStorage.decryptString(encrypted)
};
let decisionModel: DecisionModelSettings | undefined;
function ensureDecisionModel(): DecisionModelSettings {
  decisionModel ??= new DecisionModelSettings({
    file: join(app.getPath('userData'), 'decision-model.json'),
    call: (method, params) => ensurePhantombot().call(method as PhantombotMethod, params),
    cipher: decisionModelCipher,
    log: (line) => console.log('[decision-model]', line)
  });
  return decisionModel;
}
const decisionModelFailure = (err: unknown) => ({ok: false, error: err instanceof Error ? err.message : String(err)});
ipcMain.handle('desktop:decision-model:get', (event) => fromApp(event) ? ensureDecisionModel().state() : null);
ipcMain.handle('desktop:decision-model:check', async(event, provider: unknown, apiKey: unknown) => {
  if(!fromApp(event)) return {ok: false, error: 'not available to this page'};
  try {
    return {ok: true, value: await ensureDecisionModel().check(provider, apiKey)};
  } catch(err) {
    return decisionModelFailure(err);
  }
});
ipcMain.handle('desktop:decision-model:save', async(event, input: unknown) => {
  if(!fromApp(event)) return {ok: false, error: 'not available to this page', state: null};
  return ensureDecisionModel().save(input);
});

// Embeddings (Settings > Specialized Models): one provider for every engine
// persona, key kept like the Decision Model's. The engine runs no heartbeat,
// so main embeds changed notes on a timer (a no-op while Embeddings is off).
let embeddings: EmbeddingsSettings | undefined;
function ensureEmbeddings(): EmbeddingsSettings {
  embeddings ??= new EmbeddingsSettings({
    file: join(app.getPath('userData'), 'embeddings.json'),
    call: (method, params) => ensurePhantombot().call(method as PhantombotMethod, params),
    cipher: decisionModelCipher,
    log: (line) => console.log('[embeddings]', line)
  });
  return embeddings;
}
const EMBEDDINGS_REFRESH_MS = 30 * 60_000;
app.whenReady().then(() => {
  const refresh = () => void ensureEmbeddings().refreshAll().catch((err) => console.log('[embeddings] refresh failed', err));
  setTimeout(refresh, 60_000).unref?.();
  setInterval(refresh, EMBEDDINGS_REFRESH_MS).unref?.();
});
ipcMain.handle('desktop:embeddings:get', (event) => fromApp(event) ? ensureEmbeddings().state() : null);
ipcMain.handle('desktop:embeddings:check', async(event, input: unknown) => {
  if(!fromApp(event)) return {ok: false, error: 'not available to this page'};
  try {
    return {ok: true, value: await ensureEmbeddings().check(input)};
  } catch(err) {
    return decisionModelFailure(err);
  }
});
ipcMain.handle('desktop:embeddings:save', async(event, input: unknown) => {
  if(!fromApp(event)) return {ok: false, error: 'not available to this page', state: null};
  return ensureEmbeddings().save(input);
});

let voiceModels: VoiceModels | undefined;
function ensureVoiceModels(): VoiceModels {
  return voiceModels ??= new VoiceModels(join(app.getPath('userData'), 'voice-models.enc'), decisionModelCipher,
    (method, params) => ensurePhantombot().call(method as PhantombotMethod, params ?? {}));
}
ipcMain.handle('desktop:voice-models', async(event, method: unknown, params: unknown) => {
  if(!isAllowedCaller(event.senderFrame?.url, event.senderFrame === event.sender.mainFrame, isDev ? DEV_URL : undefined)) {
    return {ok: false, error: {code: 'forbidden', message: 'not available to this page'}};
  }
  try { return await ensureVoiceModels().handle(method, params); }
  catch {return {ok: false, error: {code: 'unavailable', message: 'Encrypted voice settings are unavailable'}};}
});

// Scan (contacts redesign): the phantombot installed on this PC, not the
// bundled engine. Same caller check as the bridge.
function installedPhantombot(): string | undefined {
  return findPhantombot(phantombotCandidates(process.env, process.platform, app.getPath('home')));
}
// Local tools for Phantom contacts (phantombot #747): the gate and protocol
// live here, the tools run in the bundled engine. The renderer unwraps and
// verifies each rumor (it holds the key) and sends what this returns.
let localTools: LocalToolsHost | undefined;
function ensureLocalTools(): LocalToolsHost {
  localTools ??= new LocalToolsHost({
    dataDir: join(app.getPath('userData'), 'local-tools'),
    tools: {
      run: async(runId, tool, args, timeoutMs) => {
        const res = await ensurePhantombot().call('tools.run', {callId: runId, tool, args, ...(timeoutMs ? {timeoutMs} : {})});
        return res.ok ? res.value as ToolResult : {status: 'error', output: res.error.message};
      },
      cancel: async(runId) => {
        await ensurePhantombot().call('tools.cancel', {callId: runId});
      }
    },
    confirm: async(name) => {
      const options = {
        type: 'warning' as const,
        message: `Allow ${name} to use this PC?`,
        detail: `${name} will be able to run commands and read and change any file on this PC, without asking again. You can turn this off at any time in contact info.`,
        buttons: ['Allow', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      };
      const {response} = await (mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options));
      return response === 0;
    }
  });
  return localTools;
}
function fromApp(event: Electron.IpcMainInvokeEvent): boolean {
  return isAllowedCaller(event.senderFrame?.url, event.senderFrame === event.sender.mainFrame, isDev ? DEV_URL : undefined);
}
ipcMain.handle('desktop:local-tools:set-owner', (event, owner: unknown) => {
  if(!fromApp(event) || typeof owner !== 'string') return {enabled: [], capability: null};
  const host = ensureLocalTools();
  host.setOwner(owner);
  return {enabled: host.enabled(), capability: host.capability()};
});
ipcMain.handle('desktop:local-tools:enabled', (event) => fromApp(event) ? ensureLocalTools().enabled() : []);
ipcMain.handle('desktop:local-tools:set', (event, pubkey: unknown, on: unknown, name: unknown) => {
  if(!fromApp(event) || typeof pubkey !== 'string' || typeof on !== 'boolean') return {enabled: false, notify: null};
  return ensureLocalTools().setLocalAccess(pubkey, on, typeof name === 'string' && name ? name.slice(0, 80) : 'This contact');
});
ipcMain.handle('desktop:local-tools:message', (event, sender: unknown, payload: unknown, group: unknown) => {
  if(!fromApp(event) || typeof sender !== 'string') return [];
  const g = group && typeof group === 'object' &&
    typeof (group as any).isSession === 'boolean' && Array.isArray((group as any).members) ?
    {isSession: (group as any).isSession as boolean, members: ((group as any).members as unknown[]).filter((m): m is string => typeof m === 'string')} :
    null;
  return ensureLocalTools().handleMessage(sender, payload, g);
});
ipcMain.handle('desktop:local-personas:list', (event, ownNpub: unknown) => {
  if(!isAllowedCaller(event.senderFrame?.url, event.senderFrame === event.sender.mainFrame, isDev ? DEV_URL : undefined)) {
    return {ok: false, error: {code: 'failed', message: 'not available to this page'}};
  }
  return listLocalPersonas(installedPhantombot(), typeof ownNpub === 'string' ? ownNpub : '');
});
ipcMain.handle('desktop:local-personas:allow', (event, persona: unknown, ownNpub: unknown) => {
  if(!isAllowedCaller(event.senderFrame?.url, event.senderFrame === event.sender.mainFrame, isDev ? DEV_URL : undefined)) {
    return {ok: false, error: {code: 'failed', message: 'not available to this page'}};
  }
  if(typeof persona !== 'string' || typeof ownNpub !== 'string') {
    return {ok: false, error: {code: 'failed', message: 'persona and npub must be strings'}};
  }
  return allowOnLocalPersona(installedPhantombot(), persona, ownNpub);
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
    title: 'Phantomyard Desktop',
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
  if(isPhantombotProbe) return;
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
  // Provider contacts answer while the app is open, before any page call:
  // the host starts every hosted channel that has an allowlist.
  if(existsSync(join(app.getPath('userData'), 'phantombot'))) {
    void ensurePhantombot().call('info', {});
  }
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

// Let the engine cancel its turns and release its root before the app goes.
let phantombotStopped = false;
app.on('before-quit', (event) => {
  if(phantombotStopped || !phantombot?.running) return;
  event.preventDefault();
  void phantombot.shutdown().finally(() => {
    phantombotStopped = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  // Desktop convention: quit on all platforms (PhantomChat has no tray).
  app.quit();
});
