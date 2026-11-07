/**
 * Settings > Specialized Models > Voice Models: the TTS/STT forms built from
 * the same kit as Decision Model, and the contact editor's model pickers.
 */
import 'fake-indexeddb/auto';
import {afterEach, expect, it, vi} from 'vitest';
vi.mock('@lib/phantomchat/voice-models-remote', () => ({requestRemoteVoiceModels: vi.fn()}));
// Row/InputField pull in the worker proxy and the app state store, which jsdom
// cannot start (see decision-model-settings.test.ts).
vi.mock('@lib/apiManagerProxy', () => {
  const anyObj: any = new Proxy(function() {}, {
    get: (_t, prop) => prop === 'then' ? undefined : anyObj,
    apply: () => anyObj
  });
  return {default: anyObj};
});
vi.mock('@components/row', () => ({default: class {
  container = document.createElement('label');
  constructor(options: any) {
    if(options.checkboxField) this.container.append(options.checkboxField.label);
  }
}}));
import {createVoiceForm, mountContactVoiceModels} from '@lib/phantomchat/voice-models';

const savedTts = {enabled: true, provider: 'openai-compatible', baseUrl: 'https://audio.example/v1', model: 'speech-a', voice: 'alloy', models: [{id: 'speech-a'}], voices: ['alloy'], hasKey: true};
const savedStt = {...savedTts, model: 'listen-a', voice: '', models: [{id: 'listen-a'}], voices: [] as string[]};
const saved = {tts: savedTts, stt: savedStt};
const providers = [
  {id: 'openai-compatible', label: 'OpenAI Compatible', modalities: ['tts', 'stt'], needsBaseUrl: true},
  {id: 'elevenlabs', label: 'ElevenLabs', modalities: ['tts', 'stt'], needsBaseUrl: false},
  {id: 'groq', label: 'Groq', modalities: ['stt'], needsBaseUrl: false}
];
const q = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const pick = (id: string, value: string) => {
  q(document, id).click();
  (document.querySelector(`[data-testid="${id}-option-${value}"]`) as HTMLElement).click();
};
const ok = (models: string[], voices: string[] = []) => ({ok: true, value: {ok: true, models: models.map(id => ({id})), voices}});
afterEach(() => document.body.replaceChildren());

it('one provider and one key for both directions, built from the kit, stored key shown as dots', async() => {
  const call = vi.fn(async(_m: string, p: any) => p.modality === 'tts' ? ok(['speech-a', 'speech-b'], ['alloy']) : ok(['listen-a']));
  const form = createVoiceForm(saved, providers, call);
  document.body.append(form.section);
  expect(form.section.querySelector('select')).toBeNull();
  expect([...form.section.querySelectorAll('button')].some((b) => /load models/i.test(b.textContent))).toBe(false);
  for(const id of ['voice-enabled', 'voice-provider', 'voice-base-url', 'voice-key', 'voice-active', 'voice-tts-model', 'voice-tts-voice', 'voice-stt-model', 'voice-status']) {
    expect(q(form.section, id), id).not.toBeNull();
  }
  expect(form.section.querySelectorAll('[data-testid="voice-key"]').length).toBe(1);
  const key = q(form.section, 'voice-key') as HTMLInputElement;
  expect(key.placeholder).toBe('••••••••••••');
  expect(key.value).toBe('');
  // The stored key is checked at once: a live Active check.
  await vi.waitFor(() => expect(q(form.section, 'voice-active').textContent).toBe('✓ Active'));
  expect(call).toHaveBeenCalledWith('check', {modality: 'tts', settings: expect.objectContaining({provider: 'openai-compatible'})});
  expect(call).toHaveBeenCalledWith('check', {modality: 'stt', settings: expect.objectContaining({provider: 'openai-compatible'})});
});

it('a typed key goes to both directions on save', async() => {
  const call = vi.fn(async(_m: string, p: any) => p.modality === 'tts' ? ok(['speech-a'], ['alloy']) : ok(['listen-a']));
  const form = createVoiceForm(saved, providers, call);
  document.body.append(form.section);
  const key = q(form.section, 'voice-key') as HTMLInputElement;
  key.value = 'new-key'; key.dispatchEvent(new Event('input')); key.dispatchEvent(new Event('blur'));
  await vi.waitFor(() => expect(q(form.section, 'voice-active').textContent).toBe('✓ Active'));
  const v = form.value();
  expect(v.tts).toMatchObject({enabled: true, apiKey: 'new-key', model: 'speech-a', voice: 'alloy', baseUrl: 'https://audio.example/v1'});
  expect(v.stt).toMatchObject({enabled: true, apiKey: 'new-key', model: 'listen-a'});
});

