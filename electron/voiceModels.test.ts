import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
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
  if(method === 'voiceModels.providers') value = [{id: 'openai', label: 'OpenAI', modalities: ['tts', 'stt'], needsBaseUrl: false, transport: {provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1'}}];
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
const form = (model: string, voice = '') => ({enabled: true, provider: 'openai-compatible', baseUrl: 'https://audio.example/v1', model, voice, apiKey: 'secret-value'});
const settings = () => ({tts: form('tts-a', 'alloy'), stt: form('stt-a')});
beforeEach(() => {root = mkdtempSync(join(tmpdir(), 'pc-voice-')); file = join(root, 'voice.enc'); payloads = []; checks = []; statuses = {}; failConfigure.clear(); service = new VoiceModels(file, storage, call);});
afterEach(() => rmSync(root, {recursive: true, force: true}));
describe('voice settings in main', () => {
  it('a Pi provider: one key for both directions, never a caller base URL, remote plans name its transport', async() => {
    const preset = (model: string, voice = '') => ({...form(model, voice), provider: 'openai', baseUrl: 'https://evil.example/v1', apiKey: 'one-key'});
    await service.save({tts: preset('tts-a', 'alloy'), stt: preset('stt-a')});
    const voice = payloads.at(-1).config.voice;
    expect(voice.tts).toMatchObject({provider: 'openai', apiKey: 'one-key'});
    expect(voice.stt).toMatchObject({provider: 'openai', apiKey: 'one-key'});
    expect(voice.tts.baseUrl).toBeUndefined();
    expect(checks.every(c => c.baseUrl === undefined)).toBe(true);
    expect((service.get() as any).tts.transport).toEqual({provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1'});
    const plan = await service.handle('remotePlan', {pubkey: 'b'.repeat(64)});
    expect((plan as any).value.tts).toMatchObject({provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'tts-a'});
  });
  it('a contact Voice ID is kept when its model offers it, refused otherwise', async() => {
    await service.save(settings());
    await service.setContact(pubkey, {tts: 'tts-b'}, {tts: 'echo'});
    expect(payloads.at(-1).config.voice.tts).toMatchObject({model: 'tts-b', voice: 'echo'});
    await expect(service.setContact(pubkey, {tts: 'tts-b'}, {tts: 'nope'})).rejects.toThrow('does not offer that voice');
    // A voice alone overrides the default model's voice.
    await service.setContact(pubkey, {tts: ''}, {tts: 'alloy'});
    expect(payloads.at(-1).config.voice.tts).toMatchObject({model: 'tts-a', voice: 'alloy'});
  });
  it('encrypts keys, returns only presence, applies both defaults and restores off/on', async() => {
    const result = await service.save(settings());
    expect(result.applied).toBe(2);
    expect(readFileSync(file).includes(Buffer.from('secret-value'))).toBe(false);
    expect(JSON.stringify(service.get())).not.toContain('secret-value');
    expect((service.get() as any).tts.hasKey).toBe(true);
    expect(payloads[0].config.voice.tts).toMatchObject({model: 'tts-a', keyEnv: 'PHANTOMBOT_VOICE_TTS_API_KEY'});
    expect(payloads[0].config.voice.stt).not.toHaveProperty('voice');
    await service.save({tts: {enabled: false}, stt: {...form('stt-a'), apiKey: ''}});
    expect(payloads.at(-1).config.voice.tts).toEqual({enabled: false});
    expect(payloads.at(-1).config.voice.stt.enabled).toBe(true);
    service = new VoiceModels(file, storage, call);
    await service.save({tts: {...form('tts-a', 'alloy'), apiKey: ''}, stt: {...form('stt-a'), apiKey: ''}});
    expect(payloads.at(-1).config.voice.tts.apiKey).toBe('secret-value');
  });
  it('inherits for new personas; persists and reapplies model-specific contact overrides', async() => {
    await service.save(settings());
    await service.setContact(pubkey, {tts: 'tts-b', stt: ''});
    expect(payloads.at(-1).config.voice.tts).toMatchObject({model: 'tts-b', voice: 'echo'});
    service = new VoiceModels(file, storage, call);
    expect((await service.contact(pubkey)).overrides.tts?.model).toBe('tts-b');
    await service.applyNewPersona('new-persona');
    expect(payloads.at(-1).config.voice.tts.model).toBe('tts-a');
    const changed = settings(); changed.tts.baseUrl = 'https://new.example/v1';
    const result = await service.save(changed);
    expect(result.resets).toContain('alpha: TTS');
    expect((await service.contact(pubkey)).overrides.tts).toBeUndefined();
    await service.setContact(pubkey, {tts: 'tts-b'});
    await service.applyNewPersona('alpha');
    expect(payloads.at(-1).config.voice.tts.model).toBe('tts-a');
  });
  it('refuses invalid keys and provider switches without keys before changing state', async() => {
    await service.save(settings()); const before = JSON.stringify(service.get()); payloads.length = 0;
    await expect(service.save({tts: {...form('tts-a', 'alloy'), apiKey: 'bad'}, stt: form('stt-a')})).rejects.toThrow();
    await expect(service.save({tts: {...form('tts-a', 'alloy'), baseUrl: 'https://other.example', apiKey: ''}, stt: form('stt-a')})).rejects.toThrow();
    expect(JSON.stringify(service.get())).toBe(before); expect(payloads).toEqual([]);
  });
  it('reports restart failures and rejects overrides when disabled', async() => {
    statuses.alpha = 'failed';
    expect((await service.save(settings())).failures).toEqual(['alpha']);
    statuses = {};
    await service.save({tts: {enabled: false}, stt: {enabled: false}});
    await service.setContact(pubkey, {tts: 'tts-b'});
    expect(payloads.at(-1).config.voice.tts).toEqual({enabled: false});
  });
  it('creation follow-through skips everything when no default is enabled', async() => {
    statuses.brand = 'failed';
    await expect(service.applyNewPersona('brand')).resolves.toBeUndefined();
    expect(payloads).toEqual([]);
  });
  it('creation follow-through survives a channel-restart failure and still throws on voice failures', async() => {
    await service.save(settings());
    payloads.length = 0; statuses.beta = 'failed';
    await expect(service.applyNewPersona('beta')).resolves.toBeUndefined();
    expect(payloads.at(-1).config.voice.tts).toMatchObject({model: 'tts-a'});
    failConfigure.add('beta');
    await expect(service.applyNewPersona('beta')).rejects.toThrow('configure failed');
  });
  it('refuses plaintext encryption backends', async() => {
    const s = new VoiceModels(file, {...storage, available: () => false}, call);
    await expect(s.save(settings())).rejects.toThrow('Encrypted');
  });
  it('remote plans contain metadata only and use enabled settings defaults', async() => {
    await service.save(settings());
    const plan = await service.handle('remotePlan', {pubkey: 'b'.repeat(64), models: {tts: 'tts-b'}});
    expect(plan.ok).toBe(true); expect(JSON.stringify(plan)).not.toContain('secret-value');
    expect((plan as any).value.tts).toEqual({enabled: true, provider: 'openai-compatible', baseUrl: 'https://audio.example/v1', model: 'tts-b'});
    await service.handle('saveRemote', {pubkey: 'b'.repeat(64), models: {tts: 'tts-b'}});
    const inherit = await service.handle('remotePlan', {pubkey: 'b'.repeat(64), models: {tts: ''}});
    expect((inherit as any).value.tts.model).toBe('tts-a');
  });
});
