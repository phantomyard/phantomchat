/**
 * Settings > Decision Model (issue #449): the desktop-only row, and the form
 * that sends a key to main once and afterwards only learns `hasKey`.
 */
import 'fake-indexeddb/auto';
import {describe, it, expect, vi, afterEach} from 'vitest';
import type {DecisionModelState, DesktopDecisionModelApi} from '@lib/phantomchat/desktop-api';
import {getDesktopDecisionModel} from '@lib/phantomchat/desktop-api';
import {createDecisionModelForm} from '@components/sidebarLeft/tabs/phantomchatDecisionModel';

// The form's Row/InputField pull in the worker proxy and the app state store,
// which jsdom cannot start (see contacts-redesign.test.ts).
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


const UNCONFIGURED: DecisionModelState = {
  configured: false, enabled: false, provider: 'openrouter', model: 'typesafe/jev-1.13', hasKey: false, canStoreKey: true
};

function fakeApi(initial: DecisionModelState = UNCONFIGURED) {
  let state = initial;
  const api = {
    get: vi.fn(async() => state),
    check: vi.fn(async(_provider: string, apiKey: string) => apiKey === 'bad' ?
      {ok: true as const, value: {status: 'invalid' as const, detail: 'HTTP 401', models: [] as string[]}} :
      {ok: true as const, value: {status: 'verified' as const, detail: 'ok', models: ['typesafe/jev-1.13', 'liquid/d1']}}),
    save: vi.fn(async(input: {enabled: boolean; provider: string; model: string; apiKey?: string}) => {
      state = {configured: true, enabled: input.enabled, provider: input.provider as any, model: input.model, hasKey: state.hasKey || !!input.apiKey, canStoreKey: true};
      return {ok: true as const, state, applied: 2, failed: [] as {persona: string; error: string}[]};
    })
  } satisfies DesktopDecisionModelApi;
  return api;
}

