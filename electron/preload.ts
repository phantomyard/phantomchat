/*
 * PhantomChat desktop — preload.
 *
 * Exposes exactly one narrow, typed API on window.phantomchatDesktop.
 * Deliberately minimal: the renderer must never get IPC-everything access.
 * New capabilities go here one by one, with an explicit allowlist.
 */
import {contextBridge, ipcRenderer} from 'electron';
import type {UpdateState} from './updater';

export type {UpdateState};

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
}

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
  }
};

contextBridge.exposeInMainWorld('phantomchatDesktop', api);
