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
 * else's text, and is then screened by the engine's threat judge.
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
  | {event: 'turn'; turnId: string; data: unknown};

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
}

export interface EngineLike {
  personas: {
    list(): Promise<string[]>;
    exists(name: string): Promise<boolean>;
    create(name: string, options?: unknown): Promise<unknown>;
  };
  persona(name: string): PersonaLike;
}

export interface HostInfo {
  phantombot: string;
  pi: string;
  bun: string;
}

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

export function createDispatcher(engine: EngineLike, info: HostInfo, emit: (message: HostMessage) => void) {
  const turns = new Map<string, TurnStreamLike>();

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
        const stream = persona.turn(turnOptions(p.options));
        turns.set(id, stream);
        try {
          for await (const data of stream) emit({event: 'turn', turnId: id, data});
          return await stream.result();
        } finally {
          turns.delete(id);
        }
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
        return engine.persona(personaName(p)).askJson(options);
      }
      case 'persona.decide': {
        const options = optRecord(p, 'options');
        if(!options) throw invalid('options must be an object');
        return engine.persona(personaName(p)).decide(options);
      }
      case 'turn.cancel': {
        const stream = turns.get(turnId(p));
        stream?.cancel();
        return !!stream;
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
    },
    get runningTurns(): number {
      return turns.size;
    }
  };
}
