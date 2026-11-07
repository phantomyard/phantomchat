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
  /**
   * Main's verdict on whether to raise the update notification now (an
   * actionable update, not snoozed, not already handled this session).
   * Optional: builds packaged before the notification shipped never send it,
   * so every read is `=== true`.
   */
  notifyPending?: boolean;
}

export type PermissionSetting = 'ask' | 'allow' | 'deny';

export interface PresenceSettings {
  closeToTray: boolean;
  startAtLogin: boolean;
}

/** What this PC's desktop can actually deliver (see electron/presence.ts). */
export interface PresenceCapability {
  tray: boolean;
  autostart: boolean;
  trayReason: string | null;
  autostartReason: string | null;
}

export interface DesktopPresenceState {
  /** The user's stored choice — kept even when a capability is missing. */
  settings: PresenceSettings;
  capability: PresenceCapability;
  /** `settings && capability`: what is really in force right now. */
  effective: PresenceSettings;
}

/** The two rows the Desktop tab can show. */
export type PresenceRow = 'startAtLogin' | 'closeToTray';

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
  /** Silence the update notification for 24h. Optional: newer than the bridge. */
  remindLaterUpdate?(): Promise<UpdateState>;
  /** Record that the user acted on this version. Optional: newer than the bridge. */
  dismissUpdateNotification?(): Promise<UpdateState>;
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
   * Tray presence (start at login / close to tray). Optional: installs
   * packaged before it shipped have the bridge but not these methods.
   */
  getPresence?(): Promise<DesktopPresenceState>;
  setPresence?(patch: Partial<PresenceSettings>): Promise<DesktopPresenceState>;
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
  /** Embeddings for every engine persona. Optional: older installs lack it. */
  embeddings?: DesktopEmbeddingsApi;
}

/** 'gemini', 'openai-compatible' or a Pi provider id from `providers()`. */
export type EmbeddingsProvider = string;

export interface EmbeddingsProviderInfo {
  id: string;
  label: string;
  /** Bring-your-own endpoint: shows the Base URL field. */
  needsBaseUrl: boolean;
  /** A local server may need no key. */
  keyOptional: boolean;
}

/** Main's view of the setting. Never carries the key. */
export interface EmbeddingsState {
  configured: boolean;
  enabled: boolean;
  provider: EmbeddingsProvider;
  baseUrl: string;
  model: string;
  dims: number;
  hasKey: boolean;
  canStoreKey: boolean;
}

export interface EmbeddingsCheck {
  status: 'verified' | 'failed' | 'unchecked';
  detail: string;
  models: string[];
  dims?: number;
}

export interface EmbeddingsCheckInput {provider: EmbeddingsProvider; baseUrl?: string; apiKey?: string; model?: string}

export type EmbeddingsSaveResult =
  | {ok: true; state: EmbeddingsState; applied: number; failed: {persona: string; error: string}[]}
  | {ok: false; error: string; state: EmbeddingsState | null};

export interface DesktopEmbeddingsApi {
  get(): Promise<EmbeddingsState | null>;
  /** Providers that serve embedding models. Older apps lack it. */
  providers?(): Promise<EmbeddingsProviderInfo[]>;
  /** An empty key checks with the stored key of the same provider and endpoint. */
  check(input: EmbeddingsCheckInput): Promise<{ok: true; value: EmbeddingsCheck} | {ok: false; error: string}>;
  /** Turning it on needs a live embed with the model; a failed one saves nothing. */
  save(input: EmbeddingsCheckInput & {enabled: boolean}): Promise<EmbeddingsSaveResult>;
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

/**
 * True when this desktop build's preload exposes the tray-presence API.
 * The Settings row is hidden in the PWA and on installs packaged before it.
 */
export function hasDesktopPresenceApi(): boolean {
  const api = getDesktopApi();
  return !!api && typeof api.getPresence === 'function' && typeof api.setPresence === 'function';
}

/**
 * Which presence rows this PC can honour. The same gate hides a row in the
 * PWA (no capability at all) and on a desktop that cannot deliver it, so a
 * setting no platform supports is never shown as a dead switch.
 */
export function visiblePresenceRows(capability: PresenceCapability | null | undefined): PresenceRow[] {
  const rows: PresenceRow[] = [];
  if(capability?.autostart) rows.push('startAtLogin');
  if(capability?.tray) rows.push('closeToTray');
  return rows;
}

/**
 * True when this desktop build's preload can snooze and dismiss the update
 * notification (the New Update Notification). A build packaged before it
 * shipped has the update API but neither method, and mounting the modal there
 * would raise it again after every state push with no way to say "later".
 */
export function hasDesktopUpdateNotificationApi(): boolean {
  const api = getDesktopApi();
  return !!api &&
    typeof api.remindLaterUpdate === 'function' &&
    typeof api.dismissUpdateNotification === 'function';
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

/** The Embeddings API, or null in the PWA and on installs packaged before it. */
export function getDesktopEmbeddings(): DesktopEmbeddingsApi | null {
  const api = getDesktopApi()?.embeddings;
  return api && typeof api.get === 'function' && typeof api.check === 'function' && typeof api.save === 'function' ? api : null;
}

/** Settings > Specialized Models exists when any of its three screens can work. */
export function hasDesktopSpecializedModels(): boolean {
  return !!(getDesktopDecisionModel() || getDesktopVoiceModels() || getDesktopEmbeddings());
}
