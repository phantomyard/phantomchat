/** App-wide voice defaults and overrides. Only main ever decrypts saved keys. */
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import type {PhantombotResult} from './preload';

export type Modality = 'tts' | 'stt';
export interface VoiceChoice {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  voice: string;
}
export interface VoiceModel {id: string; voices: string[]}
interface SavedChoice extends VoiceChoice {apiKey: string; models: VoiceModel[]; voices: string[]}
type Defaults = Record<Modality, SavedChoice>;
interface Override {endpoint: string; model: string; voice?: string}
interface State {defaults: Defaults; overrides: Record<string, Partial<Record<Modality, Override>>>}
export interface SecretStorage {available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string}
export type VoiceCall = (method: string, params?: Record<string, unknown>) => Promise<PhantombotResult>;
const directions: Modality[] = ['tts', 'stt'];
const empty = (): SavedChoice => ({enabled: false, provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: '', voice: '', apiKey: '', models: [], voices: []});
const fingerprint = (v: VoiceChoice) => `${v.provider}|${v.baseUrl.replace(/\/+$/, '')}`;
// Tags the channel-restart failure so callers can tell it apart from a voice
// application failure; save() still records it, creation follow-through ignores it.
export type TaggedError = Error & {code: string};
export const CHANNEL_RESTART = 'voice_channel_restart';
const channelRestartError = (): TaggedError =>
  Object.assign(new Error('Voice settings saved; channel restart failed'), {code: CHANNEL_RESTART});
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export class VoiceModels {
  private state: State;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private storage: SecretStorage, private call: VoiceCall) {
    if(existsSync(file)) {
      if(!storage.available()) throw new Error('Encrypted voice storage is unavailable');
      this.state = JSON.parse(storage.decrypt(readFileSync(file)));
    } else this.state = {defaults: {tts: empty(), stt: empty()}, overrides: {}};
  }
  private async value<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const r = await this.call(method, params);
    if(!r.ok) throw new Error('error' in r ? r.error.message : `${method} failed`);
    return r.value as T;
  }
  private persist() {
    if(!this.storage.available()) throw new Error('Encrypted voice storage is unavailable');
    const temp = this.file + '.tmp';
    writeFileSync(temp, this.storage.encrypt(JSON.stringify(this.state)), {mode: 0o600});
    renameSync(temp, this.file);
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  get() {
    return Object.fromEntries(directions.map(d => {
      const {apiKey, ...visible} = this.state.defaults[d];
      return [d, {...visible, hasKey: !!apiKey}];
    }));
  }
  private choice(d: Modality, raw: unknown): SavedChoice {
    if(!record(raw) || typeof raw.enabled !== 'boolean') throw new Error('Invalid voice settings');
    const old = this.state.defaults[d];
    if(!raw.enabled && Object.keys(raw).length === 1) return {...old, enabled: false};
    const v = {...old};
    for(const key of ['enabled', 'provider', 'baseUrl', 'model', 'voice', 'apiKey'] as const) {
      if(raw[key] !== undefined) (v as any)[key] = raw[key];
    }
    if(!['elevenlabs', 'openai-compatible'].includes(v.provider)) throw new Error('Unsupported voice provider');
    for(const k of ['baseUrl', 'model', 'voice', 'apiKey'] as const) {
      if(typeof v[k] !== 'string' || v[k].length > 65536) throw new Error(`Invalid voice ${k}`);
    }
    v.baseUrl = v.provider === 'elevenlabs' ? '' : v.baseUrl.trim().replace(/\/+$/, '');
    v.apiKey = raw.apiKey?.trim() || (fingerprint(v) === fingerprint(old) ? old.apiKey : '');
    if(v.enabled && (!v.apiKey || !v.model || (d === 'tts' && !v.voice))) throw new Error('Choose a model, key and TTS voice before enabling');
    return v;
  }
  async check(d: Modality, raw: unknown) {
    if(!directions.includes(d)) throw new Error('Unknown voice direction');
    // Discovery does not require the form to already have a model or voice.
    const v = this.choice(d, {...(record(raw) ? raw : {}), enabled: false});
    return this.value<any>('voiceModels.check', {modality: d, provider: v.provider, baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model || undefined, voice: v.voice || undefined});
  }
  save(raw: unknown) {
    return this.exclusive(async() => {
      if(!record(raw)) throw new Error('Invalid voice settings');
      const next = {} as Defaults;
      for(const d of directions) {
        next[d] = this.choice(d, raw[d]);
        if(!next[d].enabled) continue;
        const check = await this.check(d, next[d]);
        if(!check.ok) throw new Error(check.error || 'Voice provider could not be verified');
        // TUI allows a typed model when its Models API has no catalogue.
        if(check.models.length && !check.models.some((m: VoiceModel) => m.id === next[d].model)) throw new Error(`Choose a current ${d.toUpperCase()} model`);
        if(d === 'tts' && !check.voices.includes(next[d].voice)) throw new Error('Choose a voice valid for this model');
        next[d].models = check.models;
        next[d].voices = check.voices;
      }
      // Drop incompatible overrides explicitly and report them in the save result.
      const previousState = structuredClone(this.state);
      const resets: string[] = [];
      for(const [persona, overrides] of Object.entries(this.state.overrides)) {
        for(const d of directions) {
          const o = overrides[d];
          if(o && (o.endpoint !== fingerprint(next[d]) || !next[d].models.some(m => m.id === o.model))) {
            delete overrides[d]; resets.push(`${persona}: ${d.toUpperCase()}`);
          }
        }
      }
      this.state.defaults = next;
      try { this.persist(); } catch(err) {this.state = previousState; throw err;}
      const personas = await this.value<string[]>('personas.list');
      const failures: string[] = [];
      // configure restarts a channel; avoid N simultaneous relay reconnects.
      for(const persona of personas) {
        try { await this.applyPersona(persona); } catch {failures.push(persona);}
      }
      return {settings: this.get(), applied: personas.length - failures.length, failures, resets, remotes: Object.keys(this.state.overrides).filter(k => k.startsWith('remote:')).map(k => k.slice(7))};
    });
  }
  apply(persona: string) {
    return this.exclusive(() => this.applyPersona(persona));
  }
  // persona.create follow-through in main: only an enabled default gives this
  // something to apply, so with voice off it must neither call the engine nor
  // fail (main would roll the just-created persona back).
  applyNewPersona(persona: string) {
    return this.exclusive(async() => {
      if(!directions.some(d => this.state.defaults[d].enabled)) return;
      if(this.state.overrides[persona]) {
        delete this.state.overrides[persona];
        this.persist();
      }
      try { return await this.applyPersona(persona); }
      catch(err) {
        // A failed channel restart is channel state, not a voice failure; it
        // reaches the UI through channel status events. Only a voice
        // application failure may roll persona creation back.
        if((err as {code?: string}).code === CHANNEL_RESTART) return;
        throw err;
      }
    });
  }
  private async applyPersona(persona: string) {
    const voice = Object.fromEntries(directions.map(d => {
      const v = this.state.defaults[d];
      if(!v.enabled) return [d, {enabled: false}];
      const o = this.state.overrides[persona]?.[d];
      const compatible = o?.endpoint === fingerprint(v) && v.models.some(m => m.id === o.model);
      return [d, {enabled: true, provider: v.provider, baseUrl: v.baseUrl || undefined,
        model: compatible ? o.model : v.model, ...(d === 'tts' ? {voice: compatible && o.voice ? o.voice : v.voice} : {}),
        apiKey: v.apiKey, keyEnv: `PHANTOMBOT_VOICE_${d.toUpperCase()}_API_KEY`}];
    }));
    await this.value('persona.configure', {persona, config: {voice}});
    const status = await this.value<any>('persona.phantomchat.status', {persona});
    if(status?.state === 'failed') throw channelRestartError();
  }
  async contact(pubkey: string) {
    if(!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('Invalid contact');
    const names = await this.value<string[]>('personas.list');
    const {nip19} = await import('nostr-tools');
    const npub = nip19.npubEncode(pubkey);
    const matches = await Promise.all(names.map(async persona => {
      const info = await this.value<any>('persona.phantomchat.info', {persona});
      return info.npub === npub ? persona : undefined;
    }));
    const persona = matches.find(Boolean);
    return {persona: persona ?? null, settings: this.get(), overrides: this.state.overrides[persona ?? `remote:${pubkey}`] ?? {}};
  }
  setContact(pubkey: string, raw: unknown) {
    return this.exclusive(async() => {
      const contact = await this.contact(pubkey);
      if(!contact.persona) throw new Error('This Phantom runs on another engine; remote voice configuration is unavailable');
      if(!record(raw)) throw new Error('Invalid voice overrides');
      const next: Partial<Record<Modality, Override>> = {};
      for(const d of directions) {
        const v = this.state.defaults[d];
        if(!v.enabled) { next[d] = this.state.overrides[contact.persona]?.[d]; continue; }
        const model = raw[d];
        if(!model) continue;
        if(typeof model !== 'string' || !v.models.some(m => m.id === model)) throw new Error('Choose a current voice model');
        const check = await this.check(d, {...v, model, voice: ''});
        if(!check.ok) throw new Error('Voice provider could not be verified');
        next[d] = {endpoint: fingerprint(v), model, ...(d === 'tts' ? {voice: check.voices.includes(v.voice) ? v.voice : check.voices[0]} : {})};
        if(d === 'tts' && next[d].voice) {
          const proof = await this.check(d, {...v, model, voice: next[d].voice});
          if(!proof.ok) throw new Error('This model does not accept the selected voice');
        }
        if(d === 'tts' && !next[d].voice) throw new Error('No supported voice for this model');
      }
      const previous = this.state.overrides[contact.persona];
      this.state.overrides[contact.persona] = next;
      try { await this.applyPersona(contact.persona); this.persist(); }
      catch(err) {
        this.state.overrides[contact.persona] = previous;
        await this.applyPersona(contact.persona).catch(() => {});
        throw err;
      }
      return this.contact(pubkey);
    });
  }
  private remotePlan(pubkey: string, models?: Record<string, string>) {
    if(!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('Invalid contact');
    return Object.fromEntries(directions.map(d => {
      const v = this.state.defaults[d];
      if(!v.enabled) return [d, {enabled: false}];
      const override = this.state.overrides[`remote:${pubkey}`]?.[d];
      const model = models && Object.hasOwn(models, d) ? models[d] || v.model :
        (override?.endpoint === fingerprint(v) ? override.model : v.model);
      if(model !== v.model && !v.models.some(m => m.id === model)) throw new Error('Choose a current voice model');
      return [d, {enabled: true, provider: v.provider, baseUrl: v.baseUrl, model}];
    }));
  }
  private saveRemote(pubkey: string, models: Record<string, string>) {
    const plan = this.remotePlan(pubkey, models);
    this.state.overrides[`remote:${pubkey}`] = Object.fromEntries(directions.flatMap(d => {
      const model = models[d];
      if(!plan[d].enabled) {
        const old = this.state.overrides[`remote:${pubkey}`]?.[d];
        return old ? [[d, old]] : [];
      }
      return model ? [[d, {endpoint: fingerprint(this.state.defaults[d]), model}]] : [];
    }));
    this.persist();
    return null;
  }
  async handle(method: unknown, params: any): Promise<PhantombotResult> {
    try {
      let value: unknown;
      switch(method) {
        case 'get': value = this.get(); break;
        case 'providers': value = await this.value('voiceModels.providers'); break;
        case 'check': value = await this.check(params?.modality, params?.settings); break;
        case 'save': value = await this.save(params); break;
        case 'remotePlan': value = this.remotePlan(params?.pubkey, params?.models); break;
        case 'saveRemote': value = this.saveRemote(params?.pubkey, params?.models); break;
        case 'contact': value = await this.contact(params?.pubkey); break;
        case 'setContact': value = await this.setContact(params?.pubkey, params?.models); break;
        default: throw new Error('Unknown voice settings method');
      }
      return {ok: true, value};
    } catch(err) {return {ok: false, error: {code: 'voice_settings', message: err instanceof Error ? err.message : 'Voice settings failed'}};}
  }
}
