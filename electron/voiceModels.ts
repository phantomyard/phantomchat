/*
 * App-wide Voice Models (Settings > Specialized Models > Voice Models). Only
 * main ever decrypts the saved key.
 *
 * The setting is ONE provider and ONE key, a TTS model and an STT model, and
 * one Enabled switch for both directions. Saving it tests the key and both
 * models ("Test and Save") and pushes nothing to any Phantom: it only makes
 * the Voice ID picker appear on Provider contacts (contacts on this app's
 * engine). A Provider contact gets voice when a Voice ID is picked for it
 * there; only those personas are touched again when the setting changes (new
 * key or models, or switched off). npub Phantoms on other engines are never
 * touched.
 *
 * PhantomOps contacts are the exception: their voice models come from their
 * PhantomOps server (platformModels.ts), so this setting never applies to
 * them. Their Voice ID list is the server TTS model's voices, and picking
 * one sets both directions to the server's models.
 */
import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import type {PhantombotResult} from './preload';
import {isPlatformPersona, lastPlatformModels, platformPersonas, platformVoiceReady, PHANTOMOPS_PROVIDER} from './platformModels';

export type Modality = 'tts' | 'stt';
export interface VoiceChoice {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
}
export interface VoiceModel {id: string; voices: string[]}
interface SavedChoice extends VoiceChoice {apiKey: string; models: VoiceModel[]; voices: string[]}
type Defaults = Record<Modality, SavedChoice>;
interface State {
  defaults: Defaults;
  /** Persona -> the Voice ID picked on its Provider contact. No entry = no voice. */
  voices: Record<string, string>;
}
export interface SecretStorage {available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string}
export type VoiceCall = (method: string, params?: Record<string, unknown>) => Promise<PhantombotResult>;
const directions: Modality[] = ['tts', 'stt'];
const empty = (): SavedChoice => ({enabled: false, provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '', models: [], voices: []});
/** Bring-your-own endpoint: the only provider whose base URL comes from the user. */
const ownEndpoint = (provider: string) => provider === 'openai-compatible';
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const fingerprint = (v: VoiceChoice) => `${v.provider}|${v.baseUrl.replace(/\/+$/, '')}`;
// Tags the channel-restart failure so callers can tell it apart from a voice
// application failure.
export type TaggedError = Error & {code: string};
export const CHANNEL_RESTART = 'voice_channel_restart';
const channelRestartError = (): TaggedError =>
  Object.assign(new Error('Voice settings saved; channel restart failed'), {code: CHANNEL_RESTART});
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Read a stored file, carrying an older layout's per-contact Voice IDs over. */
function load(raw: any): State {
  const defaults = {} as Defaults;
  for(const d of directions) {
    const v = record(raw?.defaults?.[d]) ? raw.defaults[d] : {};
    defaults[d] = {...empty(), ...v};
    delete (defaults[d] as any).voice;
  }
  const voices: Record<string, string> = record(raw?.voices) ? {...raw.voices} : {};
  // Before: per-contact {tts: {endpoint, model, voice}} overrides, `remote:` ones for npub Phantoms.
  if(record(raw?.overrides)) {
    for(const [persona, o] of Object.entries<any>(raw.overrides)) {
      if(!persona.startsWith('remote:') && typeof o?.tts?.voice === 'string' && o.tts.voice) voices[persona] ??= o.tts.voice;
    }
  }
  return {defaults, voices};
}

