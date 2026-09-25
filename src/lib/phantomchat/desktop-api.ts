/*
 * Typed access to the Electron preload bridge (window.phantomchatDesktop).
 *
 * Kept in its own module, separate from the settings tab that consumes it,
 * so the settings list can ask "are we in the desktop app?" without pulling
 * the whole updates tab into the main bundle — the tab itself stays behind a
 * dynamic import.
 *
 * Every field is optional from the renderer's point of view: an older
 * packaged build may expose a smaller preload API than the bundle it is
 * serving is aware of, and that must degrade rather than throw.
 */

export type UpdateChannel = 'stable' | 'preview';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error';

export interface UpdateState {
  channel: UpdateChannel;
  /** 'auto' = installs itself; 'notify' = tells you, you install it. */
  capability: 'auto' | 'notify';
  capabilityReason: string | null;
  currentVersion: string;
  lastCheckedAt: number | null;
  status: UpdateStatus;
  availableVersion: string | null;
  releaseUrl: string | null;
  progressPercent: number | null;
  error: string | null;
}

export interface PhantomChatDesktopApi {
  getVersion(): Promise<string>;
  getPlatform(): Promise<string>;
  openExternal(url: string): Promise<void>;
  getUpdateState(): Promise<UpdateState>;
  setUpdateChannel(channel: string): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  installUpdate(): Promise<boolean>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
}

export function getDesktopApi(): PhantomChatDesktopApi | null {
  const api = (window as any)?.phantomchatDesktop;
  return api && typeof api === 'object' ? api as PhantomChatDesktopApi : null;
}

/** True only inside the packaged Electron app; false in the PWA. */
export function isDesktopApp(): boolean {
  return getDesktopApi() !== null;
}

/**
 * True when this desktop build's preload actually exposes the update API.
 * An install packaged before #164 has the bridge but not these methods.
 */
export function hasDesktopUpdateApi(): boolean {
  const api = getDesktopApi();
  return !!api && typeof api.getUpdateState === 'function' && typeof api.onUpdateState === 'function';
}
