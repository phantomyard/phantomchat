import {describe, expect, it, vi} from 'vitest';
import {
  checkProviderKey,
  createProviderContact,
  listProviderOptions,
  providerPersonaName,
  type BridgeCall,
  type ProviderOption
} from '@lib/phantomchat/provider-contacts';

const ME = 'npub1' + 'q'.repeat(58);
const BOT = 'npub1' + 'p'.repeat(58);
const OPENROUTER: ProviderOption = {id: 'openrouter', label: 'OpenRouter', keyOptional: false, checkable: true, autoModel: false};

function fakeBridge(fail: Record<string, string> = {}, start: any = {state: 'running', npub: BOT}) {
  const calls: Array<[string, any]> = [];
  const call: BridgeCall = vi.fn(async(method: string, params?: any) => {
    calls.push([method, params]);
    if(fail[method]) return {ok: false as const, error: {code: 'failed', message: fail[method]}};
    switch(method) {
      case 'personas.list': return {ok: true as const, value: ['claude']};
      case 'persona.phantomchat.start': return {ok: true as const, value: start};
      case 'persona.phantomchat.info': return {ok: true as const, value: {npub: BOT, configured: true, allowedNpubs: [ME]}};
      default: return {ok: true as const, value: null};
    }
  });
  return {call, calls, methods: () => calls.map(([m]) => m)};
}

describe('provider contacts', () => {
  it('names personas after the contact, avoiding taken names', () => {
    expect(providerPersonaName('Claude', ['claude'])).toBe('claude-2');
    expect(providerPersonaName('My GPT 5!', [])).toBe('mygpt5');
    expect(providerPersonaName('???', [])).toBe('provider');
    expect(providerPersonaName('Phantom Ops', [])).toBe('phantomops');
  });

  it('lists only providers the engine can run without a base URL', async() => {
    const call: BridgeCall = async() => ({ok: true, value: [
      {id: 'openrouter', label: 'OpenRouter', needsBaseUrl: false, checkable: true},
      {id: 'openai-compatible', label: 'OpenAI-Compatible', needsBaseUrl: true}
    ]});
    expect((await listProviderOptions(call)).map((p) => p.id)).toEqual(['openrouter']);
  });

  it('pins PhantomOps and Anthropic above the engine order', async() => {
    const call: BridgeCall = async() => ({ok: true, value: [
      {id: 'cloudflare-ai-gateway', label: 'Cloudflare AI Gateway'},
      {id: 'xai', label: 'xAI'},
      {id: 'anthropic', label: 'Anthropic'},
      {id: 'openrouter', label: 'OpenRouter'},
      {id: 'phantomops', label: 'PhantomOps'}
    ]});
    expect((await listProviderOptions(call)).map((p) => p.id)).toEqual(['phantomops', 'anthropic', 'cloudflare-ai-gateway', 'xai', 'openrouter']);
  });

  it('reads a check verdict and its models', async() => {
    const call: BridgeCall = async() => ({ok: true, value: {status: 'verified', detail: 'HTTP 200', models: [{id: 'a', supportsImages: true}, {bad: 1}]}});
    expect(await checkProviderKey(call, 'openrouter', 'k')).toEqual({status: 'verified', detail: 'HTTP 200', models: [{id: 'a', supportsImages: true}]});
  });

  it('creates, configures, allows only me, starts, and returns the npub', async() => {
    const b = fakeBridge();
    const res = await createProviderContact(b.call, {displayName: 'Claude', provider: OPENROUTER, model: 'anthropic/claude', apiKey: 'sk', ownNpub: ME});
    expect(res).toEqual({persona: 'claude-2', npub: BOT});
    expect(b.methods()).toEqual(['personas.list', 'personas.create', 'persona.configure', 'persona.phantomchat.allow', 'persona.phantomchat.start']);
    expect(b.calls[2][1].config.brain.native).toEqual({provider: 'openrouter', model: 'anthropic/claude', apiKey: 'sk'});
    expect(b.calls[3][1]).toEqual({persona: 'claude-2', npub: ME});
  });

  it('deletes the persona when configure or allow fails', async() => {
    for(const step of ['persona.configure', 'persona.phantomchat.allow']) {
      const b = fakeBridge({[step]: 'nope'});
      await expect(createProviderContact(b.call, {displayName: 'C', provider: OPENROUTER, model: 'm', apiKey: 'sk', ownNpub: ME})).rejects.toThrow('nope');
      expect(b.methods().at(-1)).toBe('personas.delete');
    }
  });

  it('keeps a persona whose channel only failed to start, and says so', async() => {
    const b = fakeBridge({}, {state: 'failed', error: 'no relays'});
    const res = await createProviderContact(b.call, {displayName: 'C', provider: OPENROUTER, model: 'm', apiKey: 'sk', ownNpub: ME});
    expect(res).toEqual({persona: 'c', npub: BOT, channelError: 'no relays'});
    expect(b.methods()).not.toContain('personas.delete');
  });

  it('uses the default model for an auto-model provider and needs a key unless optional', async() => {
    const auto: ProviderOption = {id: 'phantomops', label: 'PhantomOps', keyOptional: false, checkable: true, autoModel: true, defaultModel: 'phantomops/auto'};
    const b = fakeBridge();
    await createProviderContact(b.call, {displayName: 'Ops', provider: auto, model: 'ignored', apiKey: 'k', ownNpub: ME});
    expect(b.calls[2][1].config.brain.native.model).toBe('phantomops/auto');
    await expect(createProviderContact(fakeBridge().call, {displayName: 'X', provider: OPENROUTER, model: 'm', apiKey: '', ownNpub: ME})).rejects.toThrow('token');
  });
});