export class VoiceModels {
  private state: State;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private storage: SecretStorage, private call: VoiceCall) {
    if(existsSync(file)) {
      if(!storage.available()) throw new Error('Encrypted voice storage is unavailable');
      this.state = load(JSON.parse(storage.decrypt(readFileSync(file))));
    } else this.state = load({});
  }
  private async value<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const r = await this.call(method, params);
    if(!r.ok) throw new Error('error' in r ? r.error.message : `${method} failed`);
    return r.value as T;
  }
  private persist() {
    if(!this.storage.available()) throw new Error('Encrypted voice storage is unavailable');
    const temp = this.file + '.tmp';
    // `overrides: {}` keeps the file readable by an older build (rollback): it
    // iterates that map. This build reads `voices` and ignores it.
    writeFileSync(temp, this.storage.encrypt(JSON.stringify({...this.state, overrides: {}})), {mode: 0o600});
    renameSync(temp, this.file);
  }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }
  /** Only providers that serve BOTH directions: one switch turns both on or off. */
  private async providers(): Promise<any[]> {
    const list = await this.value<any[]>('voiceModels.providers');
    return (Array.isArray(list) ? list : []).filter(p => directions.every(d => p?.modalities?.includes(d)));
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
    for(const key of ['enabled', 'provider', 'baseUrl', 'model', 'apiKey'] as const) {
      if(raw[key] !== undefined) (v as any)[key] = raw[key];
    }
    if(typeof v.provider !== 'string' || !PROVIDER_ID.test(v.provider)) throw new Error('Unsupported voice provider');
    for(const k of ['baseUrl', 'model', 'apiKey'] as const) {
      if(typeof v[k] !== 'string' || v[k].length > 65536) throw new Error(`Invalid voice ${k}`);
    }
    v.baseUrl = ownEndpoint(v.provider) ? v.baseUrl.trim().replace(/\/+$/, '') : '';
    v.apiKey = raw.apiKey?.trim() || (fingerprint(v) === fingerprint(old) ? old.apiKey : '');
    if(v.enabled && (!v.apiKey || !v.model)) throw new Error(`Enter the key and choose a ${d.toUpperCase()} model`);
    return v;
  }
  async check(d: Modality, raw: unknown) {
    if(!directions.includes(d)) throw new Error('Unknown voice direction');
    // Discovery does not require the form to already have a model.
    const v = this.choice(d, {...(record(raw) ? raw : {}), enabled: false});
    return this.value<any>('voiceModels.check', {modality: d, provider: v.provider, ...(v.baseUrl ? {baseUrl: v.baseUrl} : {}), apiKey: v.apiKey, model: v.model || undefined});
  }
  /**
   * Test and Save: both directions on or both off. On: the key and both
   * models are checked live, and the TTS model's voices are kept for the
   * contact Voice ID picker. Nothing is saved when a check fails.
   */
  save(raw: unknown) {
    return this.exclusive(async() => {
      if(!record(raw)) throw new Error('Invalid voice settings');
      const next = {} as Defaults;
      for(const d of directions) next[d] = this.choice(d, raw[d]);
      if(next.tts.enabled !== next.stt.enabled) throw new Error('Text-to-speech and speech-to-text are turned on or off together');
      if(next.tts.enabled && fingerprint(next.tts) !== fingerprint(next.stt)) throw new Error('Use one provider for both directions');
      if(next.tts.enabled) {
        for(const d of directions) {
          const check = await this.check(d, next[d]);
          if(!check.ok) throw new Error(check.error || 'Voice provider could not be verified');
          // TUI allows a typed model when its Models API has no catalogue.
          if(check.models.length && !check.models.some((m: VoiceModel) => m.id === next[d].model)) throw new Error(`Choose a current ${d.toUpperCase()} model`);
          next[d].models = check.models;
          next[d].voices = Array.isArray(check.voices) ? check.voices : [];
        }
        if(!next.tts.voices.length) throw new Error('This text-to-speech model lists no voices');
      }
      // PhantomOps contacts keep their server's voice whatever this says.
      const platform = await platformPersonas(this.call, Object.keys(this.state.voices)).catch(() => new Set<string>());
      // A pick the new TTS model does not offer is dropped (same rule as
      // setContact) and named in `resets`; that persona's voice is turned off.
      const resets = next.tts.enabled ? Object.keys(this.state.voices).filter(p => !platform.has(p) && !next.tts.voices.includes(this.state.voices[p])) : [];
      const previous = this.state.defaults;
      const previousVoices = this.state.voices;
      this.state.defaults = next;
      this.state.voices = Object.fromEntries(Object.entries(previousVoices).filter(([p]) => !resets.includes(p)));
      try { this.persist(); } catch(err) {this.state.defaults = previous; this.state.voices = previousVoices; throw err;}
      // Only the Provider contacts that had a Voice ID: new key/models, reset, or off.
      const failures: string[] = [];
      let applied = 0;
      let live = new Set<string>();
      try { live = new Set(await this.value<string[]>('personas.list')); } catch{failures.push('the Provider contacts could not be listed');}
      for(const persona of Object.keys(previousVoices).filter(p => live.has(p) && !platform.has(p))) {
        try { await this.applyPersona(persona); applied++; } catch {failures.push(persona);}
      }
      return {settings: this.get(), applied, failures, resets};
    });
  }
  /**
   * persona.create follow-through: a new persona has no Voice ID, so there is
   * nothing to apply; a stale entry left by a deleted persona of the same
   * name is dropped. Never fails persona creation.
   */
  applyNewPersona(persona: string) {
    return this.exclusive(async() => {
      if(!Object.hasOwn(this.state.voices, persona)) return;
      delete this.state.voices[persona];
      try { this.persist(); } catch{/* The stale entry only matters once a Voice ID is picked again. */}
    });
  }
  private async applyPersona(persona: string) {
    const picked = this.state.voices[persona];
    const on = this.state.defaults.tts.enabled && this.state.defaults.stt.enabled && !!picked;
    const voice = Object.fromEntries(directions.map(d => {
      const v = this.state.defaults[d];
      if(!on) return [d, {enabled: false}];
      return [d, {enabled: true, provider: v.provider, baseUrl: v.baseUrl || undefined, model: v.model,
        ...(d === 'tts' ? {voice: picked} : {}), apiKey: v.apiKey, keyEnv: `PHANTOMBOT_VOICE_${d.toUpperCase()}_API_KEY`}];
    }));
    await this.value('persona.configure', {persona, config: {voice}});
    const status = await this.value<any>('persona.phantomchat.status', {persona});
    if(status?.state === 'failed') throw channelRestartError();
  }
  /** The persona behind a contact on this app's engine, or null (npub Phantom / human). */
  private async personaOf(pubkey: string): Promise<string | null> {
    if(!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error('Invalid contact');
    const names = await this.value<string[]>('personas.list');
    const {nip19} = await import('nostr-tools');
    const npub = nip19.npubEncode(pubkey);
    const matches = await Promise.all(names.map(async persona => {
      const info = await this.value<any>('persona.phantomchat.info', {persona});
      return info.npub === npub ? persona : undefined;
    }));
    return matches.find(Boolean) ?? null;
  }
  /**
   * What the contact Edit pane needs: whether Voice is on (gates the Voice ID
   * picker), the voices of the saved TTS model, and this contact's pick.
   */
  async contact(pubkey: string) {
    const persona = await this.personaOf(pubkey);
    if(persona && await isPlatformPersona(this.call, persona)) {
      // The last known answer: the Edit pane never waits on the server.
      const m = await lastPlatformModels(this.call, persona);
      return {persona, enabled: platformVoiceReady(m), voices: m.tts?.voices ?? [], voice: this.state.voices[persona] ?? '', phantomops: true};
    }
    const d = this.state.defaults;
    return {
      persona,
      enabled: d.tts.enabled && d.stt.enabled,
      voices: d.tts.voices,
      voice: persona ? this.state.voices[persona] ?? '' : ''
    };
  }
  /** Pick (or clear, with '') a Provider contact's Voice ID and apply it to its persona. */
  setContact(pubkey: string, voice: unknown) {
    return this.exclusive(async() => {
      const persona = await this.personaOf(pubkey);
      if(!persona) throw new Error('Voice is only for Provider contacts');
      if(typeof voice !== 'string') throw new Error('Invalid voice');
      if(await isPlatformPersona(this.call, persona)) return this.setPlatformVoice(pubkey, persona, voice);
      const d = this.state.defaults;
      if(voice && !(d.tts.enabled && d.stt.enabled)) throw new Error('Turn on Voice Models in Settings first');
      if(voice && !d.tts.voices.includes(voice)) throw new Error('This model does not offer that voice');
      const had = Object.hasOwn(this.state.voices, persona);
      const previous = this.state.voices[persona];
      if(voice) this.state.voices[persona] = voice;
      else delete this.state.voices[persona];
      try {
        await this.applyPersona(persona);
      } catch(err) {
        // A failed channel restart still applied the config: keep it, say so.
        if((err as {code?: string}).code === CHANNEL_RESTART) {
          this.persist();
          throw err;
        }
        if(had) this.state.voices[persona] = previous;
        else delete this.state.voices[persona];
        await this.applyPersona(persona).catch(() => {});
        throw err;
      }
      this.persist();
      return this.contact(pubkey);
    });
  }
  /** A PhantomOps contact's Voice ID: the server's voices, both directions on the server's models. */
  private async setPlatformVoice(pubkey: string, persona: string, voice: string) {
    if(voice) {
      const m = await lastPlatformModels(this.call, persona);
      if(!platformVoiceReady(m)) throw new Error(m.status === 'available' ? 'This PhantomOps server has no voice models' : `PhantomOps unavailable (${m.detail})`);
      if(!m.tts!.voices.includes(voice)) throw new Error('This model does not offer that voice');
    }
    const config = voice ?
      {tts: {enabled: true, provider: PHANTOMOPS_PROVIDER, voice}, stt: {enabled: true, provider: PHANTOMOPS_PROVIDER}} :
      {tts: {enabled: false}, stt: {enabled: false}};
    await this.value('persona.configure', {persona, config: {voice: config}});
    if(voice) this.state.voices[persona] = voice;
    else delete this.state.voices[persona];
    this.persist();
    const status = await this.value<any>('persona.phantomchat.status', {persona});
    if(status?.state === 'failed') throw channelRestartError();
    return this.contact(pubkey);
  }

  /**
   * The contact's brain moved between PhantomOps and another provider: the
   * old Voice ID belongs to the other side's model, so it is dropped and
   * voice is turned off until a new one is picked. Never throws.
   */
  resetPersona(persona: string) {
    return this.exclusive(async() => {
      const had = Object.hasOwn(this.state.voices, persona);
      delete this.state.voices[persona];
      if(had) {
        try { this.persist(); } catch{/* Dropped again on the next save. */}
      }
      await this.call('persona.configure', {persona, config: {voice: {tts: {enabled: false}, stt: {enabled: false}}}}).catch(() => undefined);
    });
  }

  async handle(method: unknown, params: any): Promise<PhantombotResult> {
    try {
      let value: unknown;
      switch(method) {
        case 'get': value = this.get(); break;
        case 'providers': value = await this.providers(); break;
        case 'check': value = await this.check(params?.modality, params?.settings); break;
        case 'save': value = await this.save(params); break;
        case 'contact': value = await this.contact(params?.pubkey); break;
        case 'setContact': value = await this.setContact(params?.pubkey, params?.voice); break;
        default: throw new Error('Unknown voice settings method');
      }
      return {ok: true, value};
    } catch(err) {return {ok: false, error: {code: 'voice_settings', message: err instanceof Error ? err.message : 'Voice settings failed'}};}
  }
}
