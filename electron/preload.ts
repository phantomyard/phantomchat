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
import type {DecisionModelCheck, DecisionModelSaveResult, DecisionModelState} from './decisionModel';
import type {EmbeddingsCheck, EmbeddingsSaveResult, EmbeddingsState} from './embeddings';
import type {PresenceCapability, PresenceSettings} from './presence';

export type {UpdateState, PermissionSettings, PermissionSetting, PresenceCapability, PresenceSettings};

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
   * "Remind me later" on the update notification: silence it for one check
   * interval (24h). The snooze is persisted by the main process, so a
   * relaunch inside the window stays quiet.
   */
  remindLaterUpdate(): Promise<UpdateState>;
  /**
   * The user acted on the offered update — stop raising it for this version
   * for the rest of the session. Not persisted: quitting and relaunching may
   * ask again.
   */
  dismissUpdateNotification(): Promise<UpdateState>;
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
  /**
   * Tray presence: the stored start-at-login / close-to-tray choice, what this
   * desktop can actually do, and the effective (flag && capability) state.
   * Main owns all three; this is a view over them.
   */
  getPresence(): Promise<DesktopPresenceState>;
  /**
   * Change one or both presence flags. Main validates the patch, persists it
   * and applies the login entry; the returned state is the source of truth.
   */
  setPresence(patch: Partial<PresenceSettings>): Promise<DesktopPresenceState>;
  /**
   * The bundled phantombot engine. One general entry point so a new PWA
   * feature needs no new desktop build: `call(method, params)` runs one
   * allowlisted engine method (electron/phantombot/methods.ts) and resolves
   * `{ok, value}` or `{ok: false, error: {code, message}}`; it never rejects.
   * A `persona.turn` streams `{turnId, event}` to `onEvent` until it resolves;
   * a hosted PhantomChat channel's state arrives as `{persona, phantomchat}`.
   * Absent on installs packaged before it shipped.
   */
  voiceModels: {call(method: string, params?: unknown): Promise<PhantombotResult>};
  phantombot: {
    call(method: string, params?: Record<string, unknown>): Promise<PhantombotResult>;
    onEvent(listener: (message: PhantombotEvent) => void): () => void;
  };
  /**
   * Scan: the phantombot installed on this PC (not the bundled engine). Lists
   * its personas, or adds `ownNpub` to one's allowlist and restarts it.
   * Absent on installs packaged before it shipped.
   */
  localPersonas: {
    list(ownNpub: string): Promise<unknown>;
    allow(persona: string, ownNpub: string): Promise<unknown>;
  };
  /**
   * Local tools for Phantom contacts (phantombot #747). The gate and protocol
   * are main's; the page unwraps, verifies and sends. Absent on older installs.
   */
  localTools: {
    setOwner(ownerPubkey: string): Promise<unknown>;
    enabled(): Promise<string[]>;
    set(pubkey: string, on: boolean, contactName: string): Promise<unknown>;
    message(sender: string, payload: unknown, group: unknown): Promise<unknown[]>;
  };
  /**
   * Decision Model for every engine persona (issue #449). Main keeps the key,
   * encrypted; `get` says only whether one is set. Absent on older installs.
   */
  decisionModel: {
    get(): Promise<DecisionModelState | null>;
    check(provider: string, apiKey: string): Promise<{ok: true; value: DecisionModelCheck} | {ok: false; error: string}>;
    save(input: {enabled: boolean; provider: string; model: string; apiKey?: string}): Promise<DecisionModelSaveResult>;
  };
  /** Embeddings for every engine persona (Specialized Models). Same key rules. */
  embeddings: {
    get(): Promise<EmbeddingsState | null>;
    check(input: EmbeddingsCheckInput): Promise<{ok: true; value: EmbeddingsCheck} | {ok: false; error: string}>;
    save(input: EmbeddingsSaveInput): Promise<EmbeddingsSaveResult>;
  };
}

export interface EmbeddingsCheckInput {provider: string; baseUrl?: string; apiKey?: string; model?: string}
export interface EmbeddingsSaveInput extends EmbeddingsCheckInput {enabled: boolean}

