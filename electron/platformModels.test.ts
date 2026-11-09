/*
 * PhantomOps contacts inherit their server's models: the brain-change hook,
 * Voice Models' PhantomOps branch, and the app-wide settings skipping them.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nip19} from 'nostr-tools';
import {adoptedFile, adoptPlatformContacts, followBrainChange, brainTarget, forgetPlatformModels, inheritPlatformModels} from './platformModels';
import {VoiceModels, type SecretStorage} from './voiceModels';
import {DecisionModelSettings} from './decisionModel';
import {EmbeddingsSettings} from './embeddings';
import {createDispatcher, type EngineLike, type HostMessage} from './phantombot/dispatch';

const OPS_PUBKEY = 'b'.repeat(64);
let root: string;
let configures: {persona: string; config: any}[];
/** persona -> brain provider */
let brains: Record<string, string>;
let platform: any;
/** Whether the fake engine has PhantomOps platform models (phantombot #794). */
let supported: boolean;
/** When set, `persona.platformModels` waits on it (a slow server). */
let gate: Promise<void> | undefined;

const plain: SecretStorage = {available: () => true, encrypt: (v) => Buffer.from(v), decrypt: (b) => b.toString()};

async function call(method: string, p: any = {}): Promise<any> {
  let value: any;
  switch(method) {
    case 'personas.list': value = Object.keys(brains); break;
    case 'persona.brain': value = brains[p.persona] ? {provider: brains[p.persona], hasKey: true} : {hasKey: false}; break;
    case 'platformModels.supported': value = supported; break;
    case 'persona.platformModels':
      if(!supported) return {ok: false as const, error: {code: 'not_supported', message: 'Update the engine for PhantomOps models'}};
      if(gate) await gate;
      value = brains[p.persona] === 'phantomops' ? platform : {status: 'unavailable', detail: 'not a PhantomOps contact'};
      break;
    case 'persona.configure': configures.push({persona: p.persona, config: structuredClone(p.config)}); break;
    case 'persona.phantomchat.status': value = {state: 'running'}; break;
    case 'persona.phantomchat.info': value = {npub: p.persona === 'ops' ? nip19.npubEncode(OPS_PUBKEY) : nip19.npubEncode('c'.repeat(64))}; break;
    case 'voiceModels.providers': value = [{id: 'openai', label: 'OpenAI', modalities: ['tts', 'stt']}]; break;
    case 'voiceModels.check': value = {ok: true, models: [{id: p.modality === 'tts' ? 'tts-a' : 'stt-a', voices: []}], voices: p.modality === 'tts' ? ['alloy'] : []}; break;
    case 'decisionModels.check': value = {status: 'verified', detail: 'HTTP 200', models: ['typesafe/jev-1.13']}; break;
    case 'embeddings.check': value = {status: 'verified', detail: 'ok', models: [], dims: 768}; break;
    case 'persona.memory.refresh': value = {}; break;
  }
  return {ok: true as const, value};
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pc-platform-'));
  configures = [];
  supported = true;
  gate = undefined;
  forgetPlatformModels();
  brains = {ops: 'phantomops', plain: 'openrouter'};
  platform = {status: 'available', detail: '', embeddings: 'openai/te3', embeddingsDims: 1536, decision: 'typesafe/jev-1.13', tts: {model: 'openai/tts', voices: ['nova', 'echo']}, stt: 'openai/whisper'};
});
afterEach(() => rmSync(root, {recursive: true, force: true}));

