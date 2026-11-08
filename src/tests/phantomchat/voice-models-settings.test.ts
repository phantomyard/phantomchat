/**
 * Settings > Specialized Models > Voice Models: one switch, one provider and
 * key, a TTS and an STT model, no voice; and the gated Voice ID picker of a
 * Provider contact's Edit pane.
 */
import 'fake-indexeddb/auto';
import {afterEach, expect, it, vi} from 'vitest';
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
import {createVoiceForm, createContactVoicePicker} from '@lib/phantomchat/voice-models';
import {mountVoiceModels} from '@components/sidebarLeft/tabs/phantomchatVoiceModels';

const savedTts = {enabled: true, provider: 'openai-compatible', baseUrl: 'https://audio.example/v1', model: 'speech-a', models: [{id: 'speech-a'}], voices: ['alloy'], hasKey: true};
const savedStt = {...savedTts, model: 'listen-a', models: [{id: 'listen-a'}], voices: [] as string[]};
const saved = {tts: savedTts, stt: savedStt};
const providers = [
  {id: 'openai-compatible', label: 'OpenAI Compatible', modalities: ['tts', 'stt'], needsBaseUrl: true},
  {id: 'elevenlabs', label: 'ElevenLabs', modalities: ['tts', 'stt'], needsBaseUrl: false}
];
const q = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const pick = (id: string, value: string) => {
  q(document, id).click();
  (document.querySelector(`[data-testid="${id}-option-${value}"]`) as HTMLElement).click();
};
const ok = (models: string[], voices: string[] = []) => ({ok: true, value: {ok: true, models: models.map(id => ({id})), voices}});
afterEach(() => document.body.replaceChildren());

it('one switch, one provider and key, a TTS and an STT model; no voice picker, no Active badge', async() => {
  const call = vi.fn(async(_m: string, p: any) => p.modality === 'tts' ? ok(['speech-a', 'speech-b'], ['alloy']) : ok(['listen-a']));
  const form = createVoiceForm(saved, providers, call);
  document.body.append(form.section);
  expect(form.section.querySelector('select')).toBeNull();
  for(const id of ['voice-enabled', 'voice-provider', 'voice-base-url', 'voice-key', 'voice-tts-model', 'voice-stt-model', 'voice-status']) {
    expect(q(form.section, id), id).not.toBeNull();
  }
  for(const gone of ['voice-tts-enabled', 'voice-stt-enabled', 'voice-tts-voice', 'voice-active']) expect(q(form.section, gone), gone).toBeNull();
  expect(form.section.textContent).not.toContain('Active');
  const key = q(form.section, 'voice-key') as HTMLInputElement;
  expect(key.placeholder).toBe('••••••••••••');
  expect(key.value).toBe('');
  // Nothing is checked until the user acts: no badge, no call on open.
  expect(call).not.toHaveBeenCalled();
});

it('a typed key loads both model lists and goes to both directions', async() => {
  const call = vi.fn(async(_m: string, p: any) => p.modality === 'tts' ? ok(['speech-a'], ['alloy']) : ok(['listen-a']));
  const form = createVoiceForm(saved, providers, call);
  document.body.append(form.section);
  const key = q(form.section, 'voice-key') as HTMLInputElement;
  key.value = 'new-key'; key.dispatchEvent(new Event('input')); key.dispatchEvent(new Event('blur'));
  await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  const v = form.value();
  expect(v.tts).toMatchObject({enabled: true, apiKey: 'new-key', model: 'speech-a', baseUrl: 'https://audio.example/v1'});
  expect(v.tts).not.toHaveProperty('voice');
  expect(v.stt).toMatchObject({enabled: true, apiKey: 'new-key', model: 'listen-a'});
});

it('a rejected key says so in the status line', async() => {
  const call = vi.fn(async() => ({ok: true, value: {ok: false, error: '401 Unauthorized', models: [] as unknown[], voices: [] as string[]}}));
  const form = createVoiceForm(saved, providers, call);
  document.body.append(form.section);
  const key = q(form.section, 'voice-key') as HTMLInputElement;
  key.value = 'bad'; key.dispatchEvent(new Event('input')); key.dispatchEvent(new Event('blur'));
  await vi.waitFor(() => expect(q(form.section, 'voice-status').textContent).toContain('401'));
});

