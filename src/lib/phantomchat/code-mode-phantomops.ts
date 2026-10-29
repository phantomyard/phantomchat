/*
 * Code Mode ↔ PhantomOps.
 *
 * PhantomChat is a thin client (Andrew, 2026-10-29): no harness, no filesystem,
 * no local engine. A phantom is just a contact, so it needs nothing new on the
 * wire — PhantomOps is the one Code entry that is NOT a Nostr peer, and this
 * module is its whole client.
 *
 * The flow is the same one the PhantomOps PWA and its embeddable widget use,
 * so there is nothing bespoke to keep in sync server-side:
 *
 *   login popup  →  POST /api/widget/token   (needs a FULL session)
 *                →  chat-scoped JWT, ~12h, pinned to (tenant, origin, user)
 *   then         →  POST /api/widget/session  (opens/finds this site's chat)
 *                   GET  /api/chat/history
 *                   POST /api/chat/message   (newline-delimited JSON stream)
 *                   POST /api/chat/stop
 *                   POST /api/chat/confirm   (tool/permission gate)
 *
 * Two things this module is deliberately careful about:
 *
 *  1. The ORIGIN CLAIM. `/api/widget/token` only accepts an http(s) origin, and
 *     the claim it mints is what the tenant's site policy is re-checked
 *     against on every request. The packaged desktop build runs on
 *     `app://localhost`, which the server refuses — so a non-http origin is
 *     reported as the PWA origin it actually is (`https://phantomchat.app`).
 *     Nothing trusts the client for this: the server pins the token to that
 *     origin and re-checks policy per request.
 *  2. The TOKEN IS NEVER IN localStorage. It lives in memory and in
 *     sessionStorage (tab-lifetime, same as PhantomOps' own widget), is
 *     chat-scoped, expires in ~12h and is revoked server-side on logout.
 *
 * Everything with a clock, a window, storage or fetch is injectable, so the
 * protocol is unit-testable without a browser or a live tenant.
 */

/** Canonical PhantomOps base URL (same one the PWA and opencode config use). */
export const PHANTOMOPS_BASE_URL = 'https://phantomops.app';

/** The origin a packaged desktop build reports: it IS this app. */
export const PHANTOMOPS_PWA_ORIGIN = 'https://phantomchat.app';

/** Message type the login popup posts the token back with. */
export const PHANTOMOPS_TOKEN_MESSAGE = 'phantomops:widget-token';

/** Key the token blob lives under in sessionStorage. */
export const PHANTOMOPS_TOKEN_STORAGE_KEY = 'phantomops.code-mode.token';

/** Refresh the token this long before it actually expires. */
export const PHANTOMOPS_TOKEN_REFRESH_MARGIN_MS = 60_000;

/** Fallback TTL when the server does not send `expiresIn`. */
export const PHANTOMOPS_TOKEN_FALLBACK_TTL_MS = 12 * 60 * 60 * 1000;

export type PhantomOpsRole = 'user' | 'assistant';

export interface PhantomOpsMessage {
  id: number;
  role: PhantomOpsRole;
  text: string;
}

export interface PhantomOpsGate {
  gateId: string;
  tool: string;
  summary: string;
  rationale: string;
}

export interface PhantomOpsState {
  signedIn: boolean;
  busy: boolean;
  /** Row text while working ("Thinking…", "Working…"). */
  activity: string | null;
  error: string | null;
  messages: PhantomOpsMessage[];
  gate: PhantomOpsGate | null;
  /** Server-side chat id this site is pinned to, once known. */
  sessionId: number | null;
}

export type PhantomOpsStreamEvent = {status: string} & Record<string, unknown>;

export interface PhantomOpsDeps {
  baseUrl?: string;
  /** Browser fetch. */
  fetch?: typeof fetch;
  /** The window the popup + postMessage listener live on. */
  window?: {
    location: {origin: string};
    open: (url: string, target: string, features: string) => any;
    addEventListener: (type: string, listener: (e: any) => void) => void;
    removeEventListener: (type: string, listener: (e: any) => void) => void;
  };
  /** sessionStorage-shaped store. `null` = memory only. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  now?: () => number;
  /** How often to poll the popup for `closed`. */
  popupPollMs?: number;
}

/**
 * The origin to declare to PhantomOps. An http(s) page declares itself; the
 * packaged desktop build (and anything else on a custom scheme) declares the
 * PWA origin, because `/api/widget/token` deliberately refuses anything else.
 */
export function phantomOpsRequestOrigin(origin: string | undefined | null): string {
  if(!origin) return PHANTOMOPS_PWA_ORIGIN;
  return /^https?:\/\//i.test(origin) ? origin : PHANTOMOPS_PWA_ORIGIN;
}