const q = (root: HTMLElement, id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement;

describe('Settings > Decision Model', () => {
  afterEach(() => {
    delete (window as any).phantomchatDesktop;
    document.body.innerHTML = '';
  });

  it('exists only where the desktop exposes the API', () => {
    expect(getDesktopDecisionModel()).toBeNull();
    (window as any).phantomchatDesktop = {getVersion: async() => '1'};
    expect(getDesktopDecisionModel()).toBeNull();
    const api = fakeApi();
    (window as any).phantomchatDesktop = {decisionModel: api};
    expect(getDesktopDecisionModel()).toBe(api);
  });

  it('a typed key is checked, fills the models, and is sent once on save; the field is cleared after', async() => {
    const api = fakeApi();
    const form = createDecisionModelForm(api);
    document.body.append(form.section);
    await form.ready;
    const key = q(form.section, 'decision-model-key') as HTMLInputElement;
    key.value = 'sk-or-1';
    await form.loadModels();
    expect(api.check).toHaveBeenLastCalledWith('openrouter', 'sk-or-1');
    // No standing Active badge: the button is Test and Apply.
    expect(q(form.section, 'decision-model-active')).toBeNull();
    expect(q(form.section, 'decision-model-save').textContent).toBe('Test and Apply');
    expect(q(form.section, 'decision-model-status').textContent).toBe('');
    (q(form.section, 'decision-model-enabled') as HTMLInputElement).checked = true;
    await form.save();
    expect(api.save).toHaveBeenCalledWith({enabled: true, provider: 'openrouter', model: 'typesafe/jev-1.13', apiKey: 'sk-or-1'});
    expect(q(form.section, 'decision-model-status').textContent).toBe('On: applied to 2 personas');
    expect(key.value).toBe('');
    expect(q(form.section, 'decision-model-key-note').textContent).toBe('Key saved. Leave empty to keep it.');
    expect((q(form.section, 'decision-model-key') as HTMLInputElement).placeholder).toBe('••••••••••••');
  });

  it('a rejected key says so and lists no models', async() => {
    const api = fakeApi();
    const form = createDecisionModelForm(api);
    await form.ready;
    (q(form.section, 'decision-model-key') as HTMLInputElement).value = 'bad';
    await form.loadModels();
    expect(q(form.section, 'decision-model-status').textContent).toBe('Key rejected (HTTP 401)');
  });

  it('Off saves without a key, so the stored one is kept', async() => {
    const api = fakeApi({configured: true, enabled: true, provider: 'openrouter', model: 'liquid/d1', hasKey: true, canStoreKey: true});
    const form = createDecisionModelForm(api);
    await form.ready;
    // A stored key for this provider loads the models on open, with an empty key.
    expect(api.check).toHaveBeenCalledWith('openrouter', '');
    expect((q(form.section, 'decision-model-enabled') as HTMLInputElement).checked).toBe(true);
    (q(form.section, 'decision-model-enabled') as HTMLInputElement).checked = false;
    await form.save();
    expect(api.save).toHaveBeenCalledWith({enabled: false, provider: 'openrouter', model: 'liquid/d1'});
    expect(q(form.section, 'decision-model-status').textContent).toBe('Off: applied to 2 personas');
  });

  it('shows a save error and the personas that failed', async() => {
    // TypeSafe has its own default model, so Save can go out before any check.
    const api = fakeApi({...UNCONFIGURED, provider: 'typesafe'});
    api.save.mockResolvedValueOnce({ok: false, error: 'Enter an API key', state: UNCONFIGURED} as any);
    const form = createDecisionModelForm(api);
    await form.ready;
    (q(form.section, 'decision-model-enabled') as HTMLInputElement).checked = true;
    await form.save();
    expect(q(form.section, 'decision-model-status').textContent).toBe('Not applied: Enter an API key');
    api.save.mockResolvedValueOnce({ok: true, state: UNCONFIGURED, applied: 1, failed: [{persona: 'aria', error: 'disk full'}]} as any);
    await form.save();
    expect(q(form.section, 'decision-model-status').textContent).toBe('On: applied to 1 persona; failed: aria (disk full)');
  });

  const pickProvider = (form: {section: HTMLElement}, value: string) => {
    q(form.section, 'decision-model-provider').click();
    (document.querySelector(`[data-testid="decision-model-provider-option-${value}"]`) as HTMLElement).click();
  };

  it('a provider switch discards a check still running for the previous provider', async() => {
    const api = fakeApi({configured: true, enabled: true, provider: 'openrouter', model: 'liquid/d1', hasKey: true, canStoreKey: true});
    const form = createDecisionModelForm(api);
    document.body.append(form.section);
    await form.ready;
    let release: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    api.check.mockImplementationOnce(async() => {
      await gate;
      return {ok: true as const, value: {status: 'verified' as const, detail: 'ok', models: ['liquid/d1']}};
    });
    const key = q(form.section, 'decision-model-key') as HTMLInputElement;
    key.value = 'sk-or-2';
    const inFlight = form.loadModels();
    pickProvider(form, 'typesafe');
    release!();
    await inFlight;
    expect(api.check).not.toHaveBeenCalledWith('typesafe', expect.anything());
    expect(q(form.section, 'decision-model-status').textContent).toBe('');
    expect(q(form.section, 'decision-model-model-value').textContent).not.toBe('liquid/d1');
    (q(form.section, 'decision-model-enabled') as HTMLInputElement).checked = true;
    await form.save();
    expect(api.save).not.toHaveBeenCalledWith(expect.objectContaining({provider: 'typesafe', model: 'liquid/d1'}));
  });

  it('an unverifiable OpenRouter key offers no TypeSafe model and Save refuses without one', async() => {
    const api = fakeApi();
    api.check.mockResolvedValueOnce({ok: true, value: {status: 'unverified', detail: 'ETIMEDOUT', models: []}} as any);
    const form = createDecisionModelForm(api);
    document.body.append(form.section);
    await form.ready;
    (q(form.section, 'decision-model-key') as HTMLInputElement).value = 'sk-or-3';
    await form.loadModels();
    expect(q(form.section, 'decision-model-status').textContent).toBe('Could not confirm the key (ETIMEDOUT)');
    expect(q(form.section, 'decision-model-model-value').textContent).not.toContain('typesafe/');
    (q(form.section, 'decision-model-enabled') as HTMLInputElement).checked = true;
    await form.save();
    expect(api.save).not.toHaveBeenCalled();
    expect(q(form.section, 'decision-model-status').textContent).toBe('Choose a model');
  });

  it('says when this PC cannot keep the key', async() => {
    const api = fakeApi({...UNCONFIGURED, canStoreKey: false});
    const form = createDecisionModelForm(api);
    await form.ready;
    expect(q(form.section, 'decision-model-key-note').textContent).toContain('no keyring');
  });
});
