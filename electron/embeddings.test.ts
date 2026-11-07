import {describe, expect, it, vi} from 'vitest';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configurePayload, EmbeddingsSettings, normalizeStored} from './embeddings';
import {inheritOnCreate, type BridgeCall, type KeyCipher} from './decisionModel';

function fakeCipher(available = true): KeyCipher {
  return {
    available: () => available,
    encrypt: (plain) => Buffer.from(`enc:${[...plain].reverse().join('')}`),
    decrypt: (enc) => [...enc.toString().slice(4)].reverse().join('')
  };
}

function fakeBridge(opts: {embed?: 'verified' | 'failed'; models?: string[]} = {}) {
  const configures: {persona: string; config: any}[] = [];
  const refreshes: string[] = [];
  const checks: any[] = [];
  const call = vi.fn(async(method: string, params: Record<string, unknown>) => {
    switch(method) {
      case 'embeddings.check':
        checks.push(params);
        return {ok: true as const, value: params.model || params.provider === 'gemini' ?
          {status: opts.embed ?? 'verified', detail: opts.embed === 'failed' ? 'HTTP 401' : 'embedded (768 dims)', models: opts.models ?? ['bge-m3'], ...(opts.embed === 'failed' ? {} : {dims: 768})} :
          {status: 'unchecked', detail: 'choose a model', models: opts.models ?? ['bge-m3']}};
      case 'personas.list':
        return {ok: true as const, value: ['aria', 'bob']};
      case 'persona.configure':
        configures.push({persona: params.persona as string, config: params.config});
        return {ok: true as const, value: null};
      case 'persona.memory.refresh':
        refreshes.push(params.persona as string);
        return {ok: true as const, value: {indexed: 1, removed: 0, embedded: 3, embedFailed: 0}};
      default:
        return {ok: false as const, error: {code: 'invalid_argument', message: `unexpected ${method}`}};
    }
  }) as unknown as BridgeCall & ReturnType<typeof vi.fn>;
  return {call, configures, refreshes, checks};
}

function setup(opts: {cipher?: KeyCipher; bridge?: ReturnType<typeof fakeBridge>} = {}) {
  const file = join(mkdtempSync(join(tmpdir(), 'pc-emb-')), 'embeddings.json');
  const bridge = opts.bridge ?? fakeBridge();
  const settings = new EmbeddingsSettings({file, call: bridge.call, cipher: opts.cipher ?? fakeCipher(), log: vi.fn()});
  return {file, bridge, settings};
}

const LOCAL = {enabled: true, provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'bge-m3'};

