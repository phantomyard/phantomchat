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
import {app, BrowserWindow, Tray, session, shell, protocol, net, ipcMain, dialog, safeStorage} from 'electron';
import {spawnSync} from 'child_process';
import {readFileSync, writeFileSync, renameSync, mkdirSync, existsSync} from 'fs';
import {join} from 'path';
import {installDesktopEntry, uninstallDesktopEntry} from './desktopIntegration';
import {
  type PresenceCapability,
  type PresenceSettings,
  autostartCapability,
  autostartPath,
  autostartTargetPath,
  effectivePresence,
  keepsHiddenStart,
  normalizePresenceSettings,
  presenceSettingsPath,
  probeStatusNotifier,
  readPresenceSettings,
  removeAutostartEntry,
  shouldStartHidden,
  writeAutostartEntry,
  writePresenceSettings
} from './presence';
import {createTray, resolveTrayIcon} from './tray';
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

// ─── Tray presence ─────────────────────────────────────────────────────────
// Start at login and close to tray (see electron/presence.ts for why the
// effective state is flag && capability, and why both live in one place).
let presenceSettings: PresenceSettings = normalizePresenceSettings(undefined);
let presenceCapability: PresenceCapability = {
  tray: false,
  autostart: false,
  trayReason: 'not probed yet',
  autostartReason: 'not probed yet'
};
let tray: Tray | null = null;
/** True only for a real quit; a close that hides the window is not one. */
let quitting = false;
/** Decided once at boot: a login launch stays in the tray. */
let startHidden = false;
/** True once the window has emitted ready-to-show, so a late reveal is safe. */
let windowReady = false;

function presenceState() {
  return {
    settings: presenceSettings,
    capability: presenceCapability,
    effective: effectivePresence(presenceSettings, presenceCapability)
  };
}

/**
 * What this desktop can deliver. macOS and Windows answer from their own
 * APIs; Linux is a session-bus probe, since Electron's Linux tray is a
 * StatusNotifierItem and nothing else (a bare GNOME session has no watcher).
 */
