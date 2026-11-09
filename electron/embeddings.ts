/*
 * PhantomChat desktop: the Embeddings setting (Settings > Specialized Models).
 *
 * One embeddings provider for EVERY persona of the bundled phantombot engine,
 * so its memory search is hybrid (keywords + meaning) like a CLI persona set
 * up with `phantombot embedding`. Saved once here, written into each persona
 * with `persona.configure({embeddings})`, and into each persona created later
 * (main.ts calls `applyTo` after a successful `personas.create`).
 *
 * The engine runs no heartbeat, so the notes are embedded from here:
 * `refreshAll` calls `persona.memory.refresh` for every persona after a save
 * and on main's timer. It is incremental, so a quiet persona costs nothing.
 *
 * The key follows the Decision Model's rules (decisionModel.ts): it stays in
 * main, encrypted with safeStorage; the page only learns `hasKey`. A stored
 * key is reused only for the same provider AND endpoint: a key for one
 * endpoint is never sent to another.
 *
 * No Electron import, so vitest drives it with a fake bridge and cipher.
 */
import {isPlatformPersona, platformPersonas} from './platformModels';
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import type {BridgeCall, KeyCipher} from './decisionModel';

/**
 * 'gemini', 'openai-compatible' (your base URL), or a Pi provider id from the
 * engine's `embeddings.providers()` (its own fixed endpoint, e.g. 'openai').
 */
export type EmbeddingsProvider = string;
/** What an engine without `embeddings.providers()` offers. */
export const BUILTIN_EMBEDDINGS_PROVIDERS: readonly EmbeddingsProviderInfo[] = [
  {id: 'gemini', label: 'Google Gemini', needsBaseUrl: false, keyOptional: false},
  {id: 'openai-compatible', label: 'OpenAI Compatible', needsBaseUrl: true, keyOptional: true}
];

export interface EmbeddingsProviderInfo {
  id: string;
  label: string;
  needsBaseUrl: boolean;
  keyOptional: boolean;
}
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';

/** What the renderer sees. Never the key. */
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

export type EmbeddingsSaveResult =
  | {ok: true; state: EmbeddingsState; applied: number; failed: {persona: string; error: string}[]}
  | {ok: false; error: string; state: EmbeddingsState};

interface Stored {
  enabled: boolean;
  provider: EmbeddingsProvider;
  baseUrl: string;
  model: string;
  dims: number;
  /** base64 of safeStorage.encryptString. */
  key?: string;
}

const MAX_KEY_CHARS = 4096;
const MAX_MODEL_CHARS = 512;
const MAX_URL_CHARS = 2048;

