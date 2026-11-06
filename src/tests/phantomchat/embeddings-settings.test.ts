/**
 * Settings > Specialized Models: the menu that holds the three model screens,
 * and the Embeddings form (same kit as Decision Model and Voice Models).
 */
import 'fake-indexeddb/auto';
import {describe, it, expect, vi, afterEach} from 'vitest';
import type {DesktopEmbeddingsApi, EmbeddingsState} from '@lib/phantomchat/desktop-api';
import {getDesktopEmbeddings, hasDesktopSpecializedModels} from '@lib/phantomchat/desktop-api';
import {createEmbeddingsForm} from '@components/sidebarLeft/tabs/phantomchatEmbeddings';

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

const UNCONFIGURED: EmbeddingsState = {
  configured: false, enabled: false, provider: 'gemini', baseUrl: '', model: 'gemini-embedding-001', dims: 0, hasKey: false, canStoreKey: true
};

function fakeApi(initial: EmbeddingsState = UNCONFIGURED) {
  let state = initial;
  const api = {
    get: vi.fn(async() => state),
    check: vi.fn(async(input: {provider: string; apiKey?: string; model?: string}) => {
      if(input.apiKey === 'bad') return {ok: true as const, value: {status: 'failed' as const, detail: 'HTTP 401', models: [] as string[]}};
      if(input.provider === 'gemini') return {ok: true as const, value: {status: 'verified' as const, detail: 'ok', models: ['gemini-embedding-001'], dims: 1536}};
      return input.model ?
        {ok: true as const, value: {status: 'verified' as const, detail: 'ok', models: ['bge-m3', 'nomic-embed'], dims: 768}} :
        {ok: true as const, value: {status: 'unchecked' as const, detail: 'choose a model', models: ['bge-m3', 'nomic-embed']}};
    }),
    save: vi.fn(async(input: any) => {
      state = {...UNCONFIGURED, configured: true, enabled: input.enabled, provider: input.provider, baseUrl: input.baseUrl ?? '', model: input.model, hasKey: state.hasKey || !!input.apiKey};
      return {ok: true as const, state, applied: 2, failed: [] as {persona: string; error: string}[]};
    })
  } satisfies DesktopEmbeddingsApi;
  return api;
}

