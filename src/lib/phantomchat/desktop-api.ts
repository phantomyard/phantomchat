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

export type PermissionSetting = 'ask' | 'allow' | 'deny';

export interface PermissionSettings {
  overrides: Record<string, PermissionSetting>;
  granted: string[];
}

export type LocalAiOutcome<T> = {ok: true; value: T} | {ok: false; error: string};

export interface LocalAiProvider {
  id: string;
  name: string;
  configured: boolean;
  source: string | null;
  featured: boolean;
  custom: boolean;
  canUseKey: boolean;
  canUseOAuth: boolean;
  baseUrl: string | null;
}

export interface ExternalAiView {
  pubkey: string;
  ownerPubkey: string;
  name: string;
  model: string | null;
  effort: string | null;
  createdAt: number;
}

export interface LocalAiModelChoice {
  value: string;
  label: string;
  provider: string;
  providerName: string;
}

export interface LocalAiEffortChoices {
  levels: string[];
  enabled: boolean;
}

export type LocalAiEvent =
  | {type: 'tools-activity'; running: number}
  | {type: 'auth-prompt'; id: string; message: string; placeholder?: string; secret: boolean};

export interface LocalToolGroupInfo {
  isSession: boolean;
  members: string[];
}

/** External AI and Local PC access (issue #276). The nsec never crosses this bridge. */
export interface LocalAiApi {
  'set-context'(ownerPubkey: string, relays: string[]): Promise<void>;
  'list-providers'(): Promise<LocalAiOutcome<LocalAiProvider[]>>;
  'configure-phantomops'(token: string): Promise<LocalAiOutcome<void>>;
  'configure-openai-compatible'(baseUrl: string, key: string, model: string): Promise<LocalAiOutcome<void>>;
  'set-provider-key'(provider: string, key: string): Promise<LocalAiOutcome<void>>;
  'sign-in'(provider: string): Promise<LocalAiOutcome<void>>;
  'remove-provider'(provider: string): Promise<LocalAiOutcome<void>>;
  'answer-auth-prompt'(id: string, value: string | null): Promise<void>;
  'list-external-ai'(): Promise<ExternalAiView[]>;
  'create-external-ai'(): Promise<LocalAiOutcome<ExternalAiView>>;
  'create-first-external-ai'(): Promise<LocalAiOutcome<ExternalAiView | null>>;
  'greet-external-ai'(pubkey: string): Promise<void>;
  'update-external-ai'(pubkey: string, change: {name?: string; model?: string | null; effort?: string | null}): Promise<ExternalAiView | null>;
  'delete-external-ai'(pubkey: string): Promise<boolean>;
  'model-choices'(): Promise<LocalAiOutcome<LocalAiModelChoice[]>>;
  'effort-choices'(model: string | null): Promise<LocalAiOutcome<LocalAiEffortChoices>>;
  'local-access-enabled'(): Promise<string[]>;
  'capability'(): Promise<unknown>;
  'set-local-access'(pubkey: string, on: boolean, name: string): Promise<{enabled: boolean; notify: unknown | null}>;
  'tool-message'(sender: string, payload: unknown, group: LocalToolGroupInfo | null): Promise<unknown[]>;
  onEvent(listener: (event: LocalAiEvent) => void): () => void;
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
  getPermissionSettings?(): Promise<PermissionSettings>;
  setPermissionSetting?(permission: string, setting: PermissionSetting): Promise<PermissionSettings>;
  /**
   * Reset ALL permission overrides and remembered grants to defaults in one
   * atomic main-process step (issue #215, review on #216). Optional so an
   * older packaged bridge degrades instead of throwing.
   */
  resetPermissionSettings?(): Promise<PermissionSettings>;
  localAi?: LocalAiApi;
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
 * True when this desktop build's preload exposes the permission-settings API
 * (issue #215). Older installs have the bridge but not these methods.
 */
export function hasDesktopPermissionApi(): boolean {
  const api = getDesktopApi();
  return !!api &&
    typeof api.getPermissionSettings === 'function' &&
    typeof api.setPermissionSetting === 'function';
}

/**
 * True when this desktop build's preload actually exposes the update API.
 * An install packaged before #164 has the bridge but not these methods.
 */
export function hasDesktopUpdateApi(): boolean {
  const api = getDesktopApi();
  return !!api && typeof api.getUpdateState === 'function' && typeof api.onUpdateState === 'function';
}

/** The embed's API, or null on the PWA and on desktop builds from before #276. */
export function getLocalAiApi(): LocalAiApi | null {
  return getDesktopApi()?.localAi ?? null;
}
