/*
 * The New Contact pane's Voice ID (Provider type): which voices a new
 * contact is offered, and the pick applied once it exists.
 */
import {describe, expect, it, vi} from 'vitest';
// The real picker pulls in the whole app; a minimal one is enough here.
vi.mock('@components/sidebarLeft/tabs/phantomchatModelKit', () => ({
  labelledPicker: () => {
    let options: {value: string}[] = [];
    let current = '';
    const state = {placeholder: '', disabled: false};
    // The placeholder is what a disabled picker shows, so it is the text here.
    const container = document.createElement('div');
    return {
      container,
      picker: {
        setOptions: (o: {value: string}[], v?: string) => {options = o; current = v ?? '';},
        getValue: () => current,
        getOptions: () => options,
        setPlaceholder: (t: string) => {state.placeholder = t; container.textContent = t;},
        setDisabled: (d: boolean) => {state.disabled = d;},
        state,
        destroy: () => {}
      }
    };
  }
}));
vi.mock('@lib/phantomchat/desktop-api', () => ({getDesktopVoiceModels: (): null => null}));
import {applyNewContactVoice, createContactVoicePicker, createNewContactVoicePicker, newContactVoiceHint, newContactVoices, VOICE_SETUP_HINT} from '@lib/phantomchat/voice-models';

const voiceCall = (settings: any) => vi.fn(async(method: string) => method === 'get' ? {ok: true, value: settings} : {ok: true, value: {}});
const on = {tts: {enabled: true, voices: ['alloy', 'echo']}, stt: {enabled: true}};

describe('new contact voices', () => {
  it('a Provider contact gets the Voice Models voices when it is on', async() => {
    const bridge = vi.fn();
    expect(await newContactVoices('openrouter', '', bridge, voiceCall(on))).toEqual(['alloy', 'echo']);
    expect(await newContactVoices('openrouter', '', bridge, voiceCall({tts: {enabled: false}, stt: {enabled: false}}))).toBeUndefined();
    expect(await newContactVoices('openrouter', '', bridge, undefined)).toBeUndefined();
    expect(bridge).not.toHaveBeenCalled();
  });

  it('a PhantomOps contact gets its server voices with no Voice Models setup', async() => {
    const bridge = vi.fn(async() => ({ok: true, value: {status: 'available', stt: 'w', tts: {model: 't', voices: ['nova']}}}));
    const off = voiceCall({tts: {enabled: false}, stt: {enabled: false}});
    expect(await newContactVoices('phantomops', 'pok_x', bridge, off)).toEqual(['nova']);
    expect(bridge).toHaveBeenCalledWith('platformModels.check', {apiKey: 'pok_x'});
    expect(off).not.toHaveBeenCalled();
  });

  it('PhantomOps: no token, no server voices or an old engine means no picker', async() => {
    expect(await newContactVoices('phantomops', '', vi.fn(), voiceCall(on))).toBeUndefined();
    const noStt = vi.fn(async() => ({ok: true, value: {status: 'available', tts: {model: 't', voices: ['nova']}}}));
    expect(await newContactVoices('phantomops', 'pok_x', noStt)).toBeUndefined();
    const old = vi.fn(async() => ({ok: false, error: {message: 'Update the engine'}}));
    expect(await newContactVoices('phantomops', 'pok_x', old)).toBeUndefined();
  });

  it('the picker is hidden until it has voices and reads "" when hidden', () => {
    const picker = createNewContactVoicePicker();
    expect(picker.container.style.display).toBe('none');
    picker.setVoices(['nova']);
    expect(picker.container.style.display).toBe('');
    expect(picker.value()).toBe('');
    picker.setVoices(undefined);
    expect(picker.value()).toBe('');
    picker.destroy();
  });

  it('no voices yet: greyed out with the reason, never offered, never hidden', () => {
    const picker = createNewContactVoicePicker();
    picker.setVoices(undefined, newContactVoiceHint('openrouter', ''));
    expect(picker.container.style.display).toBe('');
    expect(picker.container.textContent).toContain(VOICE_SETUP_HINT);
    expect(picker.visible()).toBe(false);
    expect(picker.value()).toBe('');
    picker.setVoices(['nova']);
    expect(picker.visible()).toBe(true);
    picker.setVoices(undefined);
    expect(picker.container.style.display).toBe('none');
    expect(newContactVoiceHint('phantomops', '')).toBe('Check the token to load voices');
    expect(newContactVoiceHint('phantomops', 'pok_x')).toContain('no voices');
    picker.destroy();
  });

  it('applies a pick through setContact, and nothing for "no voice"', async() => {
    const call = vi.fn(async() => ({ok: true, value: {}}));
    await applyNewContactVoice('ab'.repeat(32), '', call);
    expect(call).not.toHaveBeenCalled();
    await applyNewContactVoice('ab'.repeat(32), 'nova', call);
    expect(call).toHaveBeenCalledWith('setContact', {pubkey: 'ab'.repeat(32), voice: 'nova'});
  });
});

