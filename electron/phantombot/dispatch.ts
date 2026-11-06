/*
 * The phantombot host's request dispatcher: one JSON request in, one JSON
 * response out, plus `event` messages while a turn streams.
 *
 * Pure on purpose. It imports nothing from phantombot or Bun, so vitest runs
 * it against a fake engine, and the compiled host (host.ts) hands it the real
 * one. Arguments are rebuilt field by field from what the engine documents, so
 * an unknown key from the page never reaches the engine.
 *
 * Trust: turns default to `source: "principal"`. The only caller is the
 * principal's own PhantomChat, behind the main process's origin check.
 * `"untrusted"` stays available for a future feature that relays someone
 * else's text, and is then screened by the engine's threat judge. That
 * caller is the live site, so a PWA deploy (no desktop release) can run
 * principal turns with `tools: "full"`; see docs/ELECTRON-DESKTOP.md.
 */
import {isPhantombotMethod, type PhantombotMethod} from './methods';

export interface HostRequest {
  id: number;
  method: PhantombotMethod;
  params: Record<string, unknown>;
}

export type HostMessage =
  | {id: number; result: unknown}
  | {id: number; error: {code: string; message: string}}
  | {event: 'turn'; turnId: string; data: unknown}
  | {event: 'phantomchat'; persona: string; data: unknown};

/** The slice of a TurnStream the dispatcher uses. */
export interface TurnStreamLike extends AsyncIterable<unknown> {
  result(): Promise<unknown>;
  cancel(): void;
}

/** The slice of the engine's Persona the dispatcher uses. */
export interface PersonaLike {
  configure(settings: unknown): Promise<void>;
  secrets: {
    set(name: string, value: string): Promise<void>;
    has(name: string): Promise<boolean>;
    delete(name: string): Promise<void>;
  };
  memory: {
    search(query: string, options?: unknown): Promise<unknown>;
    capture(text: string, options?: unknown): Promise<void>;
  };
  turn(options: unknown): TurnStreamLike;
  askJson(options: unknown): Promise<unknown>;
  decide(options: unknown): Promise<unknown>;
  phantomchat: {
    info(): Promise<unknown>;
    allow(npub: string, options?: unknown): Promise<unknown>;
    disallow(npub: string): Promise<unknown>;
    start(options?: unknown): Promise<unknown>;
    stop(): Promise<void>;
    status(): unknown;
    onStatus(listener: (status: unknown) => void): () => void;
  };
}

/**
 * Runs one Pi built-in tool on this PC (host.ts wires Pi's own factories).
 * `signal` aborts it: tools.cancel, or the host shutting down.
 */
