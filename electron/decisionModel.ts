/*
 * PhantomChat desktop: the Decision Model setting (issue #449).
 *
 * One decision model (e.g. TypeSafe Jev) for EVERY persona of the bundled
 * phantombot engine: saved once here, written into each persona with
 * `persona.configure({decisionModel})`, and written into each persona created
 * later (main.ts calls `applyTo` after a successful `personas.create`).
 *
 * The key lives here, in main, encrypted with Electron safeStorage. The
 * renderer types it once and only ever learns `hasKey` afterwards: it is
 * never sent back, never in localStorage or IndexedDB. Each persona keeps its
 * own copy in its encrypted vault (the engine's `PHANTOMBOT_JEV_API_KEY`).
 * Where safeStorage cannot really encrypt (no OS keyring, Linux `basic_text`)
 * the key is not kept here at all: personas that exist get it, a persona
 * created later gets the setting without a key until it is entered again.
 *
 * No Electron import, so vitest drives it with a fake bridge and cipher.
 */
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';

export type DecisionModelProvider = 'openrouter' | 'typesafe';
export const DECISION_MODEL_PROVIDERS: readonly DecisionModelProvider[] = ['openrouter', 'typesafe'];
export const DEFAULT_DECISION_MODEL = 'typesafe/jev-1.13';

export type BridgeCall = (method: string, params: Record<string, unknown>) => Promise<
  {ok: true; value: unknown} | {ok: false; error: {code: string; message: string}}
>;

/** safeStorage, narrowed to what this needs. */
export interface KeyCipher {
  /** False when the OS gives no real encryption: the key is then not stored. */
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(encrypted: Buffer): string;
}

/** What the renderer sees. Never the key. */
export interface DecisionModelState {
  /** False until the first save: new personas are left alone. */
  configured: boolean;
  enabled: boolean;
  provider: DecisionModelProvider;
  model: string;
  hasKey: boolean;
  /** False when this PC cannot keep the key encrypted (see header). */
  canStoreKey: boolean;
}

export interface DecisionModelCheck {
  status: 'verified' | 'invalid' | 'unverified';
  detail: string;
  models: string[];
}

export interface DecisionModelSaveInput {
  enabled: boolean;
  provider: string;
  model: string;
  /** Empty or absent: keep the stored key (same provider only). */
  apiKey?: string;
}

export type DecisionModelSaveResult =
  | {ok: true; state: DecisionModelState; applied: number; failed: {persona: string; error: string}[]}
  | {ok: false; error: string; state: DecisionModelState};

interface Stored {
  enabled: boolean;
  provider: DecisionModelProvider;
  model: string;
  /** base64 of safeStorage.encryptString. */
  key?: string;
}

const MAX_KEY_CHARS = 4096;
const MAX_MODEL_CHARS = 200;

export function isDecisionModelProvider(value: unknown): value is DecisionModelProvider {
  return typeof value === 'string' && (DECISION_MODEL_PROVIDERS as readonly string[]).includes(value);
}