/** URL of the login popup for a given declared origin. */
export function phantomOpsConnectUrl(baseUrl: string, origin: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}/widget/connect?origin=${encodeURIComponent(phantomOpsRequestOrigin(origin))}`;
}

/**
 * Parse the newline-delimited JSON body of `/api/chat/message`.
 *
 * Forward compatible by design: a malformed line is skipped, and anything
 * without a string `status` is not an event. Pure generator over a stream so
 * the UI can render as bytes arrive instead of waiting for the whole turn.
 */
export async function* readPhantomOpsEvents(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<PhantomOpsStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parse = (line: string): PhantomOpsStreamEvent | null => {
    if(!line.trim()) return null;
    try {
      const value = JSON.parse(line) as unknown;
      if(!value || typeof value !== 'object') return null;
      const status = (value as PhantomOpsStreamEvent).status;
      return typeof status === 'string' ? value as PhantomOpsStreamEvent : null;
    } catch{
      return null;
    }
  };

  try {
    for(;;) {
      const {done, value} = await reader.read();
      if(done) break;
      buffer += decoder.decode(value, {stream: true});

      let newline = buffer.indexOf('\n');
      while(newline >= 0) {
        const event = parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if(event) yield event;
        newline = buffer.indexOf('\n');
      }
    }

    const tail = parse(buffer);
    if(tail) yield tail;
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * Is this `postMessage` payload the token hand-off for THIS page?
 *
 * Three gates: the message must come from the PhantomOps origin (never a
 * window that merely looks like it), carry our message type, and be minted for
 * the origin this page declares — which on the packaged desktop build is the
 * PWA origin, not `app://localhost`.
 */
export function isPhantomOpsTokenMessage(
  payload: any,
  messageOrigin: string,
  baseOrigin: string,
  pageOrigin: string
): boolean {
  if(messageOrigin !== baseOrigin) return false;
  if(!payload || payload.type !== PHANTOMOPS_TOKEN_MESSAGE) return false;
  if(typeof payload.token !== 'string' || !payload.token) return false;
  const declared = phantomOpsRequestOrigin(typeof payload.origin === 'string' ? payload.origin : pageOrigin);
  return declared === phantomOpsRequestOrigin(pageOrigin);
}

/** Largest stream event → state change, isolated so it is easy to test. */
export function applyPhantomOpsEvent(
  state: PhantomOpsState,
  event: PhantomOpsStreamEvent
): PhantomOpsState {
  switch(event.status) {
    case 'session_open': {
      if(typeof event.session_id !== 'number') return state;
      return {...state, sessionId: event.session_id};
    }

    case 'thinking':
      return {...state, activity: typeof event.message === 'string' && event.message ? event.message : 'Thinking…'};

    case 'working':
      return {...state, activity: typeof event.description === 'string' && event.description ? event.description : 'Working…'};

    case 'tool_complete':
      return {...state, activity: 'Thinking…'};

    case 'confirmation_required':
      return {
        ...state,
        gate: {
          gateId: String(event.gate_id ?? ''),
          tool: String(event.tool ?? ''),
          summary: String(event.args_summary ?? ''),
          rationale: String(event.rationale ?? '')
        }
      };

    case 'host_context_held':
      return state;

    default:
      return state;
  }
}

/**
 * Thin PhantomOps chat client. Owns the token, the pinned session id and the
 * streaming turn; the UI just renders `state`.
 */
export default class PhantomOpsClient {
  private baseUrl: string;
  private baseOrigin: string;
  private fetchImpl: typeof fetch;
  private win: PhantomOpsDeps['window'];
  private storage: PhantomOpsDeps['storage'];
  private now: () => number;
  private popupPollMs: number;

  private token: string | null = null;
  private expiresAt = 0;
  private epoch = 0;
  private nextMessageId = 1;
  private listeners = new Set<(state: PhantomOpsState) => void>();

  public state: PhantomOpsState = PhantomOpsClient.emptyState();

  constructor(deps: PhantomOpsDeps = {}) {
    this.baseUrl = (deps.baseUrl || PHANTOMOPS_BASE_URL).replace(/\/+$/, '');
    this.baseOrigin = new URL(this.baseUrl).origin;
    this.fetchImpl = deps.fetch || (fetch.bind(globalThis) as typeof fetch);
    this.win = deps.window || (typeof window !== 'undefined' ? window as any : undefined);
    this.storage = deps.storage === undefined ? PhantomOpsClient.defaultStorage() : deps.storage;
    this.now = deps.now || (() => Date.now());
    this.popupPollMs = deps.popupPollMs ?? 500;
    this.restore();
  }

  private static emptyState(): PhantomOpsState {
    return {signedIn: false, busy: false, activity: null, error: null, messages: [], gate: null, sessionId: null};
  }

  private static defaultStorage(): PhantomOpsDeps['storage'] {
    try {
      return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
    } catch{
      return null;
    }
  }