/** A provider id the engine may know; the engine is the one that validates it. */
export function isEmbeddingsProvider(value: unknown): value is EmbeddingsProvider {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

/** Only bring-your-own endpoints take a base URL; or may go without a key. */
const ownEndpoint = (provider: string) => provider === 'openai-compatible';

const endpoint = (s: {provider: string; baseUrl: string}) =>
  ownEndpoint(s.provider) ? `${s.provider}|${s.baseUrl.trim().replace(/\/+$/, '')}` : s.provider;

/** Anything at all to a valid stored setting, or undefined (never saved / unreadable). */
export function normalizeStored(raw: unknown): Stored | undefined {
  if(typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  if(typeof s.enabled !== 'boolean' || !isEmbeddingsProvider(s.provider)) return undefined;
  const baseUrl = ownEndpoint(s.provider) && typeof s.baseUrl === 'string' ? s.baseUrl : '';
  const model = typeof s.model === 'string' && s.model.trim() && s.model.length <= MAX_MODEL_CHARS ?
    s.model.trim() :
    (s.provider === 'gemini' ? GEMINI_EMBEDDING_MODEL : '');
  if(!model) return undefined;
  const dims = typeof s.dims === 'number' && Number.isInteger(s.dims) && s.dims > 0 ? s.dims : 0;
  return {
    enabled: s.enabled,
    provider: s.provider,
    baseUrl,
    model,
    dims,
    ...(typeof s.key === 'string' && s.key ? {key: s.key} : {})
  };
}

/** The `persona.configure` payload. Off is provider "none", which keeps the provider blocks. */
export function configurePayload(s: Omit<Stored, 'key'>, apiKey?: string) {
  if(!s.enabled) return {embeddings: {provider: 'none'}};
  if(!ownEndpoint(s.provider)) {
    // Gemini, or a Pi provider: the engine knows its endpoint.
    return {embeddings: {provider: s.provider, apiKey, model: s.model, ...(s.dims ? {dims: s.dims} : {})}};
  }
  return {embeddings: {
    provider: 'openai-compatible',
    baseUrl: s.baseUrl,
    model: s.model,
    ...(s.dims ? {dims: s.dims} : {}),
    // Omitted = no key: the engine then removes any stored one.
    ...(apiKey ? {apiKey} : {})
  }};
}

export interface EmbeddingsSettingsOptions {
  /** <userData>/embeddings.json */
  file: string;
  call: BridgeCall;
  cipher: KeyCipher;
  log?: (line: string) => void;
}

export class EmbeddingsSettings {
  #stored: Stored | undefined;
  #saving: Promise<unknown> = Promise.resolve();
  #refreshing: Promise<void> | undefined;

  constructor(private readonly opts: EmbeddingsSettingsOptions) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(opts.file, 'utf8'));
    } catch{
      raw = undefined;
    }
    this.#stored = normalizeStored(raw);
  }

  /** The engine's provider list (filtered to embedding providers); the built-in two on an older engine. */
  async providers(): Promise<EmbeddingsProviderInfo[]> {
    const res = await this.opts.call('embeddings.providers', {});
    if(!res.ok || !Array.isArray(res.value)) return [...BUILTIN_EMBEDDINGS_PROVIDERS];
    const list = (res.value as any[]).filter((p) => p && isEmbeddingsProvider(p.id) && typeof p.label === 'string')
    .map((p) => ({id: p.id, label: p.label, needsBaseUrl: !!p.needsBaseUrl, keyOptional: !!p.keyOptional}));
    return list.length ? list : [...BUILTIN_EMBEDDINGS_PROVIDERS];
  }

  state(): EmbeddingsState {
    const s = this.#stored;
    return {
      configured: s !== undefined,
      enabled: s?.enabled ?? false,
      provider: s?.provider ?? 'gemini',
      baseUrl: s?.baseUrl ?? '',
      model: s?.model ?? GEMINI_EMBEDDING_MODEL,
      dims: s?.dims ?? 0,
      hasKey: this.#key() !== undefined,
      canStoreKey: this.#canStore()
    };
  }

  /** The stored key, only for the same provider and endpoint. */
  #keyFor(provider: string, baseUrl: string): string | undefined {
    const s = this.#stored;
    return s && endpoint(s) === endpoint({provider, baseUrl}) ? this.#key() : undefined;
  }

  /**
   * List the provider's embedding models and, with a model, prove it with a
   * live embed. An empty key uses the stored one for the same endpoint.
   */
  async check(input: unknown): Promise<EmbeddingsCheck> {
    const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    if(!isEmbeddingsProvider(i.provider)) throw new Error('unknown provider');
    const baseUrl = ownEndpoint(i.provider) && typeof i.baseUrl === 'string' ? i.baseUrl.trim() : '';
    if(baseUrl.length > MAX_URL_CHARS) throw new Error('base URL too long');
    const typed = typeof i.apiKey === 'string' ? i.apiKey.trim() : '';
    if(typed.length > MAX_KEY_CHARS) throw new Error('key too long');
    const model = typeof i.model === 'string' ? i.model.trim() : '';
    if(model.length > MAX_MODEL_CHARS) throw new Error('model too long');
    if(ownEndpoint(i.provider) && !baseUrl) return {status: 'unchecked', detail: 'enter the base URL', models: []};
    const key = typed || this.#keyFor(i.provider, baseUrl);
    const res = await this.opts.call('embeddings.check', {
      provider: i.provider,
      ...(baseUrl ? {baseUrl} : {}),
      ...(key ? {apiKey: key} : {}),
      ...(model ? {model} : {})
    });
    if(!res.ok) throw new Error(res.error.message);
    const raw = res.value as any;
    const status = raw?.status === 'verified' || raw?.status === 'failed' ? raw.status : 'unchecked';
    const models = Array.isArray(raw?.models) ? raw.models.filter((m: unknown): m is string => typeof m === 'string') : [];
    const dims = typeof raw?.dims === 'number' && Number.isInteger(raw.dims) && raw.dims > 0 ? raw.dims : undefined;
    return {status, detail: typeof raw?.detail === 'string' ? raw.detail : '', models, ...(dims ? {dims} : {})};
  }

  /**
   * Save, then write the setting into every persona one after another
   * (`configure` restarts a running channel). Turning it on needs a live
   * embed with the chosen model first: a failed one saves nothing.
   */
  save(input: unknown): Promise<EmbeddingsSaveResult> {
    const run = this.#saving.then(() => this.#save(input));
    this.#saving = run.catch(() => {});
    return run;
  }

  async #save(input: unknown): Promise<EmbeddingsSaveResult> {
    const fail = (error: string): EmbeddingsSaveResult => ({ok: false, error, state: this.state()});
    const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    if(typeof i.enabled !== 'boolean') return fail('enabled must be true or false');
    if(!isEmbeddingsProvider(i.provider)) return fail('Choose a provider');
    const provider = i.provider;
    const baseUrl = ownEndpoint(provider) && typeof i.baseUrl === 'string' ? i.baseUrl.trim().replace(/\/+$/, '') : '';
    if(baseUrl.length > MAX_URL_CHARS) return fail('That base URL is too long');
    const model = (typeof i.model === 'string' ? i.model.trim() : '') || (provider === 'gemini' ? GEMINI_EMBEDDING_MODEL : '');
    if(!model || model.length > MAX_MODEL_CHARS) return fail('Choose a model');
    const typed = typeof i.apiKey === 'string' ? i.apiKey.trim() : '';
    if(typed.length > MAX_KEY_CHARS) return fail('That key is too long');
    const key = typed || this.#keyFor(provider, baseUrl);

    let dims = this.#stored && endpoint(this.#stored) === endpoint({provider, baseUrl}) && this.#stored.model === model ?
      this.#stored.dims : 0;
    if(i.enabled) {
      if(!ownEndpoint(provider) && !key) return fail('Enter an API key');
      if(ownEndpoint(provider) && !baseUrl) return fail('Enter the base URL');
      let verdict: EmbeddingsCheck;
      try {
        verdict = await this.check({provider, baseUrl, apiKey: key ?? '', model});
      } catch(err) {
        return fail(`Could not check the model: ${err instanceof Error ? err.message : String(err)}`);
      }
      if(verdict.status !== 'verified') return fail(`The model did not embed (${verdict.detail})`);
      dims = verdict.dims ?? 0;
    }

    // Persist BEFORE applying: a persona created while this runs inherits it.
    const next: Stored = {enabled: i.enabled, provider, baseUrl, model, dims};
    const encrypted = key && this.#canStore() ? this.#encrypt(key) : undefined;
    if(encrypted) next.key = encrypted;
    try {
      this.#write(next);
    } catch(err) {
      return fail(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.#stored = next;

    const personas = await this.opts.call('personas.list', {});
    if(!personas.ok) return fail(`Saved, but could not list personas: ${personas.error.message}`);
    const names = Array.isArray(personas.value) ? personas.value.filter((n): n is string => typeof n === 'string') : [];
    const config = configurePayload(next, key);
    const failed: {persona: string; error: string}[] = [];
    let applied = 0;
    // PhantomOps contacts take this model from their server, never from here.
    const platform = await platformPersonas(this.opts.call, names);
    for(const persona of names.filter((n) => !platform.has(n))) {
      const res = await this.opts.call('persona.configure', {persona, config});
      if(res.ok) applied++;
      else failed.push({persona, error: res.error.message});
    }
    // Embed the notes now, in the background: a large memory takes a while,
    // and the save itself is done.
    if(next.enabled) void this.refreshAll();
    return {ok: true, state: this.state(), applied, failed};
  }

  /**
   * Give a newly created persona the saved setting. Never throws: a failure
   * is logged and the persona keeps keyword-only search.
   */
  async applyTo(persona: string): Promise<void> {
    await this.#saving;
    const s = this.#stored;
    if(!s) return;
    if(await isPlatformPersona(this.opts.call, persona)) return;
    const key = this.#key();
    if(s.enabled && !ownEndpoint(s.provider) && !key) {
      this.opts.log?.(`embeddings: ${persona} not configured (no stored key)`);
      return;
    }
    const res = await this.opts.call('persona.configure', {persona, config: configurePayload(s, key)});
    if(!res.ok) this.opts.log?.(`embeddings: ${persona} failed: ${res.error.message}`);
  }

  /**
   * Embed changed notes of every persona (`persona.memory.refresh`), one at a
   * time. A refresh already running is joined, not doubled. Off: nothing.
   */
  refreshAll(): Promise<void> {
    if(!this.#stored?.enabled) return Promise.resolve();
    this.#refreshing ??= (async() => {
      try {
        const personas = await this.opts.call('personas.list', {});
        const names = personas.ok && Array.isArray(personas.value) ?
          personas.value.filter((n): n is string => typeof n === 'string') : [];
        for(const persona of names) {
          const res = await this.opts.call('persona.memory.refresh', {persona});
          if(!res.ok) this.opts.log?.(`embeddings: refresh ${persona} failed: ${res.error.message}`);
          else if((res.value as any)?.error) this.opts.log?.(`embeddings: refresh ${persona}: ${(res.value as any).error}`);
        }
      } finally {
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing;
  }

  #canStore(): boolean {
    try {
      return this.opts.cipher.available();
    } catch{
      return false;
    }
  }

  #encrypt(key: string): string | undefined {
    try {
      return this.opts.cipher.encrypt(key).toString('base64');
    } catch{
      return undefined;
    }
  }

  #key(): string | undefined {
    const enc = this.#stored?.key;
    if(!enc || !this.#canStore()) return undefined;
    try {
      return this.opts.cipher.decrypt(Buffer.from(enc, 'base64')) || undefined;
    } catch{
      return undefined;
    }
  }

  #write(next: Stored): void {
    mkdirSync(dirname(this.opts.file), {recursive: true});
    const tmp = `${this.opts.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', {mode: 0o600});
    renameSync(tmp, this.opts.file);
  }
}