it('does not let a stale check overwrite the new provider', async() => {
  let resolveOld: (v: unknown) => void;
  const call = vi.fn()
  .mockImplementationOnce(() => new Promise((resolve) => resolveOld = resolve))
  .mockImplementationOnce(() => new Promise(() => {}))
  .mockImplementation(async(_m: string, p: any) => p.modality === 'tts' ? ok(['eleven-model'], ['daniel']) : ok(['scribe_v1']));
  const form = createVoiceForm(saved, providers, call);
  document.body.append(form.section);
  const key = q(form.section, 'voice-key') as HTMLInputElement;
  key.value = 'old'; key.dispatchEvent(new Event('input')); key.dispatchEvent(new Event('blur'));
  pick('voice-provider', 'elevenlabs');
  key.value = 'new-key'; key.dispatchEvent(new Event('input')); key.dispatchEvent(new Event('blur'));
  await vi.waitFor(() => expect(q(form.section, 'voice-tts-model-value').textContent).toBe('eleven-model'));
  resolveOld(ok(['old-model'])); await new Promise(resolve => setTimeout(resolve, 0));
  expect(form.value().tts).toMatchObject({provider: 'elevenlabs', baseUrl: '', model: 'eleven-model'});
  form.dispose(); expect(key.value).toBe('');
});

it('off: one switch turns both directions off', () => {
  const form = createVoiceForm(saved, providers, vi.fn(async() => ok([])));
  expect((q(form.section, 'voice-enabled') as HTMLInputElement).checked).toBe(true);
  (q(form.section, 'voice-enabled') as HTMLInputElement).checked = false;
  expect(form.value()).toEqual({tts: {enabled: false}, stt: {enabled: false}});
});

it('Test and Save: one button, tests then saves, never touches remote Phantoms', async() => {
  const parent = document.createElement('div'); document.body.append(parent);
  const call = vi.fn(async(method: string) => {
    if(method === 'get') return {ok: true, value: saved};
    if(method === 'providers') return {ok: true, value: providers};
    if(method === 'save') return {ok: true, value: {settings: saved, applied: 0, failures: [] as string[]}};
    return ok([]);
  });
  const page = await mountVoiceModels(parent, call);
  const buttons = [...parent.querySelectorAll('button.btn-primary')];
  expect(buttons.map(b => b.textContent)).toEqual(['Test and Save']);
  await page.save();
  expect(call).toHaveBeenCalledWith('save', expect.objectContaining({tts: expect.objectContaining({enabled: true}), stt: expect.objectContaining({enabled: true})}));
  expect(call.mock.calls.map(([m]) => m)).not.toContain('remotePlan');
  expect(q(parent, 'voice-models-status').textContent).toContain('Works. Saved');
  call.mockImplementationOnce(async() => ({ok: false, error: {message: 'Choose a current TTS model'}}) as any);
  await page.save();
  expect(q(parent, 'voice-models-status').textContent).toBe('Not saved: Choose a current TTS model');
  page.dispose();
});

it('contact Voice ID: shown for a Provider contact with Voice on, "No voice" clears it', async() => {
  const call = vi.fn(async(method: string) => method === 'contact' ?
    {ok: true, value: {persona: 'barry', enabled: true, voices: ['alloy', 'echo'], voice: 'alloy'}} : {ok: true, value: {}});
  const picker = (await createContactVoicePicker('a'.repeat(64), call))!;
  document.body.append(picker.container);
  expect(q(picker.container, 'contact-voice-id-value').textContent).toBe('alloy');
  expect(picker.changed()).toBe(false);
  pick('contact-voice-id', 'echo');
  expect(picker.changed()).toBe(true);
  await picker.save();
  expect(call).toHaveBeenCalledWith('setContact', {pubkey: 'a'.repeat(64), voice: 'echo'});
  expect(picker.changed()).toBe(false);
  expect(q(picker.container, 'contact-tts-model')).toBeNull();
  expect(q(picker.container, 'contact-stt-model')).toBeNull();
});

it('no Voice ID when Voice Models is off, or for an npub Phantom', async() => {
  const off = vi.fn(async() => ({ok: true, value: {persona: 'barry', enabled: false, voices: ['alloy'], voice: ''}}));
  expect(await createContactVoicePicker('a'.repeat(64), off)).toBeUndefined();
  const remote = vi.fn(async() => ({ok: true, value: {persona: null as string | null, enabled: true, voices: ['alloy'], voice: ''}}));
  expect(await createContactVoicePicker('a'.repeat(64), remote)).toBeUndefined();
});