  // ------------------------------------------------------------- observers
  subscribe(listener: (state: PhantomOpsState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<PhantomOpsState>): void {
    this.state = {...this.state, ...patch};
    this.emit();
  }

  private emit(): void {
    for(const listener of this.listeners) listener(this.state);
  }

  // ------------------------------------------------------------- token
  /** Restore a still-valid token from the tab-scoped store. */
  private restore(): void {
    if(!this.storage) return;
    try {
      const raw = this.storage.getItem(PHANTOMOPS_TOKEN_STORAGE_KEY);
      if(!raw) return;
      const parsed = JSON.parse(raw) as {token?: string; exp?: number; session?: number};
      if(!parsed.token || typeof parsed.exp !== 'number' || parsed.exp <= this.now() + PHANTOMOPS_TOKEN_REFRESH_MARGIN_MS) {
        this.storage.removeItem(PHANTOMOPS_TOKEN_STORAGE_KEY);
        return;
      }
      this.token = parsed.token;
      this.expiresAt = parsed.exp;
      this.state = {...this.state, signedIn: true, sessionId: typeof parsed.session === 'number' ? parsed.session : null};
    } catch{
      this.storage.removeItem(PHANTOMOPS_TOKEN_STORAGE_KEY);
    }
  }

  private persist(): void {
    if(!this.storage || !this.token) return;
    try {
      this.storage.setItem(PHANTOMOPS_TOKEN_STORAGE_KEY, JSON.stringify({
        token: this.token,
        exp: this.expiresAt,
        session: this.state.sessionId
      }));
    } catch{}
  }

  private resetAccount(patch: Partial<PhantomOpsState> = {}): void {
    this.epoch++;
    this.state = {...PhantomOpsClient.emptyState(), ...patch};
    this.emit();
  }

  private signOutLocal(error: string | null = null): void {
    this.token = null;
    this.expiresAt = 0;
    try {
      this.storage?.removeItem(PHANTOMOPS_TOKEN_STORAGE_KEY);
    } catch{}
    this.resetAccount({error});
  }

  isSignedIn(): boolean {
    return !!this.token && this.expiresAt > this.now();
  }

  // ------------------------------------------------------------- login
  /**
   * Open the PhantomOps login popup and resolve once the token arrives.
   * Rejects with a readable reason when the popup is blocked or closed — the
   * caller surfaces it, it never fails silently.
   */
  async login(): Promise<void> {
    const win = this.win;
    if(!win) throw new Error('PhantomOps login needs a browser window');

    const pageOrigin = win.location.origin;
    const url = phantomOpsConnectUrl(this.baseUrl, pageOrigin);
    const popup = win.open(url, 'phantomops-login', 'popup,width=460,height=640');
    if(!popup) {
      const error = 'The PhantomOps login window was blocked. Allow pop-ups and try again.';
      this.set({error});
      throw new Error(error);
    }

    this.set({error: null});

    return new Promise<void>((resolve, reject) => {
      // The interval id lives on an object so `finish` can clear it without
      // the declaration-order dance (`poll` is created after the listener).
      const guard: {poll?: ReturnType<typeof setInterval>} = {};
      let settled = false;

      const finish = (fn: () => void) => {
        if(settled) return;
        settled = true;
        win.removeEventListener('message', onMessage);
        if(guard.poll) clearInterval(guard.poll);
        fn();
      };

      const onMessage = (event: any) => {
        if(!isPhantomOpsTokenMessage(event?.data, event?.origin, this.baseOrigin, pageOrigin)) return;

        const expiresIn = typeof event.data.expiresIn === 'number' ?
          event.data.expiresIn * 1000 :
          PHANTOMOPS_TOKEN_FALLBACK_TTL_MS;

        finish(() => {
          this.resetAccount();
          this.token = event.data.token;
          this.expiresAt = this.now() + expiresIn;
          this.state = {...this.state, signedIn: true, error: null};
          this.emit();
          this.persist();
          // Open (or find) this site's chat so history is scoped to us.
          void this.openSiteChat();
          resolve();
        });
      };

      win.addEventListener('message', onMessage);
      guard.poll = setInterval(() => {
        if(popup.closed) {
          finish(() => reject(new Error('The PhantomOps login window was closed before it finished.')));
        }
      }, this.popupPollMs);
    });
  }

  async logout(): Promise<void> {
    const token = this.token;
    this.signOutLocal();
    if(!token) return;
    try {
      await this.fetchImpl(`${this.baseUrl}/api/widget/logout`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${token}`}
      });
    } catch{
      // best effort: the token expires on its own
    }
  }

  // ------------------------------------------------------------- http
  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const token = this.token;
    if(!token) throw new Error('not signed in');

    const epoch = this.epoch;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {...(init.headers as Record<string, string> || {}), Authorization: `Bearer ${token}`}
    });

    if(epoch !== this.epoch) throw new Error('stale');

    if(response.status === 401) {
      this.signOutLocal('Your PhantomOps session ended. Log in again.');
      throw new Error('unauthorized');
    }

    if(response.status === 403) {
      const detail = await response.clone().json().catch((): null => null);
      if(detail?.detail?.code === 'widget_site_refused') {
        this.signOutLocal(detail.detail.message || 'Your organisation does not allow PhantomOps here.');
        throw new Error('unauthorized');
      }
    }

    return response;
  }

  /** Open (or find) this site's chat. Idempotent server-side. */
  async openSiteChat(): Promise<void> {
    const epoch = this.epoch;
    try {
      const response = await this.call('/api/widget/session', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({app_name: 'PhantomChat Code'})
      });
      if(!response.ok) return;

      const body = await response.json() as {session_id?: number};
      if(epoch !== this.epoch || this.state.busy) return;
      if(typeof body.session_id === 'number' && body.session_id !== this.state.sessionId) {
        this.set({sessionId: body.session_id});
        this.persist();
      }
    } catch{
      // history still works without it; the next send opens the session anyway
    }
  }

  /** Load the thread's history (once per sign-in). */
  async loadHistory(): Promise<void> {
    const epoch = this.epoch;
    try {
      const query = this.state.sessionId ? `?session_id=${this.state.sessionId}` : '';
      const response = await this.call(`/api/chat/history${query}`);
      if(!response.ok) return;

      const body = await response.json() as {messages?: any[]; session_id?: number};
      if(epoch !== this.epoch || this.state.busy) return;

      const messages: PhantomOpsMessage[] = (body.messages || [])
      .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' &&
        m.content && m.content !== '__interrupted__')
      .map((m) => ({id: this.nextMessageId++, role: m.role, text: m.content}));

      this.set({
        messages,
        sessionId: typeof body.session_id === 'number' ? body.session_id : this.state.sessionId
      });
      this.persist();
    } catch{}
  }

  // ------------------------------------------------------------- turn
  /**
   * Send one turn and stream it into `state.messages`. Resolves when the turn
   * is over; a transport failure is surfaced as `state.error` rather than
   * thrown, because the UI has nothing better to do with it.
   */
  async send(text: string): Promise<void> {
    const content = text.trim();
    if(!content || this.state.busy || !this.token) return;

    const epoch = this.epoch;
    const alive = () => epoch === this.epoch;

    const userMessage: PhantomOpsMessage = {id: this.nextMessageId++, role: 'user', text: content};
    this.set({
      messages: [...this.state.messages, userMessage],
      busy: true,
      error: null,
      activity: 'Thinking…',
      gate: null
    });

    let assistantId: number | null = null;
    let streamed = '';

    try {
      const response = await this.call('/api/chat/message', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          content,
          session_id: this.state.sessionId,
          app_name: 'PhantomChat Code'
        })
      });

      if(!response.ok || !response.body) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(typeof detail.detail === 'string' ? detail.detail : `PhantomOps could not answer (${response.status}).`);
      }

      for await (const event of readPhantomOpsEvents(response.body)) {
        if(!alive()) break;

        if(event.status === 'streaming') {
          streamed += String(event.content ?? '');
          assistantId = this.upsertAssistant(assistantId, streamed);
          continue;
        }

        if(event.status === 'complete') {
          const final = String(event.response ?? streamed);
          assistantId = this.upsertAssistant(assistantId, final);
          continue;
        }

        this.state = applyPhantomOpsEvent(this.state, event);
        this.emit();
      }
    } catch(error) {
      const message = (error as Error)?.message;
      if(alive() && message !== 'unauthorized' && message !== 'stale') {
        this.set({error: message || 'PhantomOps could not answer.'});
      }
    } finally {
      if(alive()) this.set({busy: false, activity: null});
    }
  }

  private upsertAssistant(id: number | null, text: string): number {
    if(id === null) {
      const message: PhantomOpsMessage = {id: this.nextMessageId++, role: 'assistant', text};
      this.set({messages: [...this.state.messages, message]});
      return message.id;
    }

    this.set({messages: this.state.messages.map((m) => m.id === id ? {...m, text} : m)});
    return id;
  }

  /** Answer a tool/permission gate. */
  async confirmGate(action: 'approve' | 'deny'): Promise<void> {
    const gate = this.state.gate;
    if(!gate) return;
    this.set({gate: null});
    try {
      await this.call('/api/chat/confirm', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({gate_id: gate.gateId, action})
      });
    } catch{}
  }

  /** Ask the server to stop the running turn. */
  async stop(): Promise<void> {
    try {
      const query = this.state.sessionId ? `?session_id=${this.state.sessionId}` : '';
      await this.call(`/api/chat/stop${query}`, {method: 'POST'});
    } catch{}
  }
}