it('a rejected key shows the red check', async() => {
  const call = vi.fn(async() => ({ok: true, value: {ok: false, error: '401 Unauthorized — wrong key', models: [] as unknown[], voices: [] as string[]}}));
  const form = createVoiceForm(saved, providers, call);
  document.body.append(form.section);
  await vi.waitFor(() => expect(q(form.section, 'voice-active').dataset.state).toBe('invalid'));
  expect(q(form.section, 'voice-active').textContent).toContain('Key rejected');
});

it('a provider with only STT hides TTS and saves TTS off', async() => {
  const call = vi.fn(async() => ok(['whisper-large-v3']));
  const form = createVoiceForm(saved, providers, call);
  document.body.append(form.section);
  pick('voice-provider', 'groq');
  expect(q(form.section, 'voice-tts').style.display).toBe('none');
  expect(q(form.section, 'voice-stt').style.display).toBe('');
  const key = q(form.section, 'voice-key') as HTMLInputElement;
  expect(key.placeholder).toBe('');
  key.value = 'gsk'; key.dispatchEvent(new Event('input')); key.dispatchEvent(new Event('blur'));
  await vi.waitFor(() => expect(q(form.section, 'voice-stt-model-value').textContent).toBe('whisper-large-v3'));
  const groq = call.mock.calls.filter(([, p]: any) => p.settings.provider === 'groq');
  expect(groq.length).toBeGreaterThan(0);
  expect(groq.every(([, p]: any) => p.modality === 'stt')).toBe(true);
  const v = form.value();
  expect(v.tts).toEqual({enabled: false});
  expect(v.stt).toMatchObject({enabled: true, provider: 'groq', baseUrl: '', apiKey: 'gsk', model: 'whisper-large-v3'});
});

it('does not let a stale check overwrite the new provider', async() => {
  let rejectOld: (err: Error) => void;
  const call = vi.fn()
  .mockImplementationOnce(() => new Promise((_, reject) => rejectOld = reject))
  .mockImplementationOnce(() => new Promise(() => {}))
  .mockImplementation(async(_m: string, p: any) => p.modality === 'tts' ? ok(['eleven-model'], ['daniel']) : ok(['scribe_v1']));
  const form = createVoiceForm(saved, providers, call);
  document.body.append(form.section);
  pick('voice-provider', 'elevenlabs');
  const key = q(form.section, 'voice-key') as HTMLInputElement;
  key.value = 'new-key'; key.dispatchEvent(new Event('input')); key.dispatchEvent(new Event('blur'));
  await vi.waitFor(() => expect(q(form.section, 'voice-tts-model-value').textContent).toBe('eleven-model'));
  rejectOld(new Error('old rejected-key status')); await new Promise(resolve => setTimeout(resolve, 0));
  expect(q(form.section, 'voice-active').textContent).toBe('✓ Active');
  expect(form.value().tts).toMatchObject({provider: 'elevenlabs', baseUrl: '', model: 'eleven-model', voice: 'daniel'});
  form.dispose(); expect(key.value).toBe('');
});

it('disabled: an off-only patch for both directions', () => {
  const form = createVoiceForm(saved, providers, vi.fn(async() => ok([])));
  (q(form.section, 'voice-enabled') as HTMLInputElement).checked = false;
  expect(form.value()).toEqual({tts: {enabled: false}, stt: {enabled: false}});
});