function detectPresenceCapability(): PresenceCapability {
  const login = autostartCapability({packaged: app.isPackaged, sandboxed: !!process.env.SNAP});
  if(process.platform !== 'linux') {
    return {tray: true, autostart: login.autostart, trayReason: null, autostartReason: login.reason};
  }
  const probe = probeStatusNotifier((command, args) => {
    const result = spawnSync(command, args, {encoding: 'utf8', timeout: 1500});
    return {status: result.status, missing: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'};
  });
  return {
    tray: probe.present,
    autostart: login.autostart,
    trayReason: probe.present ? null : probe.detail,
    autostartReason: login.reason
  };
}

/** Reconcile the OS login entry with the user's stored choice. */
function applyStartAtLogin(): void {
  if(!presenceCapability.autostart) return;
  const on = effectivePresence(presenceSettings, presenceCapability).startAtLogin;
  if(process.platform === 'linux') {
    const file = autostartPath(app.getPath('home'));
    const execPath = autostartTargetPath(process.env.APPIMAGE, process.execPath);
    if(on) writeAutostartEntry(file, execPath); else removeAutostartEntry(file);
    return;
  }
  // Windows carries the flag in the login entry's arguments; macOS login items
  // take no arguments, so the OS reports a login launch instead
  // (getLoginItemSettings().wasOpenedAtLogin).
  app.setLoginItemSettings(process.platform === 'darwin' ?
    {openAtLogin: on} :
    {openAtLogin: on, path: process.execPath, args: ['--hidden']});
}

function showMainWindow(): void {
  if(!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if(mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Drop the tray capability. A hidden start was decided from the probe, before
 * the tray existed; if the tray cannot be built now, the window is the only
 * way back, so it must be revealed (or, if it has not painted yet, shown by
 * its ready-to-show handler).
 */
function dropTray(reason: string): void {
  presenceCapability = {...presenceCapability, tray: false, trayReason: reason};
  startHidden = keepsHiddenStart(startHidden, presenceCapability);
  if(startHidden) return;
  console.log('[presence] no tray:', reason);
  if(windowReady && mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
}

/** Build the tray once, if this desktop has one. */
function ensureTray(): void {
  if(tray || !presenceCapability.tray) return;
  const iconPath = resolveTrayIcon({
    resourcesPath: process.resourcesPath,
    devBuildDir: join(__dirname, '..', 'build')
  });
  if(!iconPath) {
    // No icon means the close button would hide the window with nothing to
    // click: drop the capability so closing keeps the old behaviour.
    dropTray('tray icon not found');
    return;
  }
  tray = createTray(iconPath, process.platform, {
    onShow: showMainWindow,
    onQuit: () => {
      quitting = true;
      app.quit();
    }
  }) ?? null;
  if(!tray) dropTray('tray icon could not be loaded');
}

ipcMain.handle('desktop:get-presence', () => presenceState());
ipcMain.handle('desktop:set-presence', (_event, patch: unknown) => {
  // A hostile or stale renderer is untrusted input for our own config file:
  // only real booleans are taken, unknown keys are ignored.
  const source = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<string, unknown>;
  if(typeof source.closeToTray === 'boolean') presenceSettings.closeToTray = source.closeToTray;
  if(typeof source.startAtLogin === 'boolean') presenceSettings.startAtLogin = source.startAtLogin;
  // The stored flag is kept even when the capability is missing (hidden is
  // not deleted): logging into a desktop that supports it again restores it.
  writePresenceSettings(presenceSettingsPath(app.getPath('userData')), presenceSettings);
  applyStartAtLogin();
  return presenceState();
});

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
    // A new persona has no Voice ID yet: this only drops a stale one and
    // never fails creation.
    try { await ensureVoiceModels().applyNewPersona(String(request.params.persona)); } catch{/* A broken voice store is not this persona's failure. */}
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
ipcMain.handle('desktop:embeddings:providers', async(event) => {
  if(!fromApp(event)) return [];
  return ensureEmbeddings().providers().catch(() => []);
});
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
    // A login launch stays in the tray: created hidden and shown only when
    // it was not started by the login entry (see shouldStartHidden).
    show: false,
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

  // Closing the window hides it to the tray when that is both enabled and
  // possible; without a tray the old behaviour stands and the app quits.
  mainWindow.on('close', (event) => {
    if(quitting || !effectivePresence(presenceSettings, presenceCapability).closeToTray) return;
    event.preventDefault();
    if(mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  });

  mainWindow.once('ready-to-show', () => {
    windowReady = true;
    if(startHidden) return;
    if(mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
}

app.on('second-instance', () => {
  // A second launch always brings the window back, even from the tray.
  showMainWindow();
});

app.whenReady().then(() => {
  if(isPhantombotProbe) return;
  loadPermissionSettings();
  presenceSettings = readPresenceSettings(presenceSettingsPath(app.getPath('userData')));
  presenceCapability = detectPresenceCapability();
  startHidden = shouldStartHidden({
    argv: process.argv,
    platform: process.platform,
    openedAtLogin: process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin,
    capability: presenceCapability
  });
  if(!presenceCapability.tray) console.log('[presence] no tray:', presenceCapability.trayReason);
  if(!presenceCapability.autostart) console.log('[presence] no login item:', presenceCapability.autostartReason);
  // Reconcile the OS login entry with the stored choice on every boot, so a
  // setting changed elsewhere (or a wiped login entry) heals.
  applyStartAtLogin();
  if(!isDev) {
    frontend = createFrontendProxy({
      origin: resolveFrontendOrigin(app.isPackaged, process.env.PHANTOMCHAT_FRONTEND_ORIGIN),
      cacheDir: join(app.getPath('userData'), 'frontend-cache'),
      fetch: (url, init) => net.fetch(url, init)
    });
    protocol.handle('app', (request) => frontend!.handle(request));
  }
  createWindow();
  ensureTray();
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
    // macOS: clicking the dock icon reopens the hidden window.
    showMainWindow();
  });
}).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  app.exit(1);
});

// Let the engine cancel its turns and release its root before the app goes.
let phantombotStopped = false;
app.on('before-quit', (event) => {
  // From here on a closed window really means quit, not hide.
  quitting = true;
  if(phantombotStopped || !phantombot?.running) return;
  event.preventDefault();
  void phantombot.shutdown().finally(() => {
    phantombotStopped = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  // With close-to-tray the window is hidden, not closed, so this only fires
  // when the user genuinely quits — or when the tray is unavailable, which
  // keeps the old contract: close the window, quit the app.
  if(effectivePresence(presenceSettings, presenceCapability).closeToTray) return;
  app.quit();
});
