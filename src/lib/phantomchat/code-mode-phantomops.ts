/*
 * Code Mode ↔ PhantomOps.
 *
 * PhantomChat is a thin client (Andrew, 2026-10-29): no harness, no filesystem,
 * no local engine. A phantom is just a contact, so it needs nothing new on the
 * wire — PhantomOps is the one Code entry that is NOT a Nostr peer, and this
 * module is its whole client.
 *
 * AUTH IS A PHANTOMOPS API KEY (`pok_…`), not a widget login.
 *
 *   Account settings → API keys  →  paste the key here
 *   then  →  GET  /api/chat/history          (the key's own chat, id echoed back)
 *            POST /api/chat/message          (newline-delimited JSON stream)
 *            POST /api/chat/stop
 *            POST /api/chat/confirm          (tool/permission gate)
 *
 * `pok_` is a full-privilege credential for its owner: `get_chat_user` resolves
 * it to the owner's user, so every `/api/chat/*` route accepts it directly —
 * the same phantom, history, memory and skills the PWA gets. It is NOT a
 * widget token, so no site-origin pinning and no host-input policy apply, and
 * no login popup, `postMessage` hand-off or origin claim is involved at all.
 * The key is the credential the phantomops gateway (`/api/v1`) uses too; this
 * client just talks to the PWA chat routes because they stream status events
 * and resolve gates, which the OpenAI-shaped gateway cannot express.
 *
 * Two consequences worth stating:
 *
 *  1. The KEY IS A SECRET. It is a long-lived credential, so it is kept in
 *     localStorage (a launch-scoped store would mean pasting it every start),
 *     never rendered back in full, and cleared by Disconnect. Revoking it in
 *     PhantomOps is what actually kills it — there is no session to expire.
 *  2. HISTORY IS SERVER-SIDE. `/api/chat/history` resolves the key owner's
 *     most recent chat and echoes its id back; the client adopts that id so
 *     the next turn continues the thread instead of opening a new one.
 *
 * Everything with a clock, storage or fetch is injectable, so the protocol is
 * unit-testable without a browser or a live tenant.
 */

/** Canonical PhantomOps base URL (same one the PWA and opencode config use). */
export const PHANTOMOPS_BASE_URL = 'https://phantomops.app';

/** Prefix of every PhantomOps user API key. */
export const PHANTOMOPS_API_TOKEN_PREFIX = 'pok_';

/** Key the API token lives under in local storage. */
export const PHANTOMOPS_TOKEN_STORAGE_KEY = 'phantomops.code-mode.api-token';

/** Shortest plausible key body, so an obvious paste error is caught locally. */
const API_TOKEN_MIN_LENGTH = 20;

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
  /** Server-side chat id this key's thread lives in, once known. */
  sessionId: number | null;
}

export type PhantomOpsStreamEvent = {status: string} & Record<string, unknown>;

