import {describe, expect, it, vi} from 'vitest';
import {mkdtempSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configurePayload, DecisionModelSettings, inheritOnCreate, normalizeStored, type BridgeCall, type KeyCipher} from './decisionModel';

/** Reversible stand-in for safeStorage: proves the file never holds the plaintext. */
function fakeCipher(available = true): KeyCipher {
  return {
    available: () => available,
    encrypt: (plain) => Buffer.from(`enc:${[...plain].reverse().join('')}`),
    decrypt: (enc) => {
      const s = enc.toString();
      if(!s.startsWith('enc:')) throw new Error('bad');
      return [...s.slice(4)].reverse().join('');
    }
  };
}

interface Fake {
  call: BridgeCall & ReturnType<typeof vi.fn>;
  configures: {persona: string; config: any}[];
  personas: string[];
}

function fakeBridge(opts: {verdict?: 'verified' | 'invalid' | 'unverified'; failConfigure?: string[]} = {}): Fake {
  const fake: Fake = {configures: [], personas: ['aria', 'bob'], call: undefined as any};
  fake.call = vi.fn(async(method: string, params: Record<string, unknown>) => {
    switch(method) {
      case 'decisionModels.check':
        return {ok: true as const, value: {
          status: opts.verdict ?? 'verified',
          detail: opts.verdict === 'invalid' ? 'rejected by the provider (HTTP 401)' : 'ok',
          models: opts.verdict === 'invalid' ? [] : ['typesafe/jev-1.13', 'liquid/d1']
        }};
      case 'personas.list':
        return {ok: true as const, value: [...fake.personas]};
      case 'persona.configure':
        if(opts.failConfigure?.includes(params.persona as string)) {
          return {ok: false as const, error: {code: 'write_failed', message: 'disk full'}};
        }
        fake.configures.push({persona: params.persona as string, config: params.config});
        return {ok: true as const, value: null};
      default:
        return {ok: false as const, error: {code: 'invalid_argument', message: `unexpected ${method}`}};
    }
  }) as any;
  return fake;
}

function setup(opts: {cipher?: KeyCipher; bridge?: Fake; file?: string} = {}) {
  const file = opts.file ?? join(mkdtempSync(join(tmpdir(), 'pc-dm-')), 'decision-model.json');
  const bridge = opts.bridge ?? fakeBridge();
  const log = vi.fn();
  const settings = new DecisionModelSettings({file, call: bridge.call, cipher: opts.cipher ?? fakeCipher(), log});
  return {file, bridge, settings, log};
}

const ON = {decisionModel: {provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: 'sk-or-1', judge: true, router: true}};
const OFF = {decisionModel: {judge: false, router: false}};

describe('configurePayload', () => {
  it('On carries provider, model, key and both consumers; Off only turns the consumers off', () => {
    expect(configurePayload(true, 'openrouter', 'typesafe/jev-1.13', 'sk-or-1')).toEqual(ON);
    expect(configurePayload(true, 'typesafe', 'm', undefined)).toEqual({decisionModel: {provider: 'typesafe', model: 'm', judge: true, router: true}});
    expect(configurePayload(false, 'typesafe', 'm', 'k')).toEqual(OFF);
  });
});

