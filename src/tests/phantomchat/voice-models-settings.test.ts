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
import {createVoiceDirectionForm, mountContactVoiceModels} from '@lib/phantomchat/voice-models';

const saved = {enabled: true, provider: 'openai-compatible', baseUrl: 'https://audio.example/v1', model: 'speech-a', voice: 'alloy', models: [{id: 'speech-a'}], voices: ['alloy'], hasKey: true};
const providers = [{id: 'openai-compatible', label: 'OpenAI Compatible', modalities: ['tts', 'stt']}, {id: 'elevenlabs', label: 'ElevenLabs', modalities: ['tts']}];
const q = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const pick = (id: string, value: string) => {
  q(document, id).click();
  (document.querySelector(`[data-testid="${id}-option-${value}"]`) as HTMLElement).click();
};
afterEach(() => document.body.replaceChildren());

it('is built from the kit: toggle Row, list pickers, no raw select and no Load models button', () => {
  const form = createVoiceDirectionForm('tts', saved, providers, vi.fn());
  document.body.append(form.section);
  expect(form.section.querySelector('select')).toBeNull();
  expect(form.section.querySelector('fieldset')).toBeNull();
  expect([...form.section.querySelectorAll('button')].some((b) => /load models/i.test(b.textContent))).toBe(false);
  for(const id of ['voice-tts-enabled', 'voice-tts-provider', 'voice-tts-base-url', 'voice-tts-key', 'voice-tts-model', 'voice-tts-voice', 'voice-tts-status']) {
    expect(q(form.section, id), id).not.toBeNull();
  }
  // The saved choice shows without a network call.
  expect(q(form.section, 'voice-tts-model-value').textContent).toBe('speech-a');
  expect(q(form.section, 'voice-tts-voice-value').textContent).toBe('alloy');
  expect(q(form.section, 'voice-tts-key-note').textContent).toBe('Key saved. Leave empty to keep it.');
});

it('leaving the key field loads the catalogue, as Decision Model does', async() => {
  const call = vi.fn().mockResolvedValue({ok: true, value: {ok: true, models: [{id: 'speech-a'}, {id: 'speech-b'}], voices: ['alloy', 'nova']}});
  const form = createVoiceDirectionForm('tts', saved, providers, call);
  document.body.append(form.section);
  const key = q(form.section, 'voice-tts-key') as HTMLInputElement;
  key.value = 'new-key'; key.dispatchEvent(new Event('input')); key.dispatchEvent(new Event('blur'));
  await vi.waitFor(() => expect(q(form.section, 'voice-tts-status').textContent).toBe('Key verified'));
  expect(call).toHaveBeenCalledWith('check', {modality: 'tts', settings: expect.objectContaining({apiKey: 'new-key', baseUrl: 'https://audio.example/v1'})});
  expect(form.value()).toMatchObject({model: 'speech-a', voice: 'alloy', apiKey: 'new-key'});
});

it('does not let a stale provider rejection overwrite the new catalogue or status', async() => {
  let rejectOld: (err: Error) => void;
  const call = vi.fn()
  .mockImplementationOnce(() => new Promise((_, reject) => rejectOld = reject))
  .mockResolvedValue({ok: true, value: {ok: true, models: [{id: 'eleven-model'}], voices: ['daniel']}});
  const form = createVoiceDirectionForm('tts', saved, providers, call);
  document.body.append(form.section);
  const key = q(form.section, 'voice-tts-key') as HTMLInputElement;
  key.dispatchEvent(new Event('blur')); // stored key: first check, left hanging
  pick('voice-tts-provider', 'elevenlabs');
  key.value = 'new-key'; key.dispatchEvent(new Event('input')); key.dispatchEvent(new Event('blur'));
  await vi.waitFor(() => expect(q(form.section, 'voice-tts-model-value').textContent).toBe('eleven-model'));
  rejectOld(new Error('old rejected-key status')); await new Promise(resolve => setTimeout(resolve, 0));
  expect(q(form.section, 'voice-tts-status').textContent).not.toContain('old');
  expect(form.value()).toMatchObject({provider: 'elevenlabs', baseUrl: '', model: 'eleven-model', voice: 'daniel'});
  form.dispose(); expect(key.value).toBe('');
});

it('no catalogue: the model is typed, and typing it loads its voices', async() => {
  const call = vi.fn()
  .mockResolvedValueOnce({ok: true, value: {ok: true, models: [], voices: []}})
  .mockResolvedValue({ok: true, value: {ok: true, models: [], voices: ['v1']}});
  const form = createVoiceDirectionForm('tts', {...saved, model: '', voice: '', models: [], voices: [], hasKey: false}, providers, call);
  document.body.append(form.section);
  const key = q(form.section, 'voice-tts-key') as HTMLInputElement;
  key.value = 'k'; key.dispatchEvent(new Event('blur'));
  await vi.waitFor(() => expect(q(form.section, 'voice-tts-status').textContent).toContain('type a model ID'));
  const typed = q(form.section, 'voice-tts-model-typed') as HTMLInputElement;
  typed.value = 'my-tts'; typed.dispatchEvent(new Event('blur'));
  await vi.waitFor(() => expect(q(form.section, 'voice-tts-voice-value').textContent).toBe('v1'));
  expect(form.value()).toMatchObject({model: 'my-tts', voice: 'v1'});
});

it('keeps modalities separate and returns an off-only patch when disabled', () => {
  const form = createVoiceDirectionForm('stt', saved, providers, vi.fn());
  document.body.append(form.section);
  q(form.section, 'voice-stt-provider').click();
  expect(document.querySelector('[data-testid="voice-stt-provider-option-elevenlabs"]')).toBeNull();
  expect(q(form.section, 'voice-stt-voice')).toBeNull();
  (q(form.section, 'voice-stt-enabled') as HTMLInputElement).checked = false;
  expect(form.value()).toEqual({enabled: false});
});

it('mounts the shared Phantom/Provider contact pickers only for enabled directions and saves inheritance', async() => {
  const parent = document.createElement('div'); document.body.append(parent);
  const call = vi.fn().mockResolvedValue({ok: true, value: {persona: 'contact', settings: {tts: {...saved, models: [{id: 'speech-a'}, {id: 'speech-b'}]}, stt: {...saved, enabled: false}}, overrides: {tts: {model: 'speech-b'}}}});
  await mountContactVoiceModels(parent, 'a'.repeat(64), call);
  expect(parent.querySelector('select')).toBeNull();
  expect(q(parent, 'contact-tts-model-value').textContent).toBe('speech-b');
  expect(q(parent, 'contact-stt-model')).toBeNull();
  pick('contact-tts-model', '');
  q(parent, 'contact-voice-save').click();
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('setContact', {pubkey: 'a'.repeat(64), models: {tts: ''}}));
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
