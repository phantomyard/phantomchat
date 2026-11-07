/**
 * Provider contact info: change the main provider and model after creation.
 * The stored token stays in the engine (persona.brain / persona.brainCheck).
 */
import 'fake-indexeddb/auto';
import {afterEach, expect, it, vi} from 'vitest';
vi.mock('@lib/apiManagerProxy', () => {
  const anyObj: any = new Proxy(function() {}, {
    get: (_t, prop) => prop === 'then' ? undefined : anyObj,
    apply: () => anyObj
  });
  return {default: anyObj};
});
vi.mock('@components/row', () => ({default: class {
  container = document.createElement('label');
}}));
import {mountProviderModelEditor} from '@lib/phantomchat/provider-contact-editor';

const q = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const pick = (id: string, value: string) => {
  q(document, id).click();
  (document.querySelector(`[data-testid="${id}-option-${value}"]`) as HTMLElement).click();
};
afterEach(() => document.body.replaceChildren());

function fakeCall(brain: any = {provider: 'openrouter', model: 'a/b', hasKey: true}) {
  return vi.fn(async(method: string, params?: any): Promise<any> => {
    switch(method) {
      case 'persona.brain': return {ok: true, value: brain};
      case 'providers.list': return {ok: true, value: [
        {id: 'openrouter', label: 'OpenRouter', checkable: true},
        {id: 'anthropic', label: 'Anthropic', checkable: true}
      ]};
      case 'persona.brainCheck': return {ok: true, value: {status: 'verified', detail: 'ok', models: [{id: 'a/b'}, {id: 'c/d'}]}};
      case 'providers.check': return {ok: true, value: params.apiKey === 'bad' ?
        {status: 'invalid', detail: 'HTTP 401', models: []} :
        {status: 'verified', detail: 'ok', models: [{id: 'claude-x'}]}};
      case 'persona.configure': return {ok: true, value: null};
    }
    return {ok: false, error: {code: 'x', message: 'unexpected ' + method}};
  });
}

it('shows the current provider, dots for the stored token and a live Active check; a model change keeps the token', async() => {
  const call = fakeCall();
  const parent = document.createElement('div'); document.body.append(parent);
  const editor = await mountProviderModelEditor(parent, 'bob', call);
  expect(editor).toBeTruthy();
  expect(q(parent, 'provider-contact-provider-value').textContent).toBe('OpenRouter');
  expect((q(parent, 'provider-contact-token') as HTMLInputElement).placeholder).toBe('••••••••••••');
  await vi.waitFor(() => expect(q(parent, 'provider-contact-active').textContent).toBe('✓ Active'));
  expect(call).toHaveBeenCalledWith('persona.brainCheck', {persona: 'bob'});
  expect(call.mock.calls.some(([m]) => m === 'providers.check')).toBe(false);
  pick('provider-contact-model-picker', 'c/d');
  await editor!.save();
  expect(call).toHaveBeenCalledWith('persona.configure', {persona: 'bob', config: {brain: {chain: ['native'], native: {provider: 'openrouter', model: 'c/d'}}}});
});

it('a new provider needs its own token, checked before save', async() => {
  const call = fakeCall();
  const parent = document.createElement('div'); document.body.append(parent);
  const editor = await mountProviderModelEditor(parent, 'bob', call);
  pick('provider-contact-provider', 'anthropic');
  const token = q(parent, 'provider-contact-token') as HTMLInputElement;
  expect(token.placeholder).toBe('');
  await editor!.save();
  expect(q(parent, 'provider-contact-status').textContent).toBe('Choose a model');
  token.value = 'bad'; token.dispatchEvent(new Event('input')); token.dispatchEvent(new Event('blur'));
  await vi.waitFor(() => expect(q(parent, 'provider-contact-active').dataset.state).toBe('invalid'));
  token.value = 'sk-ant'; token.dispatchEvent(new Event('input')); token.dispatchEvent(new Event('blur'));
  await vi.waitFor(() => expect(q(parent, 'provider-contact-active').textContent).toBe('✓ Active'));
  await editor!.save();
  expect(call).toHaveBeenCalledWith('persona.configure', {persona: 'bob', config: {brain: {chain: ['native'], native: {provider: 'anthropic', model: 'claude-x', apiKey: 'sk-ant'}}}});
  expect(token.value).toBe('');
  expect(q(parent, 'provider-contact-status').textContent).toBe('Now on Anthropic (claude-x)');
});

it('an older engine mounts nothing', async() => {
  const call = vi.fn(async() => ({ok: false, error: {code: 'not_supported', message: 'Update the engine'}}));
  const parent = document.createElement('div');
  expect(await mountProviderModelEditor(parent, 'bob', call as any)).toBeUndefined();
  expect(parent.children.length).toBe(0);
});