export type PhantombotEvent = {turnId: string; event: unknown} | {persona: string; phantomchat: unknown};

export interface DesktopPresenceState {
  settings: PresenceSettings;
  capability: PresenceCapability;
  effective: PresenceSettings;
}

export type PhantombotResult = {ok: true; value: unknown} | {ok: false; error: {code: string; message: string}};

const api: PhantomChatDesktopApi = {
  getVersion: () => ipcRenderer.invoke('desktop:get-version'),
  getPlatform: () => ipcRenderer.invoke('desktop:get-platform'),
  openExternal: (url: string) => ipcRenderer.invoke('desktop:open-external', url),
  getUpdateState: () => ipcRenderer.invoke('desktop:update-get-state'),
  setUpdateChannel: (channel: string) => ipcRenderer.invoke('desktop:update-set-channel', channel),
  checkForUpdates: () => ipcRenderer.invoke('desktop:update-check-now'),
  installUpdate: () => ipcRenderer.invoke('desktop:update-install-now'),
  remindLaterUpdate: () => ipcRenderer.invoke('desktop:update-remind-later'),
  dismissUpdateNotification: () => ipcRenderer.invoke('desktop:update-dismiss'),
  onUpdateState: (listener: (state: UpdateState) => void) => {
    const handler = (_event: unknown, state: UpdateState) => listener(state);
    ipcRenderer.on('desktop:update-state', handler);
    return () => ipcRenderer.removeListener('desktop:update-state', handler);
  },
  getPermissionSettings: () => ipcRenderer.invoke('desktop:get-permission-settings'),
  setPermissionSetting: (permission: string, setting: PermissionSetting) =>
    ipcRenderer.invoke('desktop:set-permission-setting', permission, setting),
  resetPermissionSettings: () => ipcRenderer.invoke('desktop:reset-permission-settings'),
  getPresence: () => ipcRenderer.invoke('desktop:get-presence'),
  setPresence: (patch: Partial<PresenceSettings>) => ipcRenderer.invoke('desktop:set-presence', patch),
  voiceModels: {call: (method, params) => ipcRenderer.invoke('desktop:voice-models', method, params)},
  phantombot: {
    call: (method: string, params?: Record<string, unknown>) => ipcRenderer.invoke('desktop:phantombot:call', method, params),
    onEvent: (listener: (message: PhantombotEvent) => void) => {
      const handler = (_event: unknown, message: PhantombotEvent) => listener(message);
      ipcRenderer.on('desktop:phantombot-event', handler);
      return () => ipcRenderer.removeListener('desktop:phantombot-event', handler);
    }
  },
  localPersonas: {
    list: (ownNpub: string) => ipcRenderer.invoke('desktop:local-personas:list', ownNpub),
    allow: (persona: string, ownNpub: string) => ipcRenderer.invoke('desktop:local-personas:allow', persona, ownNpub)
  },
  decisionModel: {
    get: () => ipcRenderer.invoke('desktop:decision-model:get'),
    check: (provider: string, apiKey: string) => ipcRenderer.invoke('desktop:decision-model:check', provider, apiKey),
    save: (input) => ipcRenderer.invoke('desktop:decision-model:save', input)
  },
  embeddings: {
    get: () => ipcRenderer.invoke('desktop:embeddings:get'),
    check: (input) => ipcRenderer.invoke('desktop:embeddings:check', input),
    save: (input) => ipcRenderer.invoke('desktop:embeddings:save', input)
  },
  localTools: {
    setOwner: (ownerPubkey: string) => ipcRenderer.invoke('desktop:local-tools:set-owner', ownerPubkey),
    enabled: () => ipcRenderer.invoke('desktop:local-tools:enabled'),
    set: (pubkey: string, on: boolean, contactName: string) => ipcRenderer.invoke('desktop:local-tools:set', pubkey, on, contactName),
    message: (sender: string, payload: unknown, group: unknown) => ipcRenderer.invoke('desktop:local-tools:message', sender, payload, group)
  }
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