describe('brain changes', () => {
  const followers = () => ({reapplyAppWide: vi.fn(async() => {}), resetVoice: vi.fn(async() => {}), log: vi.fn()});

  it('reads the brain provider a configure sets', () => {
    expect(brainTarget('persona.configure', {persona: 'x', config: {brain: {native: {provider: 'PhantomOps', model: 'm'}}}})).toEqual({persona: 'x', provider: 'phantomops'});
    expect(brainTarget('persona.configure', {persona: 'x', config: {voice: {}}})).toBeUndefined();
    expect(brainTarget('personas.create', {persona: 'x'})).toBeUndefined();
  });

  it('a move onto PhantomOps inherits the server models and drops the old voice', async() => {
    const f = followers();
    await followBrainChange(call, 'ops', 'openrouter', 'phantomops', f);
    expect(configures).toEqual([{persona: 'ops', config: {
      embeddings: {provider: 'phantomops', model: 'openai/te3', dims: 1536},
      decisionModel: {provider: 'phantomops', judge: true, router: true}
    }}]);
    expect(f.resetVoice).toHaveBeenCalledWith('ops');
    expect(f.reapplyAppWide).not.toHaveBeenCalled();
  });

  it('an engine that cannot inherit leaves models and voice alone', async() => {
    supported = false;
    const f = followers();
    await followBrainChange(call, 'ops', 'openrouter', 'phantomops', f);
    await followBrainChange(call, 'ops', 'phantomops', 'openrouter', f);
    expect(configures).toEqual([]);
    expect(f.resetVoice).not.toHaveBeenCalled();
    expect(f.reapplyAppWide).not.toHaveBeenCalled();
  });

  it('a slot the server lacks is turned off, so no app-wide setting is left on', async() => {
    delete platform.decision;
    delete platform.embeddings;
    expect(await inheritPlatformModels(call, 'ops')).toContain('off');
    expect(configures[0].config).toEqual({embeddings: {provider: 'none'}, decisionModel: {judge: false, router: false}});
  });

  it('an unreachable server changes nothing', async() => {
    platform = {status: 'unavailable', detail: 'PhantomOps unavailable: HTTP 502'};
    expect(await inheritPlatformModels(call, 'ops')).toContain('HTTP 502');
    expect(configures).toEqual([]);
  });

  it('a new token on PhantomOps re-inherits without touching the voice', async() => {
    const f = followers();
    await followBrainChange(call, 'ops', 'phantomops', 'phantomops', f);
    expect(configures.length).toBe(1);
    expect(f.resetVoice).not.toHaveBeenCalled();
  });

  it('a move away from PhantomOps gives the app-wide settings back', async() => {
    const f = followers();
    await followBrainChange(call, 'ops', 'phantomops', 'openrouter', f);
    expect(configures).toEqual([]);
    expect(f.resetVoice).toHaveBeenCalledWith('ops');
    expect(f.reapplyAppWide).toHaveBeenCalledWith('ops');
  });

  it('other provider changes leave models and voice alone', async() => {
    const f = followers();
    await followBrainChange(call, 'plain', 'openrouter', 'anthropic', f);
    expect(configures).toEqual([]);
    expect(f.resetVoice).not.toHaveBeenCalled();
  });
});

