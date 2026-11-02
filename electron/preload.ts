/*
 * PhantomChat desktop — preload.
 *
 * Exposes exactly one narrow, typed API on window.phantomchatDesktop.
 * Deliberately minimal: the renderer must never get IPC-everything access.
 * New capabilities go here one by one, with an explicit allowlist.
 */
import {contextBridge, ipcRenderer} from 'electron';
import type {UpdateState} from './updater';
import type {PermissionSettings, PermissionSetting} from './permissions';

export type {UpdateState, PermissionSettings, PermissionSetting};

export interface PhantomChatDesktopApi {
  /** Installed app version (electron app version, e.g. "1.0.42"). */
  getVersion(): Promise<string>;
  /** Host platform: 'linux' | 'win32' | 'darwin' ( | others as added). */
  getPlatform(): Promise<NodeJS.Platform>;
  /**
   * Open an https URL in the user's default browser. The main process
   * re-validates the protocol — non-https URLs are silently dropped.
   */
  openExternal(url: string): Promise<void>;
  /** Current update ring, version and check status. */
  getUpdateState(): Promise<UpdateState>;
  /**
   * Switch release ring ('stable' | 'preview'). An unknown value is ignored
   * by the main process, which re-validates it.
   */
  setUpdateChannel(channel: string): Promise<UpdateState>;
  /** Force a check now, outside the 24h schedule. */
  checkForUpdates(): Promise<UpdateState>;
  /**
   * Install a downloaded update and relaunch. On installs that cannot
   * auto-install this opens the release page instead. Resolves false when
   * there is nothing to act on.
   */
  installUpdate(): Promise<boolean>;
  /**
   * Subscribe to update-state pushes. Returns an unsubscribe function.
   * The listener only ever receives the main process's own state object —
   * the raw IpcRendererEvent is deliberately not forwarded.
   */
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  /** Current permission overrides + remembered grants (issue #215). */
  getPermissionSettings(): Promise<PermissionSettings>;
  /**
   * Set one permission's setting ('allow' | 'ask' | 'deny'). The main
   * process validates both arguments; the returned state is the source of
   * truth, not what was sent.
   */
  setPermissionSetting(permission: string, setting: PermissionSetting): Promise<PermissionSettings>;
  /**
   * Replace the whole permission settings object (overrides + remembered
   * grants) with defaults atomically — the only correct "Reset to
   * defaults", since grants can exist for permissions the tab never lists.
   */
  resetPermissionSettings(): Promise<PermissionSettings>;
  /** External AI and Local PC access (issue #276). Absent on older installs. */
  localAi: Record<(typeof LOCAL_AI_CHANNELS)[number], (...args: unknown[]) => Promise<any>> & {
    onEvent(listener: (event: unknown) => void): () => void;
  };
}

// The allowlist for the embed: main re-checks every argument and the calling frame.
const LOCAL_AI_CHANNELS = [
  'set-context',
  'list-providers',
  'configure-phantomops',
  'configure-openai-compatible',
  'set-provider-key',
  'sign-in',
  'remove-provider',
  'answer-auth-prompt',
  'list-external-ai',
  'create-external-ai',
  'create-first-external-ai',
  'greet-external-ai',
  'update-external-ai',
  'delete-external-ai',
  'model-choices',
  'effort-choices',
  'local-access-enabled',
  'capability',
  'set-local-access',
  'tool-message'
] as const;

const localAi = Object.fromEntries(LOCAL_AI_CHANNELS.map((channel) => [
  channel,
  (...args: unknown[]) => ipcRenderer.invoke(`desktop:local-ai:${channel}`, ...args)
])) as unknown as PhantomChatDesktopApi['localAi'];
localAi.onEvent = (listener) => {
  const handler = (_event: unknown, event: unknown) => listener(event);
  ipcRenderer.on('desktop:local-ai-event', handler);
  return () => ipcRenderer.removeListener('desktop:local-ai-event', handler);
};

const api: PhantomChatDesktopApi = {
  getVersion: () => ipcRenderer.invoke('desktop:get-version'),
  getPlatform: () => ipcRenderer.invoke('desktop:get-platform'),
  openExternal: (url: string) => ipcRenderer.invoke('desktop:open-external', url),
  getUpdateState: () => ipcRenderer.invoke('desktop:update-get-state'),
  setUpdateChannel: (channel: string) => ipcRenderer.invoke('desktop:update-set-channel', channel),
  checkForUpdates: () => ipcRenderer.invoke('desktop:update-check-now'),
  installUpdate: () => ipcRenderer.invoke('desktop:update-install-now'),
  onUpdateState: (listener: (state: UpdateState) => void) => {
    const handler = (_event: unknown, state: UpdateState) => listener(state);
    ipcRenderer.on('desktop:update-state', handler);
    return () => ipcRenderer.removeListener('desktop:update-state', handler);
  },
  getPermissionSettings: () => ipcRenderer.invoke('desktop:get-permission-settings'),
  setPermissionSetting: (permission: string, setting: PermissionSetting) =>
    ipcRenderer.invoke('desktop:set-permission-setting', permission, setting),
  resetPermissionSettings: () => ipcRenderer.invoke('desktop:reset-permission-settings'),
  localAi
};

contextBridge.exposeInMainWorld('phantomchatDesktop', api);

// Liveness heartbeat for the diagnostics log (issue #243). Not exposed to
// the page: it runs here, on the renderer's main thread, so if that thread
// hangs the beats stop and the main process logs the gap. Each beat also
// reports how long a single requestAnimationFrame probe has been waiting —
// rAF only fires when a frame is actually produced, so live timers with a
// waiting probe on a visible page mean the compositor/paint path is wedged.
// One probe per beat (not a continuous rAF loop) keeps it near-free.
// Interval and channel must match diagnostics.ts / diagnosticsElectron.ts.
let frameProbeSince: number | null = null;
setInterval(() => {
  const visible = document.visibilityState === 'visible';
  const now = performance.now();
  ipcRenderer.send('desktop:diag-heartbeat', {
    visible,
    frameWaitMs: frameProbeSince === null ? 0 : Math.round(now - frameProbeSince)
  });
  if(visible && frameProbeSince === null) {
    frameProbeSince = now;
    requestAnimationFrame(() => {
      frameProbeSince = null;
    });
  }
}, 5_000);