describe('DecisionModelSettings', () => {
  it('starts unconfigured and leaves new personas alone', async() => {
    const {settings, bridge} = setup();
    expect(settings.state()).toEqual({
      configured: false, enabled: false, provider: 'openrouter', model: 'typesafe/jev-1.13', hasKey: false, canStoreKey: true
    });
    await settings.applyTo('new');
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it('save applies the exact payload to every persona, one after another', async() => {
    const {settings, bridge, file} = setup();
    const r = await settings.save({enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: ' sk-or-1 '});
    expect(r).toMatchObject({ok: true, applied: 2, failed: []});
    expect(bridge.configures).toEqual([{persona: 'aria', config: ON}, {persona: 'bob', config: ON}]);
    // The key was checked before anything was written.
    expect(bridge.call.mock.calls[0]).toEqual(['decisionModels.check', {provider: 'openrouter', apiKey: 'sk-or-1'}]);
    // Stored encrypted, never in plaintext; the page sees only hasKey.
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain('sk-or-1');
    expect(settings.state()).toEqual({
      configured: true, enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13', hasKey: true, canStoreKey: true
    });
    expect(JSON.stringify(r)).not.toContain('sk-or-1');
  });

  it('a rejected key saves nothing and configures nobody', async() => {
    const {settings, bridge, file} = setup({bridge: fakeBridge({verdict: 'invalid'})});
    const r = await settings.save({enabled: true, provider: 'typesafe', model: 'typesafe/jev-1.13', apiKey: 'bad'});
    expect(r).toMatchObject({ok: false, error: 'Key rejected (rejected by the provider (HTTP 401))'});
    expect(bridge.configures).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(settings.state().configured).toBe(false);
  });

  it('Off turns judge and router off everywhere and keeps provider, model and key; On restores without the key', async() => {
    const {settings, bridge} = setup();
    await settings.save({enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: 'sk-or-1'});
    bridge.configures.length = 0;

    const off = await settings.save({enabled: false, provider: 'openrouter', model: 'typesafe/jev-1.13'});
    expect(off).toMatchObject({ok: true, applied: 2});
    expect(bridge.configures).toEqual([{persona: 'aria', config: OFF}, {persona: 'bob', config: OFF}]);
    expect(settings.state()).toMatchObject({enabled: false, provider: 'openrouter', hasKey: true});
    bridge.configures.length = 0;

    const checksBefore = bridge.call.mock.calls.filter((c) => c[0] === 'decisionModels.check').length;
    const on = await settings.save({enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13'});
    expect(on).toMatchObject({ok: true, applied: 2});
    expect(bridge.configures).toEqual([{persona: 'aria', config: ON}, {persona: 'bob', config: ON}]);
    // No new key, so nothing re-checked.
    expect(bridge.call.mock.calls.filter((c) => c[0] === 'decisionModels.check').length).toBe(checksBefore);
  });

  it('a provider switch needs a new key: the old provider\'s key is never sent to the new one', async() => {
    const {settings, bridge} = setup();
    await settings.save({enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: 'sk-or-1'});
    bridge.configures.length = 0;
    const r = await settings.save({enabled: true, provider: 'typesafe', model: 'typesafe/jev-1.13'});
    expect(r).toMatchObject({ok: false, error: 'Enter an API key'});
    expect(bridge.configures).toEqual([]);
    expect(await settings.check('typesafe', '')).toEqual({status: 'unverified', detail: 'no key to check', models: []});

    const ok = await settings.save({enabled: true, provider: 'typesafe', model: 'typesafe/jev-1.13', apiKey: 'ts-1'});
    expect(ok).toMatchObject({ok: true, applied: 2});
    expect(bridge.configures[0]).toEqual({persona: 'aria', config: {decisionModel: {
      provider: 'typesafe', model: 'typesafe/jev-1.13', apiKey: 'ts-1', judge: true, router: true
    }}});
  });

  it('an empty key checks with the stored key of the same provider', async() => {
    const {settings, bridge} = setup();
    await settings.save({enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: 'sk-or-1'});
    const r = await settings.check('openrouter', '');
    expect(r.models).toEqual(['typesafe/jev-1.13', 'liquid/d1']);
    expect(bridge.call).toHaveBeenLastCalledWith('decisionModels.check', {provider: 'openrouter', apiKey: 'sk-or-1'});
  });

  it('a persona created later inherits the setting, key included', async() => {
    const {settings, bridge} = setup();
    await settings.save({enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: 'sk-or-1'});
    bridge.configures.length = 0;
    await settings.applyTo('carol');
    expect(bridge.configures).toEqual([{persona: 'carol', config: ON}]);

    await settings.save({enabled: false, provider: 'openrouter', model: 'typesafe/jev-1.13'});
    bridge.configures.length = 0;
    await settings.applyTo('dave');
    expect(bridge.configures).toEqual([{persona: 'dave', config: OFF}]);
  });

  it('survives a restart: the setting and the encrypted key are read back', async() => {
    const first = setup();
    await first.settings.save({enabled: true, provider: 'openrouter', model: 'liquid/d1', apiKey: 'sk-or-1'});
    const again = setup({file: first.file});
    expect(again.settings.state()).toMatchObject({configured: true, enabled: true, model: 'liquid/d1', hasKey: true});
    await again.settings.applyTo('erin');
    expect(again.bridge.configures).toEqual([{persona: 'erin', config: {decisionModel: {
      provider: 'openrouter', model: 'liquid/d1', apiKey: 'sk-or-1', judge: true, router: true
    }}}]);
  });

  it('without real encryption the key is never stored, and a later persona is skipped rather than left keyless', async() => {
    const {settings, bridge, file, log} = setup({cipher: fakeCipher(false)});
    const r = await settings.save({enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: 'sk-or-1'});
    expect(r).toMatchObject({ok: true, applied: 2});
    expect(bridge.configures[0].config.decisionModel.apiKey).toBe('sk-or-1');
    expect(JSON.parse(readFileSync(file, 'utf8')).key).toBeUndefined();
    expect(settings.state()).toMatchObject({hasKey: false, canStoreKey: false});
    bridge.configures.length = 0;
    await settings.applyTo('frank');
    expect(bridge.configures).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no stored key'));
  });

  it('reports the personas that failed and still applies the rest', async() => {
    const {settings} = setup({bridge: fakeBridge({failConfigure: ['aria']})});
    const r = await settings.save({enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: 'sk-or-1'});
    expect(r).toMatchObject({ok: true, applied: 1, failed: [{persona: 'aria', error: 'disk full'}]});
  });

  it('refuses bad input before anything is checked or written', async() => {
    const {settings, bridge, file} = setup();
    for(const input of [
      null,
      {enabled: 'yes', provider: 'openrouter', model: 'm'},
      {enabled: true, provider: 'custom', model: 'm', apiKey: 'k'},
      {enabled: true, provider: 'openrouter', model: '  ', apiKey: 'k'},
      {enabled: true, provider: 'openrouter', model: 'm'}
    ]) {
      expect((await settings.save(input)).ok).toBe(false);
    }
    expect(bridge.call).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(false);
  });

  it('a corrupt settings file reads as unconfigured', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'pc-dm-')), 'decision-model.json');
    writeFileSync(file, '{"enabled": tru');
    expect(setup({file}).settings.state().configured).toBe(false);
    expect(normalizeStored({enabled: true, provider: 'openrouter'})).toEqual({enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13'});
    expect(normalizeStored({enabled: true, provider: 'evil'})).toBeUndefined();
  });

  it('a persona created during a save waits for it and gets the new setting', async() => {
    const bridge = fakeBridge();
    const {settings} = setup({bridge});
    const saving = settings.save({enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: 'sk-or-1'});
    const inheriting = settings.applyTo('late');
    await Promise.all([saving, inheriting]);
    expect(bridge.configures.find((c) => c.persona === 'late')).toEqual({persona: 'late', config: ON});
  });
});

describe('inheritOnCreate (main.ts, after every bridge call)', () => {
  it('only a successful personas.create applies the setting', async() => {
    const applyTo = vi.fn(async() => {});
    await inheritOnCreate({applyTo}, 'personas.create', {persona: 'new'}, {ok: true});
    expect(applyTo).toHaveBeenCalledWith('new');
    applyTo.mockClear();
    await inheritOnCreate({applyTo}, 'personas.create', {persona: 'new'}, {ok: false});
    await inheritOnCreate({applyTo}, 'persona.configure', {persona: 'new'}, {ok: true});
    await inheritOnCreate({applyTo}, 'personas.create', {persona: 7}, {ok: true});
    expect(applyTo).not.toHaveBeenCalled();
  });
});