it('contact pickers: enabled directions only, and a gated Voice ID for a local contact', async() => {
  const parent = document.createElement('div'); document.body.append(parent);
  const call = vi.fn(async(method: string, params: any) => {
    if(method === 'contact') return {ok: true, value: {persona: 'contact', settings: {tts: {...savedTts, models: [{id: 'speech-a'}, {id: 'speech-b'}]}, stt: {...savedStt, enabled: false}}, overrides: {tts: {model: 'speech-b', voice: 'echo'}}}};
    if(method === 'check') return ok([], params.settings.model === 'speech-b' ? ['echo', 'nova'] : []);
    return {ok: true, value: {}};
  });
  await mountContactVoiceModels(parent, 'a'.repeat(64), call);
  expect(parent.querySelector('select')).toBeNull();
  expect(q(parent, 'contact-tts-model-value').textContent).toBe('speech-b');
  expect(q(parent, 'contact-stt-model')).toBeNull();
  await vi.waitFor(() => expect(q(parent, 'contact-tts-voice-value').textContent).toBe('echo'));
  pick('contact-tts-voice', 'nova');
  q(parent, 'contact-voice-save').click();
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('setContact', {pubkey: 'a'.repeat(64), models: {tts: 'speech-b'}, voices: {tts: 'nova'}}));
  // A model with no voice list hides the Voice ID.
  pick('contact-tts-model', 'speech-a');
  await vi.waitFor(() => expect(q(parent, 'contact-tts-voice').parentElement!.style.display).toBe('none'));
});

it('no Voice ID for a remote Phantom', async() => {
  const parent = document.createElement('div'); document.body.append(parent);
  const call = vi.fn(async(method: string) => method === 'contact' ?
    {ok: true, value: {persona: null as string | null, settings: {tts: savedTts, stt: {...savedStt, enabled: false}}, overrides: {}}} : ok([], ['x']));
  await mountContactVoiceModels(parent, 'a'.repeat(64), call);
  expect(q(parent, 'contact-tts-voice')).toBeNull();
});

it('shows no picker when both directions are disabled', async() => {
  const parent = document.createElement('div');
  const call = vi.fn().mockResolvedValue({ok: true, value: {persona: 'contact', settings: {tts: {...saved, enabled: false}, stt: {...saved, enabled: false}}, overrides: {}}});
  await mountContactVoiceModels(parent, 'a'.repeat(64), call);
  expect(parent.children.length).toBe(0);
});

vi.mock('@lib/phantomchat/virtual-peers-db', () => ({
  getAllMappings: async() => [
    {pubkey: 'a'.repeat(64)}, {pubkey: 'b'.repeat(64)},
    {pubkey: 'c'.repeat(64), deliberateAddAt: 20}, {pubkey: 'd'.repeat(64)}
  ],
  listDeletedPeers: async() => [{pubkey: 'b'.repeat(64), deletedAt: 10}, {pubkey: 'c'.repeat(64), deletedAt: 10}]
}));
vi.mock('@lib/phantomchat/contact-kind', () => ({resolveContactKindForPeer: async() => ({kind: 'phantom'})}));
it('selects current Phantom contacts, excluding self/deleted peers and retaining deliberate re-adds', async() => {
  const {listPhantomVoiceTargets} = await import('@lib/phantomchat/voice-models');
  (window as any).__phantomchatOwnPubkey = 'd'.repeat(64);
  try {expect(await listPhantomVoiceTargets()).toEqual(['a'.repeat(64), 'c'.repeat(64)]);}
  finally {delete (window as any).__phantomchatOwnPubkey;}
});
it('applies defaults to Phantoms with no prior override, skips local personas and reports remote failures', async() => {
  const {applyRemoteVoiceDefaults} = await import('@lib/phantomchat/voice-models');
  const {requestRemoteVoiceModels} = await import('@lib/phantomchat/voice-models-remote');
  vi.mocked(requestRemoteVoiceModels).mockImplementation(async pubkey => {
    if(pubkey === 'd'.repeat(64)) throw new Error('offline');
    return {};
  });
  const call = vi.fn(async(method, params: any) => ({ok: true, value: method === 'contact' ? {persona: params.pubkey === 'a'.repeat(64) ? 'local' : null} : {tts: {model: 'default'}}}));
  const result = await applyRemoteVoiceDefaults(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64)], ['b'.repeat(64)], call);
  expect(result).toEqual({applied: 2, failures: ['Remote dddddddd']});
  expect(call).toHaveBeenCalledWith('saveRemote', {pubkey: 'c'.repeat(64), models: {}});
  expect(call).not.toHaveBeenCalledWith('saveRemote', {pubkey: 'b'.repeat(64), models: {}});
});
