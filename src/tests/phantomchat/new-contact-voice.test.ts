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
    return {
      container: document.createElement('div'),
      picker: {
        setOptions: (o: {value: string}[], v?: string) => {options = o; current = v ?? '';},
        getValue: () => current,
        getOptions: () => options,
        destroy: () => {}
      }
    };
  }
}));
vi.mock('@lib/phantomchat/desktop-api', () => ({getDesktopVoiceModels: (): null => null}));
import {applyNewContactVoice, createNewContactVoicePicker, newContactVoices} from '@lib/phantomchat/voice-models';

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

  it('applies a pick through setContact, and nothing for "no voice"', async() => {
    const call = vi.fn(async() => ({ok: true, value: {}}));
    await applyNewContactVoice('ab'.repeat(32), '', call);
    expect(call).not.toHaveBeenCalled();
    await applyNewContactVoice('ab'.repeat(32), 'nova', call);
    expect(call).toHaveBeenCalledWith('setContact', {pubkey: 'ab'.repeat(32), voice: 'nova'});
  });
});
