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
  /**
   * The phantombot engine bundled in the desktop app: one general bridge
   * (see electron/phantombot/methods.ts for the methods). Turns default to the
   * principal. Optional: installs packaged before it shipped do not have it.
   */
  phantombot?: DesktopPhantombotApi;
  voiceModels?: {call(method: string, params?: unknown): Promise<DesktopPhantombotResult>};
  /**
   * Scan: personas of the phantombot installed on this PC (contacts redesign).
   * Optional: installs packaged before it shipped do not have it.
   */
  localPersonas?: DesktopLocalPersonasApi;
  /**
   * Decision Model for every engine persona (issue #449). Optional: installs
   * packaged before it shipped do not have it.
   */
  decisionModel?: DesktopDecisionModelApi;
}

export type DecisionModelProvider = 'openrouter' | 'typesafe';

/** Main's view of the setting. Never carries the key. */
export interface DecisionModelState {
  configured: boolean;
  enabled: boolean;
  provider: DecisionModelProvider;
  model: string;
  hasKey: boolean;
  canStoreKey: boolean;
}

export interface DecisionModelCheck {
  status: 'verified' | 'invalid' | 'unverified';
  detail: string;
  models: string[];
}

export type DecisionModelSaveResult =
  | {ok: true; state: DecisionModelState; applied: number; failed: {persona: string; error: string}[]}
  | {ok: false; error: string; state: DecisionModelState | null};

export interface DesktopDecisionModelApi {
  get(): Promise<DecisionModelState | null>;
  /** An empty key checks with the stored key of the same provider. */
  check(provider: string, apiKey: string): Promise<{ok: true; value: DecisionModelCheck} | {ok: false; error: string}>;
  /** An empty or absent key keeps the stored one (same provider only). */
  save(input: {enabled: boolean; provider: string; model: string; apiKey?: string}): Promise<DecisionModelSaveResult>;
}

export interface LocalPersonaListing {
  persona: string;
  npub: string | null;
  phantomchat: boolean;
  /** My npub is already on its allowlist. */
  allowed: boolean;
}

export type LocalPersonasResult<T> =
  | {ok: true; value: T}
  | {ok: false; error: {code: 'not_installed' | 'outdated' | 'failed'; message: string}};

export interface DesktopLocalPersonasApi {
  list(ownNpub: string): Promise<LocalPersonasResult<LocalPersonaListing[]>>;
  /** Allow my npub on `persona`, then restart the installed phantombot. */
  allow(persona: string, ownNpub: string): Promise<LocalPersonasResult<{npub: string; added: boolean; restarted: boolean; restartError?: string}>>;
}

export type DesktopPhantombotResult =
  | {ok: true; value: unknown}
  | {ok: false; error: {code: string; message: string}};

export interface DesktopPhantombotApi {
  /** Run one engine method. Never rejects: failures come back as `{ok: false}`. */
  call(method: string, params?: Record<string, unknown>): Promise<DesktopPhantombotResult>;
  /**
   * Events of running `persona.turn` calls, and hosted PhantomChat channel
   * state (`{persona, phantomchat}`). Returns an unsubscribe function.
   */
  onEvent(listener: (message: {turnId: string; event: unknown} | {persona: string; phantomchat: unknown}) => void): () => void;
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

/** The desktop app's phantombot bridge, or null in the PWA and on older installs. */
export function getDesktopPhantombot(): DesktopPhantombotApi | null {
  const bridge = getDesktopApi()?.phantombot;
  return bridge && typeof bridge.call === 'function' && typeof bridge.onEvent === 'function' ? bridge : null;
}

export function getDesktopVoiceModels() {
  const api = getDesktopApi()?.voiceModels;
  return typeof api?.call === 'function' ? api : null;
}

/** The Decision Model API, or null in the PWA and on installs packaged before #449. */
export function getDesktopDecisionModel(): DesktopDecisionModelApi | null {
  const api = getDesktopApi()?.decisionModel;
  return api && typeof api.get === 'function' && typeof api.check === 'function' && typeof api.save === 'function' ? api : null;
}
