import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {nip19} from 'nostr-tools';
import {VoiceModels, type SecretStorage} from './voiceModels';
const pubkey = 'a'.repeat(64);
let root: string;
let file: string;
let service: VoiceModels;
let payloads: any[];
let checks: any[] = [];
let statuses: Record<string, string>;
const failConfigure = new Set<string>();
const key = randomBytes(32);
const storage: SecretStorage = {
  available: () => true,
  encrypt: value => {const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]);},
  decrypt: value => {const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString();}
};
async function call(method: string, p: any = {}) {
  let value: any;
  if(method === 'personas.list') value = ['alpha', 'beta'];
  if(method === 'voiceModels.providers') value = [{id: 'openai', label: 'OpenAI', modalities: ['tts', 'stt'], needsBaseUrl: false}, {id: 'groq', label: 'Groq', modalities: ['stt'], needsBaseUrl: false}];
  if(method === 'voiceModels.check') checks.push(structuredClone(p));
  if(method === 'voiceModels.check') {
    const tts = p.modality === 'tts';
    value = {ok: p.apiKey !== 'bad', models: tts ? [{id: 'tts-a', voices: ['alloy']}, {id: 'tts-b', voices: ['echo']}] : [{id: 'stt-a', voices: []}], voices: tts ? [p.model === 'tts-b' ? 'echo' : 'alloy'] : []};
  }
  if(method === 'persona.configure') {
    if(failConfigure.has(p.persona)) return {ok: false as const, error: {code: 'engine', message: 'configure failed'}};
    payloads.push(structuredClone(p));
  }
  if(method === 'persona.phantomchat.status') value = {state: statuses[p.persona] || 'stopped'};
  if(method === 'persona.phantomchat.info') value = {npub: p.persona === 'alpha' ? nip19.npubEncode(pubkey) : null};
  return {ok: true as const, value};
}
const form = (model: string) => ({enabled: true, provider: 'openai-compatible', baseUrl: 'https://audio.example/v1', model, apiKey: 'secret-value'});
const settings = () => ({tts: form('tts-a'), stt: form('stt-a')});
beforeEach(() => {root = mkdtempSync(join(tmpdir(), 'pc-voice-')); file = join(root, 'voice.enc'); payloads = []; checks = []; statuses = {}; failConfigure.clear(); service = new VoiceModels(file, storage, call);});
afterEach(() => rmSync(root, {recursive: true, force: true}));
describe('voice settings in main', () => {
  it('Test and Save checks both directions and pushes nothing to any persona', async() => {
    const result = await service.save(settings());
    expect(checks.map(c => c.modality).sort()).toEqual(['stt', 'tts']);
    expect(payloads).toEqual([]);
    expect(result.applied).toBe(0);
    expect((service.get() as any).tts.voices).toEqual(['alloy']);
    expect(readFileSync(file).includes(Buffer.from('secret-value'))).toBe(false);
    expect(JSON.stringify(service.get())).not.toContain('secret-value');
    // An older build (rollback) iterates `overrides`: it is always there.
    expect(JSON.parse(storage.decrypt(readFileSync(file))).overrides).toEqual({});
  });
  it('one switch: TTS and STT are on or off together, one provider for both', async() => {
    await expect(service.save({tts: form('tts-a'), stt: {enabled: false}})).rejects.toThrow('together');
    await expect(service.save({tts: form('tts-a'), stt: {...form('stt-a'), baseUrl: 'https://other.example/v1'}})).rejects.toThrow('one provider');
  });
  it('refuses a bad key or unknown model before changing state', async() => {
    await service.save(settings()); const before = JSON.stringify(service.get());
    await expect(service.save({tts: {...form('tts-a'), apiKey: 'bad'}, stt: {...form('stt-a'), apiKey: 'bad'}})).rejects.toThrow();
    await expect(service.save({tts: form('tts-z'), stt: form('stt-a')})).rejects.toThrow('current TTS model');
    expect(JSON.stringify(service.get())).toBe(before);
  });
  it('providers lists only those serving both directions', async() => {
    const only = await service.handle('providers', {});
    expect((only as any).value.map((p: any) => p.id)).toEqual(['openai']);
  });
  it('a Voice ID on a Provider contact turns voice on for its persona only; clearing it turns it off', async() => {
    await service.save(settings());
    const c = await service.setContact(pubkey, 'alloy');
    expect(c).toMatchObject({persona: 'alpha', enabled: true, voice: 'alloy', voices: ['alloy']});
    expect(payloads.at(-1)).toMatchObject({persona: 'alpha', config: {voice: {tts: {enabled: true, model: 'tts-a', voice: 'alloy', keyEnv: 'PHANTOMBOT_VOICE_TTS_API_KEY'}, stt: {enabled: true, model: 'stt-a'}}}});
    expect(payloads.at(-1).config.voice.stt).not.toHaveProperty('voice');
    await expect(service.setContact(pubkey, 'nope')).rejects.toThrow('does not offer');
    await service.setContact(pubkey, '');
    expect(payloads.at(-1).config.voice).toEqual({tts: {enabled: false}, stt: {enabled: false}});
  });
  it('npub Phantoms (no persona here) get no voice', async() => {
    await service.save(settings());
    await expect(service.setContact('b'.repeat(64), 'alloy')).rejects.toThrow('only for Provider contacts');
    expect((await service.contact('b'.repeat(64))).persona).toBeNull();
  });
  it('a later save updates only personas with a Voice ID, and switching off turns them off', async() => {
    await service.save(settings());
    await service.setContact(pubkey, 'alloy');
    payloads.length = 0;
    const result = await service.save({tts: {...form('tts-a'), apiKey: 'new-key'}, stt: {...form('stt-a'), apiKey: 'new-key'}});
    expect(result.applied).toBe(1);
    expect(payloads.map(p => p.persona)).toEqual(['alpha']);
    expect(payloads[0].config.voice.tts.apiKey).toBe('new-key');
    await service.save({tts: {enabled: false}, stt: {enabled: false}});
    expect(payloads.at(-1).config.voice).toEqual({tts: {enabled: false}, stt: {enabled: false}});
    await expect(service.setContact(pubkey, 'alloy')).rejects.toThrow('Turn on Voice Models');
    // The pick survives a reload.
    service = new VoiceModels(file, storage, call);
    expect((await service.contact(pubkey)).voice).toBe('alloy');
  });
  it('a model change drops a Voice ID the new model does not offer, names it and turns that voice off', async() => {
    await service.save(settings());
    await service.setContact(pubkey, 'alloy');
    payloads.length = 0;
    const result = await service.save({tts: form('tts-b'), stt: form('stt-a')});
    expect(result.resets).toEqual(['alpha']);
    expect(result.failures).toEqual([]);
    expect(payloads.map(p => p.persona)).toEqual(['alpha']);
    expect(payloads[0].config.voice).toEqual({tts: {enabled: false}, stt: {enabled: false}});
    expect((await service.contact(pubkey)).voice).toBe('');
    service = new VoiceModels(file, storage, call);
    expect((await service.contact(pubkey)).voice).toBe('');
  });
  it('a stored key is kept for the same endpoint across reloads', async() => {
    await service.save(settings());
    await service.setContact(pubkey, 'alloy');
    service = new VoiceModels(file, storage, call);
    payloads.length = 0;
    await service.save({tts: {...form('tts-a'), apiKey: ''}, stt: {...form('stt-a'), apiKey: ''}});
    expect(payloads.at(-1).config.voice.tts.apiKey).toBe('secret-value');
  });
  it('reports a channel-restart failure but keeps the pick', async() => {
    await service.save(settings());
    statuses.alpha = 'failed';
    await expect(service.setContact(pubkey, 'alloy')).rejects.toThrow('channel restart');
    expect((await service.contact(pubkey)).voice).toBe('alloy');
  });
  it('rolls a pick back when the engine refuses it', async() => {
    await service.save(settings());
    failConfigure.add('alpha');
    await expect(service.setContact(pubkey, 'alloy')).rejects.toThrow('configure failed');
    failConfigure.clear();
    expect((await service.contact(pubkey)).voice).toBe('');
  });
  it('a new persona never fails creation and drops a stale pick of the same name', async() => {
    await service.save(settings());
    await service.setContact(pubkey, 'alloy');
    payloads.length = 0;
    await expect(service.applyNewPersona('alpha')).resolves.toBeUndefined();
    await expect(service.applyNewPersona('brand')).resolves.toBeUndefined();
    expect(payloads).toEqual([]);
    expect((await service.contact(pubkey)).voice).toBe('');
  });
  it('carries an older file\'s per-contact voices over, never remote ones', async() => {
    const old = {defaults: {tts: {...form('tts-a'), voice: 'alloy', enabled: true, models: [], voices: ['alloy']}, stt: {...form('stt-a'), voice: '', models: [], voices: []}},
      overrides: {alpha: {tts: {endpoint: 'x', model: 'tts-a', voice: 'alloy'}}, ['remote:' + 'b'.repeat(64)]: {tts: {endpoint: 'x', model: 'tts-a', voice: 'echo'}}}};
    writeFileSync(file, storage.encrypt(JSON.stringify(old)));
    service = new VoiceModels(file, storage, call);
    expect((await service.contact(pubkey)).voice).toBe('alloy');
    expect(JSON.stringify(service.get())).not.toContain('"voice"');
  });
  it('refuses plaintext encryption backends', async() => {
    const s = new VoiceModels(file, {...storage, available: () => false}, call);
    await expect(s.save(settings())).rejects.toThrow('Encrypted');
  });
});
