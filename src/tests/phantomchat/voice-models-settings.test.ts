import {afterEach, expect, it, vi} from 'vitest';
vi.mock('@lib/phantomchat/voice-models-remote', () => ({requestRemoteVoiceModels: vi.fn()}));
import {createVoiceDirectionForm, mountContactVoiceModels} from '@lib/phantomchat/voice-models';
const saved = {enabled: true, provider: 'openai-compatible', baseUrl: 'https://audio.example/v1', model: 'speech-a', voice: 'alloy', models: [{id: 'speech-a'}], voices: ['alloy']};
const providers = [{id: 'openai-compatible', label: 'OpenAI Compatible', modalities: ['tts', 'stt']}, {id: 'elevenlabs', label: 'ElevenLabs', modalities: ['tts']}];
const input = <T extends HTMLElement>(parent: HTMLElement, label: string) => Array.from(parent.querySelectorAll('label')).find(x => x.firstChild?.textContent === label)?.lastElementChild as T;
afterEach(() => document.body.replaceChildren());
it('does not let a stale provider rejection overwrite the new catalogue or status', async() => {
  const parent = document.createElement('div'); document.body.append(parent);
  let rejectOld: (err: Error) => void;
  const call = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => rejectOld = reject)).mockResolvedValue({ok: true, value: {ok: true, models: [{id: 'eleven-model'}], voices: ['daniel']}});
  const form = createVoiceDirectionForm(parent, 'tts', saved, providers, call);
  parent.querySelector('button').click();
  const provider = input<HTMLSelectElement>(parent, 'Provider'); provider.value = 'elevenlabs'; provider.dispatchEvent(new Event('change'));
  const key = input<HTMLInputElement>(parent, 'API key (leave blank to keep saved key)'); key.value = 'new-key'; key.dispatchEvent(new Event('input'));
  parent.querySelector('button').click(); await vi.waitFor(() => expect(input<HTMLSelectElement>(parent, 'Model').value).toBe('eleven-model'));
  rejectOld(new Error('old rejected-key status')); await new Promise(resolve => setTimeout(resolve, 0));
  expect(parent.querySelector('[role=status]').textContent).not.toContain('old');
  expect(form.value()).toMatchObject({provider: 'elevenlabs', model: 'eleven-model', voice: 'daniel'});
  form.dispose(); expect(key.value).toBe('');
});
it('keeps modalities separate and returns an off-only patch when disabled', () => {
  const parent = document.createElement('div');
  const form = createVoiceDirectionForm(parent, 'stt', saved, providers, vi.fn());
  expect(input<HTMLSelectElement>(parent, 'Provider').options.length).toBe(1);
  const enabled = input<HTMLInputElement>(parent, 'Enabled'); enabled.checked = false; enabled.dispatchEvent(new Event('change'));
  expect(form.value()).toEqual({enabled: false});
});
it('mounts the shared Phantom/Provider contact selectors only for enabled directions and saves inheritance', async() => {
  const parent = document.createElement('div');
  const call = vi.fn().mockResolvedValue({ok: true, value: {persona: 'contact', settings: {tts: {...saved, models: [{id: 'speech-a'}, {id: 'speech-b'}]}, stt: {...saved, enabled: false}}, overrides: {tts: {model: 'speech-b'}}}});
  await mountContactVoiceModels(parent, 'a'.repeat(64), call);
  const model = parent.querySelector<HTMLSelectElement>('[data-testid=contact-tts-model]');
  expect(model.value).toBe('speech-b');
  expect(parent.querySelector('[data-testid=contact-stt-model]')).toBeNull();
  model.value = ''; parent.querySelector('button').click();
  await vi.waitFor(() => expect(call).toHaveBeenCalledWith('setContact', {pubkey: 'a'.repeat(64), models: {tts: ''}}));
});
it('shows no selector when both directions are disabled', async() => {
  const parent = document.createElement('div');
  const call = vi.fn().mockResolvedValue({ok: true, value: {persona: 'contact', settings: {tts: {...saved, enabled: false}, stt: {...saved, enabled: false}}, overrides: {}}});
  await mountContactVoiceModels(parent, 'a'.repeat(64), call);
  expect(parent.querySelector('select')).toBeNull();
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