describe('Voice ID of a PhantomOps contact', () => {
  let voice: VoiceModels;
  beforeEach(() => {voice = new VoiceModels(join(root, 'voice.enc'), plain, call);});

  it('offers the server voices without any Voice Models setup', async() => {
    expect(await voice.contact(OPS_PUBKEY)).toEqual({persona: 'ops', enabled: true, voices: ['nova', 'echo'], voice: '', phantomops: true});
  });

  it('the Edit pane serves the last answer when the server is slow', async() => {
    expect((await voice.contact(OPS_PUBKEY)).voices).toEqual(['nova', 'echo']);
    let release!: () => void;
    gate = new Promise((r) => {release = r;});
    platform = {...platform, tts: {model: 'openai/tts', voices: ['onyx']}};
    expect((await voice.contact(OPS_PUBKEY)).voices).toEqual(['nova', 'echo']);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect((await voice.contact(OPS_PUBKEY)).voices).toEqual(['onyx']);
  });

  it('with no answer yet, a slow server leaves the picker off instead of blocking', async() => {
    gate = new Promise(() => {});
    const started = Date.now();
    expect((await voice.contact(OPS_PUBKEY)).enabled).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('no picker when the server has no voice models', async() => {
    delete platform.stt;
    expect((await voice.contact(OPS_PUBKEY)).enabled).toBe(false);
  });

  it('a pick turns both directions on over the server; clearing turns them off', async() => {
    await voice.setContact(OPS_PUBKEY, 'echo');
    expect(configures.at(-1)).toEqual({persona: 'ops', config: {voice: {
      tts: {enabled: true, provider: 'phantomops', voice: 'echo'}, stt: {enabled: true, provider: 'phantomops'}
    }}});
    expect((await voice.contact(OPS_PUBKEY)).voice).toBe('echo');
    await voice.setContact(OPS_PUBKEY, '');
    expect(configures.at(-1)?.config).toEqual({voice: {tts: {enabled: false}, stt: {enabled: false}}});
    expect((await voice.contact(OPS_PUBKEY)).voice).toBe('');
  });

  it('refuses a voice the server does not offer', async() => {
    await expect(voice.setContact(OPS_PUBKEY, 'alloy')).rejects.toThrow('does not offer');
    expect(configures).toEqual([]);
  });

  it('an app-wide Voice Models save neither touches nor resets it', async() => {
    await voice.setContact(OPS_PUBKEY, 'echo');
    configures = [];
    const form = (model: string) => ({enabled: true, provider: 'openai-compatible', baseUrl: 'https://audio.example/v1', model, apiKey: 'k'});
    const result = await voice.save({tts: form('tts-a'), stt: form('stt-a')});
    expect(result.resets).toEqual([]);
    expect(configures.filter((c) => c.persona === 'ops')).toEqual([]);
    expect((await voice.contact(OPS_PUBKEY)).voice).toBe('echo');
  });

  it('resetPersona drops the pick and turns voice off', async() => {
    await voice.setContact(OPS_PUBKEY, 'echo');
    await voice.resetPersona('ops');
    expect(configures.at(-1)?.config).toEqual({voice: {tts: {enabled: false}, stt: {enabled: false}}});
    expect((await voice.contact(OPS_PUBKEY)).voice).toBe('');
  });
});

describe('startup move of existing PhantomOps contacts', () => {
  /** A voice store as an older build left it: `picks` chosen from the app-wide Voice Models. */
  const voiceWith = (picks: Record<string, string>) => {
    writeFileSync(join(root, 'voice.enc'), JSON.stringify({defaults: {}, voices: picks}));
    return new VoiceModels(join(root, 'voice.enc'), plain, call);
  };
  const adopt = (voice: VoiceModels, file = join(root, 'adopted.json'), log: string[] = []) =>
    adoptPlatformContacts(call, adoptedFile(file), {adoptVoice: (p, v) => voice.adoptPlatformVoice(p, v), log: (l) => log.push(l)});

  it('moves a PhantomOps contact onto its server models once, without a re-save', async() => {
    const voice = voiceWith({});
    await adopt(voice);
    expect(configures).toEqual([{persona: 'ops', config: {
      embeddings: {provider: 'phantomops', model: 'openai/te3', dims: 1536},
      decisionModel: {provider: 'phantomops', judge: true, router: true}
    }}]);
    configures = [];
    await adopt(voice);
    expect(configures).toEqual([]);
  });

  it('an app-wide Voice ID the server lacks is dropped and voice turned off', async() => {
    const voice = voiceWith({ops: 'alloy', plain: 'alloy'});
    await adopt(voice);
    expect(configures.at(-1)).toEqual({persona: 'ops', config: {voice: {tts: {enabled: false}, stt: {enabled: false}}}});
    expect((await voice.contact(OPS_PUBKEY)).voice).toBe('');
    expect(configures.some((c) => c.persona === 'plain')).toBe(false);
  });

  it('a Voice ID the server offers is kept, now on the server models', async() => {
    const voice = voiceWith({ops: 'echo'});
    await adopt(voice);
    expect(configures.at(-1)).toEqual({persona: 'ops', config: {voice: {
      tts: {enabled: true, provider: 'phantomops', voice: 'echo'}, stt: {enabled: true, provider: 'phantomops'}
    }}});
    expect((await voice.contact(OPS_PUBKEY)).voice).toBe('echo');
  });

  it('an unreachable server is tried again next startup', async() => {
    const voice = voiceWith({ops: 'alloy'});
    platform = {status: 'unavailable', detail: 'down'};
    await adopt(voice);
    expect(configures).toEqual([]);
    forgetPlatformModels();
    platform = {status: 'available', detail: '', embeddings: 'openai/te3', embeddingsDims: 1536, tts: {model: 'openai/tts', voices: ['nova']}, stt: 'openai/whisper'};
    await adopt(voice);
    expect(configures.map((c) => Object.keys(c.config)[0])).toEqual(['embeddings', 'voice']);
  });

  it('an engine that cannot inherit moves nothing and remembers nothing', async() => {
    supported = false;
    const voice = voiceWith({ops: 'alloy'});
    await adopt(voice);
    expect(configures).toEqual([]);
    supported = true;
    await adopt(voice);
    expect(configures.length).toBe(2);
  });

  it('a broken adopted file counts as none yet', async() => {
    writeFileSync(join(root, 'adopted.json'), '{not json');
    await adopt(voiceWith({}));
    expect(configures.length).toBe(1);
  });
});

describe('app-wide Decision Model and Embeddings skip PhantomOps contacts', () => {
  it('Decision Model save and applyTo', async() => {
    const s = new DecisionModelSettings({file: join(root, 'dm.json'), call, cipher: plain});
    const r = await s.save({enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: 'sk-or'});
    expect(r.ok).toBe(true);
    expect(configures.map((c) => c.persona)).toEqual(['plain']);
    await s.applyTo('ops');
    expect(configures.map((c) => c.persona)).toEqual(['plain']);
  });

  it('an engine that cannot inherit still gets the app-wide saves', async() => {
    supported = false;
    const s = new DecisionModelSettings({file: join(root, 'dm.json'), call, cipher: plain});
    const r = await s.save({enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: 'sk-or'});
    expect(r.ok).toBe(true);
    expect(configures.map((c) => c.persona).sort()).toEqual(['ops', 'plain']);
  });

  it('Embeddings save and applyTo', async() => {
    const s = new EmbeddingsSettings({file: join(root, 'emb.json'), call, cipher: plain});
    const r = await s.save({enabled: true, provider: 'gemini', model: 'gemini-embedding-001', apiKey: 'g-key'});
    expect(r.ok).toBe(true);
    expect(configures.map((c) => c.persona)).toEqual(['plain']);
    await s.applyTo('ops');
    expect(configures.map((c) => c.persona)).toEqual(['plain']);
  });
});

describe('bridge', () => {
  const info = {phantombot: '1.1.500', pi: '1.4.0', bun: '1.4.4'};
  const engineWith = (extra: Partial<EngineLike>, persona: any = {}): EngineLike => ({
    personas: {list: async() => [], exists: async() => true, create: async() => ({}), delete: async() => true},
    providers: {list: async() => [], check: async() => ({})},
    decisionModels: {check: async() => ({})},
    persona: () => persona,
    ...extra
  });
  async function send(engine: EngineLike, value: unknown) {
    const out: HostMessage[] = [];
    await createDispatcher(engine, info, (m) => out.push(m)).handle(value);
    return out;
  }

  it('an older engine answers not_supported', async() => {
    const engine = engineWith({});
    expect((await send(engine, {id: 0, method: 'platformModels.supported', params: {}}))[0]).toEqual({id: 0, result: false});
    expect((await send(engine, {id: 1, method: 'platformModels.check', params: {apiKey: 'pok_x'}}))[0]).toMatchObject({error: {code: 'not_supported'}});
    expect((await send(engine, {id: 2, method: 'persona.platformModels', params: {persona: 'ops'}}))[0]).toMatchObject({error: {code: 'not_supported'}});
  });

  it('passes the token check and the persona ask through', async() => {
    const check = vi.fn(async() => ({status: 'available'}));
    const platformModels = vi.fn(async() => ({status: 'available', stt: 'w'}));
    const engine = engineWith({platformModels: {check}}, {platformModels});
    expect((await send(engine, {id: 1, method: 'platformModels.check', params: {apiKey: 'pok_x'}}))[0]).toEqual({id: 1, result: {status: 'available'}});
    expect(check).toHaveBeenCalledWith('pok_x');
    expect((await send(engine, {id: 0, method: 'platformModels.supported', params: {}}))[0]).toEqual({id: 0, result: true});
    expect((await send(engine, {id: 2, method: 'persona.platformModels', params: {persona: 'ops'}}))[0]).toEqual({id: 2, result: {status: 'available', stt: 'w'}});
  });
});