/** Anything at all to a valid stored setting, or undefined (never saved / unreadable). */
export function normalizeStored(raw: unknown): Stored | undefined {
  if(typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  if(typeof s.enabled !== 'boolean' || !isDecisionModelProvider(s.provider)) return undefined;
  const model = typeof s.model === 'string' && s.model.trim() && s.model.length <= MAX_MODEL_CHARS ?
    s.model.trim() : DEFAULT_DECISION_MODEL;
  return {
    enabled: s.enabled,
    provider: s.provider,
    model,
    ...(typeof s.key === 'string' && s.key ? {key: s.key} : {})
  };
}

/** The `persona.configure` payload for a setting. Off keeps provider, model and key. */
export function configurePayload(enabled: boolean, provider: DecisionModelProvider, model: string, apiKey?: string) {
  if(!enabled) return {decisionModel: {judge: false, router: false}};
  return {decisionModel: {provider, model, ...(apiKey ? {apiKey} : {}), judge: true, router: true}};
}

export interface DecisionModelSettingsOptions {
  /** <userData>/decision-model.json */
  file: string;
  call: BridgeCall;
  cipher: KeyCipher;
  log?: (line: string) => void;
}

export class DecisionModelSettings {
  #stored: Stored | undefined;
  #saving: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: DecisionModelSettingsOptions) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(opts.file, 'utf8'));
    } catch{
      raw = undefined;
    }
    this.#stored = normalizeStored(raw);
  }

  state(): DecisionModelState {
    const s = this.#stored;
    return {
      configured: s !== undefined,
      enabled: s?.enabled ?? false,
      provider: s?.provider ?? 'openrouter',
      model: s?.model ?? DEFAULT_DECISION_MODEL,
      hasKey: this.#key() !== undefined,
      canStoreKey: this.#canStore()
    };
  }

  /**
   * Check a key and list the provider's decision models. An empty key uses the
   * stored one when it belongs to the same provider.
   */
  async check(provider: unknown, apiKey: unknown): Promise<DecisionModelCheck> {
    if(!isDecisionModelProvider(provider)) throw new Error('unknown provider');
    const typed = typeof apiKey === 'string' ? apiKey.trim() : '';
    if(typed.length > MAX_KEY_CHARS) throw new Error('key too long');
    const key = typed || (this.#stored?.provider === provider ? this.#key() : undefined);
    if(!key) return {status: 'unverified', detail: 'no key to check', models: []};
    const res = await this.opts.call('decisionModels.check', {provider, apiKey: key});
    if(!res.ok) throw new Error(res.error.message);
    const raw = res.value as any;
    const status = raw?.status === 'verified' || raw?.status === 'invalid' ? raw.status : 'unverified';
    const models = Array.isArray(raw?.models) ? raw.models.filter((m: unknown): m is string => typeof m === 'string') : [];
    return {status, detail: typeof raw?.detail === 'string' ? raw.detail : '', models};
  }

  /**
   * Save, then write the setting into every persona, one after another
   * (`configure` restarts a running channel, so N personas = N restarts).
   * A new key is checked first: a rejected key saves nothing.
   */
  save(input: unknown): Promise<DecisionModelSaveResult> {
    const run = this.#saving.then(() => this.#save(input));
    this.#saving = run.catch(() => {});
    return run;
  }

  async #save(input: unknown): Promise<DecisionModelSaveResult> {
    const fail = (error: string): DecisionModelSaveResult => ({ok: false, error, state: this.state()});
    const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    if(typeof i.enabled !== 'boolean') return fail('enabled must be true or false');
    if(!isDecisionModelProvider(i.provider)) return fail('Choose OpenRouter or TypeSafe');
    const model = typeof i.model === 'string' ? i.model.trim() : '';
    if(!model || model.length > MAX_MODEL_CHARS) return fail('Choose a model');
    const typed = typeof i.apiKey === 'string' ? i.apiKey.trim() : '';
    if(typed.length > MAX_KEY_CHARS) return fail('That key is too long');
    const provider = i.provider;
    const keptKey = this.#stored?.provider === provider ? this.#key() : undefined;
    const key = typed || keptKey;
    if(i.enabled && !key) return fail('Enter an API key');

    // Test and Apply: switching it on tests the key in use (typed or stored)
    // live; a typed key is tested even when switching off, so a bad one is
    // never stored.
    if(i.enabled || typed) {
      let verdict: DecisionModelCheck;
      try {
        verdict = await this.check(provider, key);
      } catch(err) {
        return fail(`Could not check the key: ${err instanceof Error ? err.message : String(err)}`);
      }
      if(verdict.status === 'invalid') return fail(`Key rejected (${verdict.detail})`);
      if(i.enabled && verdict.status !== 'verified') return fail(`Could not confirm the key works (${verdict.detail})`);
    }

    // Persist BEFORE applying: a persona created while this runs inherits
    // the new setting through applyTo.
    const next: Stored = {enabled: i.enabled, provider, model};
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
    const config = configurePayload(next.enabled, provider, model, key);
    const failed: {persona: string; error: string}[] = [];
    let applied = 0;
    for(const persona of names) {
      const res = await this.opts.call('persona.configure', {persona, config});
      if(res.ok) applied++;
      else failed.push({persona, error: res.error.message});
    }
    return {ok: true, state: this.state(), applied, failed};
  }

  /**
   * Give a newly created persona the saved setting. Never throws: a failure
   * is logged and the persona keeps the engine default (no decision model).
   */
  async applyTo(persona: string): Promise<void> {
    await this.#saving;
    const s = this.#stored;
    if(!s) return;
    const key = this.#key();
    if(s.enabled && !key) {
      this.opts.log?.(`decision model: ${persona} not configured (no stored key)`);
      return;
    }
    const res = await this.opts.call('persona.configure', {persona, config: configurePayload(s.enabled, s.provider, s.model, key)});
    if(!res.ok) this.opts.log?.(`decision model: ${persona} failed: ${res.error.message}`);
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

/**
 * main.ts runs this after every bridge call: a successful `personas.create`
 * inherits the saved setting before the page's next call (configure,
 * phantomchat.start), so it costs no extra channel restart.
 */
export async function inheritOnCreate(
  settings: Pick<DecisionModelSettings, 'applyTo'>,
  method: string,
  params: Record<string, unknown>,
  result: {ok: boolean}
): Promise<void> {
  if(method !== 'personas.create' || !result.ok || typeof params.persona !== 'string') return;
  await settings.applyTo(params.persona);
}