const q = (root: ParentNode, id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const pick = (id: string, value: string) => {
  q(document, id).click();
  (document.querySelector(`[data-testid="${id}-option-${value}"]`) as HTMLElement).click();
};

describe('Settings > Specialized Models', () => {
  afterEach(() => {
    delete (window as any).phantomchatDesktop;
    document.body.innerHTML = '';
  });

  it('the menu exists when any of its screens can work, and Embeddings only with its API', () => {
    expect(hasDesktopSpecializedModels()).toBe(false);
    (window as any).phantomchatDesktop = {voiceModels: {call: vi.fn()}};
    expect(hasDesktopSpecializedModels()).toBe(true);
    expect(getDesktopEmbeddings()).toBeNull();
    const api = fakeApi();
    (window as any).phantomchatDesktop = {embeddings: api};
    expect(getDesktopEmbeddings()).toBe(api);
    expect(hasDesktopSpecializedModels()).toBe(true);
  });

  it('uses the kit: toggle, pickers, key field, status, Save; no raw select', async() => {
    const form = createEmbeddingsForm(fakeApi());
    document.body.append(form.section);
    await form.ready;
    expect(form.section.querySelector('select')).toBeNull();
    for(const id of ['embeddings-enabled', 'embeddings-provider', 'embeddings-key', 'embeddings-model', 'embeddings-status', 'embeddings-save']) {
      expect(q(form.section, id), id).not.toBeNull();
    }
    // Gemini has no base URL.
    expect((q(form.section, 'embeddings-base-url').closest('.input-field') as HTMLElement).style.display).toBe('none');
  });

  it('Gemini: a typed key is checked on leaving the field and saved once', async() => {
    const api = fakeApi();
    const form = createEmbeddingsForm(api);
    document.body.append(form.section);
    await form.ready;
    const key = q(form.section, 'embeddings-key') as HTMLInputElement;
    key.value = 'g-1'; key.dispatchEvent(new Event('blur'));
    await vi.waitFor(() => expect(q(form.section, 'embeddings-status').textContent).toBe('Key verified (1536 dims)'));
    (q(form.section, 'embeddings-enabled') as HTMLInputElement).checked = true;
    await form.save();
    expect(api.save).toHaveBeenCalledWith({enabled: true, provider: 'gemini', model: 'gemini-embedding-001', apiKey: 'g-1'});
    expect(q(form.section, 'embeddings-status').textContent).toBe('On: applied to 2 personas. Indexing notes in the background.');
    expect(key.value).toBe('');
  });

  it('a rejected key says so', async() => {
    const form = createEmbeddingsForm(fakeApi());
    await form.ready;
    (q(form.section, 'embeddings-key') as HTMLInputElement).value = 'bad';
    await form.loadModels();
    expect(q(form.section, 'embeddings-status').textContent).toBe('Key rejected (HTTP 401)');
  });

  it('OpenAI Compatible: the base URL loads the list, a pick is proved, Save sends the endpoint', async() => {
    const api = fakeApi();
    const form = createEmbeddingsForm(api);
    document.body.append(form.section);
    await form.ready;
    pick('embeddings-provider', 'openai-compatible');
    expect(q(form.section, 'embeddings-key-note').textContent).toContain('Optional');
    const url = q(form.section, 'embeddings-base-url') as HTMLInputElement;
    url.value = 'http://localhost:11434/v1'; url.dispatchEvent(new Event('blur'));
    await vi.waitFor(() => expect(q(form.section, 'embeddings-status').textContent).toBe('Choose a model'));
    pick('embeddings-model', 'nomic-embed');
    await vi.waitFor(() => expect(q(form.section, 'embeddings-status').textContent).toBe('Model works (768 dims)'));
    expect(api.check).toHaveBeenLastCalledWith({provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'nomic-embed'});
    (q(form.section, 'embeddings-enabled') as HTMLInputElement).checked = true;
    await form.save();
    expect(api.save).toHaveBeenCalledWith({enabled: true, provider: 'openai-compatible', model: 'nomic-embed', baseUrl: 'http://localhost:11434/v1'});
  });

  it('a provider switch discards a check still running for the previous provider', async() => {
    const api = fakeApi();
    const form = createEmbeddingsForm(api);
    document.body.append(form.section);
    await form.ready;
    let release: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    api.check.mockImplementationOnce(async() => {
      await gate;
      return {ok: true as const, value: {status: 'verified' as const, detail: 'ok', models: ['gemini-embedding-001'], dims: 1536}};
    });
    (q(form.section, 'embeddings-key') as HTMLInputElement).value = 'g-2';
    const inFlight = form.loadModels();
    pick('embeddings-provider', 'openai-compatible');
    release!();
    await inFlight;
    expect(q(form.section, 'embeddings-status').textContent).toBe('');
    expect(q(form.section, 'embeddings-model-value').textContent).not.toBe('gemini-embedding-001');
  });

  it('no list from the endpoint: the model is typed', async() => {
    const api = fakeApi();
    api.check.mockResolvedValue({ok: true, value: {status: 'unchecked', detail: 'choose a model', models: []}} as any);
    const form = createEmbeddingsForm(api);
    document.body.append(form.section);
    await form.ready;
    pick('embeddings-provider', 'openai-compatible');
    (q(form.section, 'embeddings-base-url') as HTMLInputElement).value = 'http://127.0.0.1:8082/v1';
    await form.loadModels();
    expect(q(form.section, 'embeddings-status').textContent).toContain('type a model ID');
    (q(form.section, 'embeddings-model-typed') as HTMLInputElement).value = 'my-embed';
    (q(form.section, 'embeddings-enabled') as HTMLInputElement).checked = true;
    await form.save();
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({model: 'my-embed'}));
  });

  it('Off saves without a key, keeping the stored one', async() => {
    const api = fakeApi({...UNCONFIGURED, configured: true, enabled: true, hasKey: true});
    const form = createEmbeddingsForm(api);
    await form.ready;
    expect(api.check).toHaveBeenCalledWith({provider: 'gemini', baseUrl: undefined, apiKey: ''});
    expect(q(form.section, 'embeddings-key-note').textContent).toBe('Key saved. Leave empty to keep it.');
    (q(form.section, 'embeddings-enabled') as HTMLInputElement).checked = false;
    await form.save();
    expect(api.save).toHaveBeenCalledWith({enabled: false, provider: 'gemini', model: 'gemini-embedding-001'});
    expect(q(form.section, 'embeddings-status').textContent).toBe('Off: applied to 2 personas');
  });
});
