import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import CheckboxField from '@components/checkboxField';
import InputField from '@components/inputField';
import Button from '@components/button';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {createListPicker} from '@components/listPicker';
import {
  getDesktopDecisionModel,
  type DecisionModelProvider,
  type DecisionModelState,
  type DesktopDecisionModelApi
} from '@lib/phantomchat/desktop-api';

/*
 * Desktop only: one decision model (e.g. TypeSafe Jev) for every persona of
 * the bundled phantombot engine (issue #449). It screens untrusted turns
 * (the judge) and picks the primary or coder model per turn (the router).
 *
 * Main owns the setting and the key (electron/decisionModel.ts): this tab
 * sends a typed key once and afterwards only learns whether one is stored.
 * Save writes it into every persona; personas created later inherit it.
 */

export const DEFAULT_DECISION_MODEL = 'typesafe/jev-1.13';

const PROVIDERS: {value: DecisionModelProvider; label: string}[] = [
  {value: 'openrouter', label: 'OpenRouter'},
  {value: 'typesafe', label: 'TypeSafe'}
];

const NOTE_CSS = 'font-size:.875rem;color:var(--secondary-text-color);min-height:16px;';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cssText?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if(cssText) node.style.cssText = cssText;
  if(text) node.textContent = text;
  return node;
}

export interface DecisionModelForm {
  section: HTMLElement;
  /** Resolves once the stored setting is shown (and its models, when a key is stored). */
  ready: Promise<void>;
  save(): Promise<void>;
  /** Check the typed (or stored) key and fill the model list. */
  loadModels(): Promise<void>;
  destroy(): void;
}