describe('EmbeddingsSettings', () => {
  it('starts unconfigured', () => {
    expect(setup().settings.state()).toMatchObject({configured: false, enabled: false, provider: 'gemini', hasKey: false});
  });

  it('turning it on proves the model with a live embed, saves dims, configures every persona and embeds their notes', async() => {
    const {settings, bridge, file} = setup();
    const res = await settings.save({...LOCAL, apiKey: 'sk-1'});
    expect(res.ok).toBe(true);
    expect(bridge.checks).toEqual([{provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', apiKey: 'sk-1', model: 'bge-m3'}]);
    const expected = {embeddings: {provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'bge-m3', dims: 768, apiKey: 'sk-1'}};
    expect(bridge.configures).toEqual([{persona: 'aria', config: expected}, {persona: 'bob', config: expected}]);
    await settings.refreshAll();
    expect(bridge.refreshes).toEqual(['aria', 'bob']);
    const stored = readFileSync(file, 'utf8');
    expect(stored).not.toContain('sk-1');
    expect(settings.state()).toMatchObject({configured: true, enabled: true, dims: 768, hasKey: true});
  });

  it('a model that does not embed saves nothing', async() => {
    const {settings, bridge} = setup({bridge: fakeBridge({embed: 'failed'})});
    const res = await settings.save({...LOCAL, apiKey: 'bad'});
    expect(res).toMatchObject({ok: false, error: 'The model did not embed (HTTP 401)'});
    expect(bridge.configures).toEqual([]);
    expect(settings.state().configured).toBe(false);
  });

  it('Gemini needs a key; a stored key is reused for the same provider only', async() => {
    const {settings, bridge} = setup();
    expect(await settings.save({enabled: true, provider: 'gemini'})).toMatchObject({ok: false, error: 'Enter an API key'});
    expect((await settings.save({enabled: true, provider: 'gemini', apiKey: 'g-1'})).ok).toBe(true);
    bridge.checks.length = 0;
    expect((await settings.save({enabled: true, provider: 'gemini'})).ok).toBe(true);
    expect(bridge.checks[0]).toMatchObject({provider: 'gemini', apiKey: 'g-1', model: 'gemini-embedding-001'});
    // Another endpoint never gets the Gemini key.
    bridge.checks.length = 0;
    bridge.configures.length = 0;
    expect((await settings.save(LOCAL)).ok).toBe(true);
    expect(bridge.checks[0].apiKey).toBeUndefined();
    expect(bridge.configures[0].config.embeddings.apiKey).toBeUndefined();
  });

  it('a stored key is not sent to a different OpenAI-compatible endpoint', async() => {
    const {settings, bridge} = setup();
    await settings.save({...LOCAL, apiKey: 'sk-local'});
    bridge.checks.length = 0;
    await settings.check({provider: 'openai-compatible', baseUrl: 'https://evil.example/v1'});
    expect(bridge.checks[0].apiKey).toBeUndefined();
    await settings.check({provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1/'});
    expect(bridge.checks[1].apiKey).toBe('sk-local');
  });

  it('Off writes provider none, keeps the key and embeds nothing', async() => {
    const {settings, bridge} = setup();
    await settings.save({...LOCAL, apiKey: 'sk-1'});
    await settings.refreshAll();
    bridge.configures.length = 0;
    bridge.refreshes.length = 0;
    bridge.checks.length = 0;
    expect((await settings.save({...LOCAL, enabled: false})).ok).toBe(true);
    expect(bridge.checks).toEqual([]);
    expect(bridge.configures[0].config).toEqual({embeddings: {provider: 'none'}});
    await settings.refreshAll();
    expect(bridge.refreshes).toEqual([]);
    expect(settings.state().hasKey).toBe(true);
  });

  it('a new persona inherits the setting', async() => {
    const {settings, bridge} = setup();
    await settings.save({...LOCAL, apiKey: 'sk-1'});
    bridge.configures.length = 0;
    await inheritOnCreate(settings, 'personas.create', {persona: 'cara'}, {ok: true});
    expect(bridge.configures).toEqual([{persona: 'cara', config: expect.objectContaining({embeddings: expect.objectContaining({apiKey: 'sk-1'})})}]);
  });

  it('refreshAll joins a refresh already running', async() => {
    const {settings, bridge} = setup();
    await settings.save({...LOCAL, apiKey: 'sk-1'});
    await settings.refreshAll();
    bridge.refreshes.length = 0;
    await Promise.all([settings.refreshAll(), settings.refreshAll()]);
    expect(bridge.refreshes).toEqual(['aria', 'bob']);
  });

  it('without a keyring the key is used but never written', async() => {
    const {settings, file, bridge} = setup({cipher: fakeCipher(false)});
    await settings.save({...LOCAL, apiKey: 'sk-1'});
    expect(bridge.configures[0].config.embeddings.apiKey).toBe('sk-1');
    expect(JSON.parse(readFileSync(file, 'utf8')).key).toBeUndefined();
    expect(settings.state()).toMatchObject({hasKey: false, canStoreKey: false});
  });
});

describe('normalizeStored / configurePayload', () => {
  it('a Pi provider is sent as itself with its key and no base URL', () => {
    const s = normalizeStored({enabled: true, provider: 'openai', baseUrl: 'https://evil.example/v1', model: 'text-embedding-3-small', dims: 1536})!;
    expect(s.baseUrl).toBe('');
    expect(configurePayload(s, 'sk-1')).toEqual({embeddings: {provider: 'openai', apiKey: 'sk-1', model: 'text-embedding-3-small', dims: 1536}});
    expect(normalizeStored({enabled: true, provider: 'Not An Id!', model: 'm'})).toBeUndefined();
  });
  it('rejects junk and fills the Gemini default model', () => {
    expect(normalizeStored(null)).toBeUndefined();
    expect(normalizeStored({enabled: true, provider: 'cohere'})).toBeUndefined();
    expect(normalizeStored({enabled: true, provider: 'gemini'})).toMatchObject({model: 'gemini-embedding-001', dims: 0});
    expect(normalizeStored({enabled: true, provider: 'openai-compatible', baseUrl: 'x'})).toBeUndefined();
  });

  it('off is provider none', () => {
    expect(configurePayload({enabled: false, provider: 'gemini', baseUrl: '', model: 'm', dims: 0})).toEqual({embeddings: {provider: 'none'}});
  });
});