describe('Edit pane Voice ID of a PhantomOps contact', () => {
  const PUB = 'ab'.repeat(32);
  it('a server that has not answered shows "Loading voices..." and fills in when it does', async() => {
    let answer!: (v: any) => void;
    const call = vi.fn(async(method: string, params?: any) => {
      if(method === 'contact' && !params.wait) return {ok: true, value: {persona: 'ops', enabled: false, voices: [] as string[], voice: '', phantomops: true, pending: true}};
      if(method === 'contact') return new Promise<any>((r) => { answer = r; });
      return {ok: true, value: {}};
    });
    const picker = await createContactVoicePicker(PUB, call);
    expect(picker).toBeDefined();
    expect(picker!.container.style.display).not.toBe('none');
    expect(call).toHaveBeenCalledWith('contact', {pubkey: PUB, wait: true});
    expect(picker!.changed()).toBe(false);
    answer({ok: true, value: {persona: 'ops', enabled: true, voices: ['bill'], voice: 'bill', phantomops: true}});
    await new Promise((r) => setTimeout(r, 0));
    expect(picker!.value()).toBe('bill');
    expect(picker!.changed()).toBe(false);
  });

  it('a server that answers with no voices, or not at all, shows it disabled with why', async() => {
    const call = (later: any) => vi.fn(async(method: string, params?: any) => method === 'contact' && !params.wait ?
      {ok: true, value: {persona: 'ops', enabled: false, voices: [] as string[], voice: '', phantomops: true, pending: true}} :
      {ok: true, value: later});
    const none = await createContactVoicePicker(PUB, call({persona: 'ops', enabled: false, voices: [], voice: '', phantomops: true}));
    await new Promise((r) => setTimeout(r, 0));
    expect(none!.container.style.display).not.toBe('none');
    expect(none!.container.textContent).toContain('Could not load voices (no voice models)');

    const down = await createContactVoicePicker(PUB, call({persona: 'ops', enabled: false, voices: [], voice: '', phantomops: true, unavailable: 'HTTP 502'}));
    await new Promise((r) => setTimeout(r, 0));
    expect(down!.container.style.display).not.toBe('none');
    expect(down!.container.textContent).toContain('Could not load voices (HTTP 502)');
    expect(down!.value()).toBe('');
  });

  it('a server that answered with no voice models shows the picker disabled with why', async() => {
    const call = vi.fn(async() => ({ok: true, value: {persona: 'ops', enabled: false, voices: [] as string[], voice: '', phantomops: true,
      unavailable: 'this PhantomOps server has no voices'}}));
    const picker = await createContactVoicePicker(PUB, call);
    expect(picker).toBeDefined();
    expect(picker!.container.textContent).toContain('Could not load voices (this PhantomOps server has no voices)');
    expect(picker!.changed()).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('a contact lookup that fails shows the picker disabled with the error, never nothing', async() => {
    const threw = await createContactVoicePicker(PUB, vi.fn(async() => { throw new Error('bridge gone'); }));
    expect(threw!.container.textContent).toContain('Could not load voices (bridge gone)');
    const refused = await createContactVoicePicker(PUB, vi.fn(async() => ({ok: false, error: {message: 'Could not identify this contact (x: down)'}})));
    expect(refused!.container.textContent).toContain('Could not load voices (Could not identify this contact (x: down))');
    expect(refused!.value()).toBe('');
    expect(refused!.changed()).toBe(false);
  });

  it('a non-PhantomOps contact whose provider cannot be read says so too', async() => {
    const call = vi.fn(async() => ({ok: true, value: {persona: 'barry', enabled: false, voices: [] as string[], voice: '',
      unavailable: "Could not read this contact's provider (brain unreadable)"}}));
    const picker = await createContactVoicePicker(PUB, call);
    expect(picker!.container.textContent).toContain("Could not load voices (Could not read this contact's provider (brain unreadable))");
  });
});