/** The form, apart from the tab so tests drive it without the slider. */
export function createDecisionModelForm(api: DesktopDecisionModelApi): DecisionModelForm {
  const section = el('div', 'display:flex;flex-direction:column;gap:.75rem;padding:0 .5rem;');
  section.setAttribute('data-testid', 'decision-model-form');

  const enabled = new CheckboxField({toggle: true, checked: false});
  enabled.input.setAttribute('data-testid', 'decision-model-enabled');
  const enabledRow = new Row({
    title: 'Enabled',
    subtitle: 'Screen untrusted messages and route each turn',
    checkboxField: enabled
  });

  const providerPicker = createListPicker({
    testId: 'decision-model-provider',
    label: 'Provider',
    placeholder: 'Choose a provider',
    onChange: () => onProviderChanged()
  });

  const keyField = new InputField({labelText: 'API key', plainText: true, maxLength: 4096});
  keyField.container.style.margin = '0';
  const keyInput = keyField.input as HTMLInputElement;
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.setAttribute('data-testid', 'decision-model-key');
  const keyNote = el('div', NOTE_CSS);
  keyNote.setAttribute('data-testid', 'decision-model-key-note');

  const modelPicker = createListPicker({
    testId: 'decision-model-model',
    label: 'Model',
    placeholder: 'Enter your key to load models',
    limit: 20
  });

  const status = el('div', NOTE_CSS);
  status.setAttribute('data-testid', 'decision-model-status');

  const saveBtn = Button('btn-primary btn-color-primary');
  saveBtn.textContent = 'Save';
  saveBtn.setAttribute('data-testid', 'decision-model-save');

  section.append(enabledRow.container, providerPicker.trigger, keyField.container, keyNote, modelPicker.trigger, status, saveBtn);

  let state: DecisionModelState | null = null;
  let checkGeneration = 0;
  let checkedKey: {provider: string; key: string} | undefined;
  let busy = false;

  const provider = (): DecisionModelProvider => (providerPicker.getValue() as DecisionModelProvider) || 'openrouter';
  /** The stored key belongs to the provider on screen. */
  const storedKeyFits = () => !!state?.hasKey && state.provider === provider();

  const setModels = (ids: string[], preferred?: string) => {
    const list = ids.length ? [...ids] : [DEFAULT_DECISION_MODEL];
    if(preferred && !list.includes(preferred)) list.unshift(preferred);
    modelPicker.setOptions(list.map((id) => ({
      value: id,
      label: id,
      ...(id === DEFAULT_DECISION_MODEL ? {hint: 'recommended'} : {})
    })), preferred && list.includes(preferred) ? preferred : list[0]);
    modelPicker.setDisabled(false);
  };

  const showKeyNote = () => {
    if(state && !state.canStoreKey) {
      keyNote.textContent = 'This PC has no keyring, so the key is not kept. Personas added later need it entered again.';
    } else {
      keyNote.textContent = storedKeyFits() ? 'Key saved. Leave empty to keep it.' : '';
    }
  };

  function onProviderChanged() {
    checkedKey = undefined;
    keyInput.value = '';
    status.textContent = '';
    modelPicker.setOptions([]);
    modelPicker.setDisabled(true);
    showKeyNote();
    if(storedKeyFits()) void loadModels();
  }

  async function loadModels(): Promise<void> {
    const p = provider();
    const key = keyInput.value.trim();
    if(!key && !storedKeyFits()) return;
    if(checkedKey && checkedKey.provider === p && checkedKey.key === key) return;
    const generation = ++checkGeneration;
    status.textContent = 'Checking key...';
    const res = await api.check(p, key);
    if(generation !== checkGeneration) return;
    if(res.ok === false) {
      status.textContent = res.error || 'Could not check the key';
      return;
    }
    checkedKey = {provider: p, key};
    const r = res.value;
    if(r.status === 'invalid') {
      status.textContent = `Key rejected (${r.detail})`;
      modelPicker.setOptions([]);
      modelPicker.setDisabled(true);
      return;
    }
    status.textContent = r.status === 'verified' ? 'Key verified' : `Could not verify the key (${r.detail})`;
    const preferred = modelPicker.getValue() || (state?.provider === p ? state.model : DEFAULT_DECISION_MODEL);
    setModels(r.models, preferred);
  }

  keyInput.addEventListener('input', () => {
    checkedKey = undefined;
  });
  keyInput.addEventListener('blur', () => void loadModels());

  async function save(): Promise<void> {
    if(busy) return;
    busy = true;
    saveBtn.disabled = true;
    status.textContent = 'Saving...';
    try {
      const key = keyInput.value.trim();
      const res = await api.save({
        enabled: enabled.checked,
        provider: provider(),
        model: modelPicker.getValue() || (state?.provider === provider() ? state.model : DEFAULT_DECISION_MODEL),
        ...(key ? {apiKey: key} : {})
      });
      if(res.ok === false) {
        status.textContent = res.error;
        return;
      }
      state = res.state;
      keyInput.value = '';
      checkedKey = undefined;
      showKeyNote();
      const n = res.applied;
      const done = `${enabled.checked ? 'On' : 'Off'}: applied to ${n} persona${n === 1 ? '' : 's'}`;
      status.textContent = res.failed.length ?
        `${done}; failed: ${res.failed.map((f) => `${f.persona} (${f.error})`).join(', ')}` :
        done;
    } finally {
      busy = false;
      saveBtn.disabled = false;
    }
  }
  attachClickEvent(saveBtn, () => void save());

  const ready = (async() => {
    providerPicker.setOptions(PROVIDERS, 'openrouter');
    modelPicker.setDisabled(true);
    state = await api.get();
    if(!state) return;
    enabled.setValueSilently(state.configured && state.enabled);
    providerPicker.setOptions(PROVIDERS, state.provider);
    showKeyNote();
    if(storedKeyFits()) await loadModels();
    else if(state.configured) setModels([state.model], state.model);
  })();

  return {
    section,
    ready,
    save,
    loadModels,
    destroy: () => {
      providerPicker.destroy();
      modelPicker.destroy();
    }
  };
}

export default class AppPhantomChatDecisionModelTab extends SliderSuperTab {
  private form: DecisionModelForm | undefined;

  public init() {
    this.container.classList.add('phantomchat-decision-model');
    this.setTitle('Decision Model' as any);
    const api = getDesktopDecisionModel();
    const settingSection = new SettingSection({
      caption: 'One decision model for every assistant in this app. It screens messages from anyone you have not allowed, and picks the main or coding model for each turn. Assistants you add later get it too.' as any
    });
    if(!api) {
      settingSection.content.append(el('div', NOTE_CSS, 'Not available in this version of the app.'));
      this.scrollable.append(settingSection.container);
      return;
    }
    this.form = createDecisionModelForm(api);
    settingSection.content.append(this.form.section);
    this.scrollable.append(settingSection.container);
  }

  public onCloseAfterTimeout() {
    this.form?.destroy();
    return super.onCloseAfterTimeout();
  }
}