export interface PhantomOpsDeps {
  baseUrl?: string;
  /** Browser fetch. */
  fetch?: typeof fetch;
  /** localStorage-shaped store. `null` = memory only. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

/**
 * Is this a PhantomOps API key?
 *
 * Deliberately loose: the prefix plus a sane minimum length. The server owns
 * the real format (`pok_<12 hex>_<body>`) and answers 401 for anything it does
 * not mint, so a stricter client-side pattern would only risk refusing a key
 * minted after this shipped.
 */
export function isPhantomOpsApiToken(value: string | null | undefined): boolean {
  if(typeof value !== 'string') return false;
  const token = value.trim();
  return token.startsWith(PHANTOMOPS_API_TOKEN_PREFIX) && token.length >= API_TOKEN_MIN_LENGTH;
}

/** `pok_ab12cd34ef56_…` → `pok_ab12cd34ef56_……  ····` for display. Never the body. */
export function maskPhantomOpsApiToken(token: string | null | undefined): string {
  if(!token) return '';
  const parts = token.trim().split('_');
  if(parts.length >= 2) return `${parts[0]}_${parts[1]}_…`;
  return `${token.slice(0, 4)}…`;
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

/** A readable reason out of a failed response body, whatever shape it is. */
async function errorDetail(response: Response): Promise<string | null> {
  try {
    const body = await response.clone().json() as any;
    const detail = body?.detail;
    if(typeof detail === 'string' && detail) return detail;
    if(detail && typeof detail.message === 'string' && detail.message) return detail.message;
  } catch{}
  return null;
}

/**
 * Thin PhantomOps chat client. Owns the API key, the chat id and the streaming
 * turn; the UI just renders `state`.
 */
export default class PhantomOpsClient {
  private baseUrl: string;
  private fetchImpl: typeof fetch;
  private storage: PhantomOpsDeps['storage'];

  private token: string | null = null;
  private epoch = 0;
  private nextMessageId = 1;
  private listeners = new Set<(state: PhantomOpsState) => void>();

  public state: PhantomOpsState = PhantomOpsClient.emptyState();

  constructor(deps: PhantomOpsDeps = {}) {
    this.baseUrl = (deps.baseUrl || PHANTOMOPS_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = deps.fetch || (fetch.bind(globalThis) as typeof fetch);
    this.storage = deps.storage === undefined ? PhantomOpsClient.defaultStorage() : deps.storage;
    this.restore();
  }

  private static emptyState(): PhantomOpsState {
    return {signedIn: false, busy: false, activity: null, error: null, messages: [], gate: null, sessionId: null};
  }

  private static defaultStorage(): PhantomOpsDeps['storage'] {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
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

  // ------------------------------------------------------------- api key
  /** Restore the stored key. A key outlives the launch; it has no local expiry. */
  private restore(): void {
    if(!this.storage) return;
    try {
      const raw = this.storage.getItem(PHANTOMOPS_TOKEN_STORAGE_KEY);
      if(!raw) return;
      if(!isPhantomOpsApiToken(raw)) {
        this.storage.removeItem(PHANTOMOPS_TOKEN_STORAGE_KEY);
        return;
      }
      this.token = raw.trim();
      this.state = {...this.state, signedIn: true};
    } catch{
      this.storage.removeItem(PHANTOMOPS_TOKEN_STORAGE_KEY);
    }
  }

  private persist(): void {
    if(!this.storage || !this.token) return;
    try {
      this.storage.setItem(PHANTOMOPS_TOKEN_STORAGE_KEY, this.token);
    } catch{}
  }

  private resetAccount(patch: Partial<PhantomOpsState> = {}): void {
    this.epoch++;
    this.state = {...PhantomOpsClient.emptyState(), ...patch};
    this.emit();
  }

  private signOutLocal(error: string | null = null): void {
    this.token = null;
    try {
      this.storage?.removeItem(PHANTOMOPS_TOKEN_STORAGE_KEY);
    } catch{}
    this.resetAccount({error});
  }

  isSignedIn(): boolean {
    return !!this.token;
  }

  /** Masked form of the key in use, for the connected header. */
  tokenHint(): string {
    return maskPhantomOpsApiToken(this.token);
  }

  // ------------------------------------------------------------- connect
  /**
   * Adopt an API key and open the owner's chat. The history read is the proof
   * the key works: 401 means the key is wrong or revoked, and nothing is
   * persisted — the caller shows the reason, it never fails silently.
   */
  async connect(token: string): Promise<void> {
    const candidate = (token || '').trim();
    if(!candidate) {
      const error = 'Paste your PhantomOps API key first.';
      this.set({error});
      throw new Error(error);
    }
    if(!isPhantomOpsApiToken(candidate)) {
      const error = `That does not look like a PhantomOps API key — they start with ${PHANTOMOPS_API_TOKEN_PREFIX}.`;
      this.set({error});
      throw new Error(error);
    }

    // token BEFORE the reset: the reset emits, and the UI reads the key hint
    // from the same state it renders, so an emit with no token shows a blank.
    this.token = candidate;
    this.resetAccount({signedIn: true});

    try {
      await this.loadHistory();
    } catch(error) {
      const message = (error as Error)?.message;
      if(message === 'unauthorized') {
        throw new Error('PhantomOps rejected that API key. Check it, or mint a new one.');
      }
      this.signOutLocal(message || 'PhantomOps could not be reached.');
      throw new Error(message || 'PhantomOps could not be reached.');
    }

    this.persist();
    this.set({error: null});
  }

  /**
   * Forget the key locally. There is no session to revoke: the key is the
   * credential, so "disconnect" is this browser forgetting it — the key itself
   * stays valid until it is revoked in PhantomOps.
   */
  async logout(): Promise<void> {
    this.signOutLocal();
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
      this.signOutLocal('PhantomOps rejected the API key. Paste a valid one, or mint a new one.');
      throw new Error('unauthorized');
    }

    return response;
  }

  /**
   * Load the owner's most recent chat and adopt its id.
   *
   * `/api/chat/history` resolves the newest session when none is named and
   * echoes it back (its own doc says the client MUST adopt it, or the next turn
   * opens a new session and strands the conversation). Throws on 401 so
   * `connect` can report a bad key; a plain transport failure is surfaced to
   * the caller too, but does not leave a half-connected client behind.
   */
  async loadHistory(): Promise<void> {
    const epoch = this.epoch;
    const response = await this.call('/api/chat/history');
    if(!response.ok) {
      throw new Error(await errorDetail(response) || `PhantomOps could not answer (${response.status}).`);
    }

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
        const detail = await errorDetail(response);
        throw new Error(detail || `PhantomOps could not answer (${response.status}).`);
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
        body: JSON.stringify({gate_id: gate.gateId, action: action === 'approve' ? 'approve' : 'cancel'})
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
