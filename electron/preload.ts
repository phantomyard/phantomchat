/*
 * PhantomChat desktop — preload.
 *
 * Exposes exactly one narrow, typed API on window.phantomchatDesktop.
 * Deliberately minimal: the renderer must never get IPC-everything access.
 * New capabilities go here one by one, with an explicit allowlist.
 */
import {contextBridge, ipcRenderer} from 'electron';

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
}

const api: PhantomChatDesktopApi = {
  getVersion: () => ipcRenderer.invoke('desktop:get-version'),
  getPlatform: () => ipcRenderer.invoke('desktop:get-platform'),
  openExternal: (url: string) => ipcRenderer.invoke('desktop:open-external', url)
};

contextBridge.exposeInMainWorld('phantomchatDesktop', api);