export type ToolRunner = (tool: LocalToolName, args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolRunResult>;

export const LOCAL_TOOL_NAMES = ['bash', 'read', 'write', 'edit', 'ls', 'find', 'grep'] as const;
export type LocalToolName = typeof LOCAL_TOOL_NAMES[number];

export interface ToolRunResult {
  status: 'ok' | 'error' | 'cancelled' | 'timeout';
  output: string;
  exit?: number;
  truncated?: boolean;
}

/** Default and ceiling for one tool run, as the Local tools protocol sets them. */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
export const MAX_TOOL_TIMEOUT_MS = 600_000;

export interface EngineLike {
  voiceModels?: {providers(): Promise<unknown>; check(input: any): Promise<unknown>};
  personas: {
    list(): Promise<string[]>;
    exists(name: string): Promise<boolean>;
    create(name: string, options?: unknown): Promise<unknown>;
    delete(name: string): Promise<boolean>;
  };
  providers: {
    list(): Promise<unknown>;
    check(provider: string, apiKey: string, options?: unknown): Promise<unknown>;
  };
  persona(name: string): PersonaLike;
}

export interface HostInfo {
  phantombot: string;
  pi: string;
  bun: string;
}

/**
 * Model calls (turn, askJson, decide) allowed at once. The bridge is reachable
 * by any PWA deploy, so a retry loop or per-conversation fan-out on the page
 * must not become unbounded spend on the user's provider keys.
 */
export const MAX_RUNNING_TURNS = 4;

/**
 * Local tool runs (tools.run) allowed at once. Each one is a real process on the
 * principal's PC that may live up to MAX_TOOL_TIMEOUT_MS, so a page loop must not
 * fan out into an unbounded number of them.
 */
export const MAX_RUNNING_TOOLS = 8;

export class BridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const invalid = (message: string) => new BridgeError('invalid_argument', message);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(params: Record<string, unknown>, key: string, max = 1_000_000): string {
  const value = params[key];
  if(typeof value !== 'string' || !value || value.length > max) throw invalid(`${key} must be a non-empty string`);
  return value;
}

function optStr(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if(value === undefined) return undefined;
  if(typeof value !== 'string') throw invalid(`${key} must be a string`);
  return value;
}

function optBool(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if(value === undefined) return undefined;
  if(typeof value !== 'boolean') throw invalid(`${key} must be a boolean`);
  return value;
}

function optRecord(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = params[key];
  if(value === undefined) return undefined;
  if(!isRecord(value)) throw invalid(`${key} must be an object`);
  return value;
}

function personaName(params: Record<string, unknown>): string {
  // The engine validates the name too; this keeps paths and odd bytes out early.
  const name = str(params, 'persona', 64);
  if(!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw invalid('persona must be letters, digits, - or _');
  return name;
}

function npubOf(params: Record<string, unknown>): string {
  const npub = str(params, 'npub', 128);
  if(!/^npub1[02-9ac-hj-np-z]{58}$/.test(npub)) throw invalid('npub must be an npub1… key');
  return npub;
}

function optStrings(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if(value === undefined) return undefined;
  if(!Array.isArray(value) || value.length > 32 || !value.every((v) => typeof v === 'string' && v.length <= 512)) {
    throw invalid(`${key} must be a list of strings`);
  }
  return [...value];
}

function callId(params: Record<string, unknown>): string {
  const id = str(params, 'callId', 128);
  if(!/^[\w.:-]+$/.test(id)) throw invalid('callId must be letters, digits, ., :, - or _');
  return id;
}

function turnId(params: Record<string, unknown>): string {
  const id = str(params, 'turnId', 128);
  if(!/^[\w.:-]+$/.test(id)) throw invalid('turnId must be letters, digits, ., :, - or _');
  return id;
}

/** Only the keys the engine documents for a turn, with `source` defaulting to principal. */
function turnOptions(raw: unknown): Record<string, unknown> {
  if(!isRecord(raw)) throw invalid('options must be an object');
  const source = raw.source ?? 'principal';
  if(source !== 'principal' && source !== 'untrusted') throw invalid('source must be "principal" or "untrusted"');
  const tools = raw.tools;
  if(tools !== undefined && tools !== 'none' && tools !== 'full' &&
    !(isRecord(tools) && Array.isArray(tools.allow) && tools.allow.every((t) => typeof t === 'string'))) {
    throw invalid('tools must be "none", "full" or {allow: string[]}');
  }
  const options: Record<string, unknown> = {message: str(raw, 'message'), source};
  for(const key of ['conversation', 'workingDir', 'instructions'] as const) {
    const value = optStr(raw, key);
    if(value !== undefined) options[key] = value;
  }
  const history = optBool(raw, 'history');
  if(history !== undefined) options.history = history;
  if(tools !== undefined) options.tools = isRecord(tools) ? {allow: [...(tools.allow as string[])]} : tools;
  return options;
}

function errorOf(err: unknown): {code: string; message: string} {
  if(err instanceof BridgeError) return {code: err.code, message: err.message};
  const code = isRecord(err) && typeof err.code === 'string' ? err.code : 'internal';
  const message = err instanceof Error ? err.message : String(err);
  return {code, message};
}

/** Validate a decoded line. Throws BridgeError with the id when it has one. */
export function parseRequest(value: unknown): HostRequest {
  if(!isRecord(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id)) {
    throw invalid('request needs a numeric id');
  }
  if(!isPhantombotMethod(value.method)) throw invalid(`unknown method ${String(value.method)}`);
  const params = value.params ?? {};
  if(!isRecord(params)) throw invalid('params must be an object');
  return {id: value.id, method: value.method, params};
}

export function createDispatcher(
  engine: EngineLike,
  info: HostInfo,
  emit: (message: HostMessage) => void,
  runTool?: ToolRunner
) {
  const turns = new Map<string, TurnStreamLike>();
  const tools = new Map<string, AbortController>();
  /** One status subscription per persona, so the page hears restarts and failures. */
  const watched = new Map<string, () => void>();
  let modelCalls = 0;

  function watch(name: string, persona: PersonaLike): void {
    if(watched.has(name)) return;
    watched.set(name, persona.phantomchat.onStatus((data) => emit({event: 'phantomchat', persona: name, data})));
  }

  function unwatch(name: string): void {
    watched.get(name)?.();
    watched.delete(name);
  }

  async function runOneTool(p: Record<string, unknown>): Promise<ToolRunResult> {
    if(!runTool) throw new BridgeError('not_supported', 'this host cannot run local tools');
    const id = callId(p);
    if(tools.has(id)) throw invalid(`tool call ${id} is already running`);
    if(tools.size >= MAX_RUNNING_TOOLS) {
      throw new BridgeError('busy', `${MAX_RUNNING_TOOLS} tool calls already running; wait or cancel one`);
    }
    const tool = p.tool;
    if(typeof tool !== 'string' || !(LOCAL_TOOL_NAMES as readonly string[]).includes(tool)) {
      throw invalid(`tool must be one of ${LOCAL_TOOL_NAMES.join(', ')}`);
    }
    const args = optRecord(p, 'args') ?? {};
    const requested = p.timeoutMs;
    if(requested !== undefined && (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0)) {
      throw invalid('timeoutMs must be a positive number');
    }
    const controller = new AbortController();
    tools.set(id, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.min((requested as number) ?? DEFAULT_TOOL_TIMEOUT_MS, MAX_TOOL_TIMEOUT_MS));
    let result: ToolRunResult;
    try {
      result = await runTool(tool as LocalToolName, args, controller.signal);
    } catch(err) {
      result = {status: 'error', output: errorOf(err).message};
    } finally {
      clearTimeout(timer);
      tools.delete(id);
    }
    if(timedOut) return {...result, status: 'timeout'};
    if(controller.signal.aborted) return {...result, status: 'cancelled'};
    return result;
  }

  /** Run one model call under the cap, refusing with `busy` when it is full. */
  async function capped<T>(work: () => Promise<T>): Promise<T> {
    if(modelCalls >= MAX_RUNNING_TURNS) {
      throw new BridgeError('busy', `${MAX_RUNNING_TURNS} model calls already running; wait or cancel one`);
    }
    modelCalls++;
    try {
      return await work();
    } finally {
      modelCalls--;
    }
  }

  async function run(request: HostRequest): Promise<unknown> {
    const p = request.params;
    switch(request.method) {
      case 'info':
        return info;
      case 'personas.list':
        return engine.personas.list();
      case 'personas.exists':
        return engine.personas.exists(personaName(p));
      case 'personas.create':
        await engine.personas.create(personaName(p), optRecord(p, 'options'));
        return null;
      case 'personas.delete': {
        const name = personaName(p);
        unwatch(name);
        return engine.personas.delete(name);
      }
      case 'providers.list':
        return engine.providers.list();
      case 'providers.check': {
        const provider = str(p, 'provider', 64);
        // An empty key is a real question for key-optional providers.
        const apiKey = p.apiKey ?? '';
        if(typeof apiKey !== 'string' || apiKey.length > 64 * 1024) throw invalid('apiKey must be a string');
        const baseUrl = optStr(p, 'baseUrl');
        return engine.providers.check(provider, apiKey, baseUrl === undefined ? undefined : {baseUrl});
      }
      case 'voiceModels.providers':
        if(!engine.voiceModels) throw new BridgeError('not_supported', 'Update the engine for Voice Models');
        return engine.voiceModels.providers();
      case 'voiceModels.check':
        if(!engine.voiceModels) throw new BridgeError('not_supported', 'Update the engine for Voice Models');
        return engine.voiceModels.check(p);
      case 'persona.configure': {
        const config = optRecord(p, 'config');
        if(!config) throw invalid('config must be an object');
        await engine.persona(personaName(p)).configure(config);
        return null;
      }
      case 'persona.secrets.set':
        await engine.persona(personaName(p)).secrets.set(str(p, 'name', 128), str(p, 'value', 64 * 1024));
        return null;
      case 'persona.secrets.has':
        return engine.persona(personaName(p)).secrets.has(str(p, 'name', 128));
      case 'persona.secrets.delete':
        await engine.persona(personaName(p)).secrets.delete(str(p, 'name', 128));
        return null;
      case 'persona.memory.search':
        return engine.persona(personaName(p)).memory.search(str(p, 'query'), optRecord(p, 'options'));
      case 'persona.memory.capture':
        await engine.persona(personaName(p)).memory.capture(str(p, 'text'), optRecord(p, 'options'));
        return null;
      case 'persona.turn': {
        const id = turnId(p);
        if(turns.has(id)) throw invalid(`turn ${id} is already running`);
        const persona = engine.persona(personaName(p));
        const options = turnOptions(p.options);
        return capped(async() => {
          const stream = persona.turn(options);
          turns.set(id, stream);
          try {
            for await (const data of stream) emit({event: 'turn', turnId: id, data});
            return await stream.result();
          } finally {
            turns.delete(id);
          }
        });
      }
      case 'persona.askJson': {
        const raw = optRecord(p, 'options');
        const options = turnOptions(raw);
        const jsonSchema = optRecord(raw!, 'jsonSchema');
        if(jsonSchema) options.jsonSchema = jsonSchema;
        if(raw!.retries !== undefined) {
          if(typeof raw!.retries !== 'number' || !Number.isInteger(raw!.retries) || raw!.retries < 0) {
            throw invalid('retries must be a non-negative integer');
          }
          options.retries = raw!.retries;
        }
        // The page validates the shape it asked for; the engine needs only parsed JSON.
        options.schema = (value: unknown) => value;
        const persona = engine.persona(personaName(p));
        return capped(() => persona.askJson(options));
      }
      case 'persona.decide': {
        const options = optRecord(p, 'options');
        if(!options) throw invalid('options must be an object');
        const persona = engine.persona(personaName(p));
        return capped(() => persona.decide(options));
      }
      case 'turn.cancel': {
        const stream = turns.get(turnId(p));
        stream?.cancel();
        return !!stream;
      }
      case 'persona.phantomchat.info':
        return engine.persona(personaName(p)).phantomchat.info();
      case 'persona.phantomchat.allow': {
        const relays = optStrings(p, 'relays');
        return engine.persona(personaName(p)).phantomchat.allow(npubOf(p), relays ? {relays} : undefined);
      }
      case 'persona.phantomchat.disallow':
        return engine.persona(personaName(p)).phantomchat.disallow(npubOf(p));
      case 'persona.phantomchat.start': {
        const name = personaName(p);
        const persona = engine.persona(name);
        const options: Record<string, unknown> = {};
        const relays = optStrings(p, 'relays');
        if(relays) options.relays = relays;
        const displayName = optStr(p, 'displayName');
        if(displayName !== undefined) options.displayName = displayName.slice(0, 70);
        watch(name, persona);
        return persona.phantomchat.start(options);
      }
      case 'persona.phantomchat.stop':
        await engine.persona(personaName(p)).phantomchat.stop();
        return null;
      case 'persona.phantomchat.status':
        return engine.persona(personaName(p)).phantomchat.status();
      case 'tools.run':
        return runOneTool(p);
      case 'tools.cancel': {
        const controller = tools.get(callId(p));
        controller?.abort();
        return !!controller;
      }
    }
  }

  return {
    /** Handle one decoded line. Always answers, unless the line has no usable id. */
    async handle(value: unknown): Promise<void> {
      let request: HostRequest;
      try {
        request = parseRequest(value);
      } catch(err) {
        if(isRecord(value) && typeof value.id === 'number') emit({id: value.id, error: errorOf(err)});
        return;
      }
      try {
        emit({id: request.id, result: (await run(request)) ?? null});
      } catch(err) {
        emit({id: request.id, error: errorOf(err)});
      }
    },
    /** Cancel every running turn (shutdown). */
    cancelAll(): void {
      for(const stream of turns.values()) stream.cancel();
      for(const controller of tools.values()) controller.abort();
      for(const name of [...watched.keys()]) unwatch(name);
    },
    get runningTurns(): number {
      return turns.size;
    }
  };
}
