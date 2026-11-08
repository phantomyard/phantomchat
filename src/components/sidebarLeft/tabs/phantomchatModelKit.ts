import Row from '@components/row';
import CheckboxField from '@components/checkboxField';
import InputField from '@components/inputField';
import Button from '@components/button';
import {createListPicker, type ListPicker, type PickerOption} from '@components/listPicker';

/*
 * The building blocks of every Settings > Specialized Models screen (Decision
 * Model, Voice Models, Embeddings), so the three look and behave as one:
 *
 *   Enabled toggle Row -> Provider picker -> (Base URL) -> API key + note
 *   -> Model picker(s) -> status line -> Test and Apply (Test and Save)
 *
 * A stored key shows as dots in the key field (`showStoredKey`); the key
 * itself never reaches the page. There is no standing "Active" badge: the
 * button tests the key live and saves only when that test passes, and the
 * status line says what happened.
 *
 * The rules behind it are in AGENTS.md ("Settings screens: one design"). A new
 * model setting is built from these parts, not from raw <select>/<fieldset>
 * elements or a "Load models" button.
 */

export const NOTE_CSS = 'font-size:.875rem;color:var(--secondary-text-color);min-height:16px;';
const FORM_CSS = 'display:flex;flex-direction:column;gap:.75rem;padding:0 .5rem;';
const FIELD_LABEL_CSS = 'display:flex;flex-direction:column;gap:.375rem;';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cssText?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if(cssText) node.style.cssText = cssText;
  if(text) node.textContent = text;
  return node;
}

/** The column every form on these screens lives in. */
export function formColumn(testId: string): HTMLElement {
  const section = el('div', FORM_CSS);
  section.setAttribute('data-testid', testId);
  return section;
}

/** The Enabled toggle: the app's toggle Row, never a bare checkbox. */
export function toggleRow(testId: string, title: string, subtitle: string) {
  const field = new CheckboxField({toggle: true, checked: false});
  field.input.setAttribute('data-testid', testId);
  const row = new Row({title, subtitle, checkboxField: field});
  return {container: row.container as HTMLElement, field};
}

/** An InputField with a test id on the input. `secret` makes it a key field. */
export function textField(testId: string, label: string, opts: {secret?: boolean; maxLength?: number; placeholder?: string} = {}) {
  const field = new InputField({labelText: label, plainText: true, maxLength: opts.maxLength ?? 2048});
  field.container.style.margin = '0';
  const input = field.input as HTMLInputElement;
  input.setAttribute('data-testid', testId);
  if(opts.secret) {
    input.type = 'password';
    input.autocomplete = 'off';
  }
  if(opts.placeholder) input.placeholder = opts.placeholder;
  return {container: field.container as HTMLElement, input};
}

/** A one-line note or status under a field. Status lines are live regions. */
export function noteLine(testId: string, status = false): HTMLElement {
  const node = el('div', NOTE_CSS);
  node.setAttribute('data-testid', testId);
  if(status) node.setAttribute('role', 'status');
  return node;
}

export function saveButton(testId: string, text = 'Save'): HTMLButtonElement {
  const btn = Button('btn-primary btn-color-primary') as HTMLButtonElement;
  btn.textContent = text;
  btn.setAttribute('data-testid', testId);
  return btn;
}

/** A labelled list picker; the label sits above the trigger like a field's. */
export function labelledPicker(opts: {testId: string; label: string; placeholder: string; limit?: number; onChange?: (value: string) => void}) {
  const picker = createListPicker(opts);
  const container = el('div', FIELD_LABEL_CSS);
  container.append(el('div', NOTE_CSS, opts.label), picker.trigger);
  return {container, picker};
}

export const OTHER_MODEL = '__other_model__';

export interface ModelChooser {
  container: HTMLElement;
  picker: ListPicker;
  /** The typed-id field, shown for "Other" or when the provider lists nothing. */
  typed: HTMLInputElement;
  /**
   * Fill the list. `preferred` is selected (and added when missing, so a saved
   * model is never silently swapped). An empty list shows the typed field when
   * typing is allowed.
   */
  setModels(ids: readonly string[], preferred?: string, hint?: (id: string) => string | undefined): void;
  /** Empty and disabled, with `placeholder` saying what it waits for. */
  clear(placeholder?: string): void;
  /** The chosen id: the pick, or the typed id for "Other" / no list. */
  value(): string;
  /** True while the list holds models (or a typed id is in play). */
  loaded(): boolean;
  destroy(): void;
}

/**
 * The Model control: a list picker, plus a typed model id when the provider
 * has no catalogue (`allowTyped`). Same shape on every screen.
 */
export function createModelChooser(opts: {
  testId: string;
  label?: string;
  placeholder: string;
  allowTyped?: boolean;
  onChange?: (value: string) => void;
  onTyped?: (value: string) => void;
}): ModelChooser {
  const typedField = textField(`${opts.testId}-typed`, 'Model ID', {maxLength: 512});
  typedField.container.style.display = 'none';
  let loaded = false;
  const showTyped = (on: boolean) => {
    typedField.container.style.display = on ? '' : 'none';
  };
  const {container, picker} = labelledPicker({
    testId: opts.testId,
    label: opts.label ?? 'Model',
    placeholder: opts.placeholder,
    limit: 20,
    onChange: (value) => {
      showTyped(value === OTHER_MODEL);
      if(value !== OTHER_MODEL) typedField.input.value = '';
      opts.onChange?.(value === OTHER_MODEL ? typedField.input.value.trim() : value);
    }
  });
  container.append(typedField.container);
  typedField.input.addEventListener('blur', () => opts.onTyped?.(typedField.input.value.trim()));

  const chooser: ModelChooser = {
    container,
    picker,
    typed: typedField.input,
    setModels(ids, preferred, hint) {
      const list = [...ids];
      if(preferred && !list.includes(preferred)) list.unshift(preferred);
      if(!list.length) {
        if(opts.allowTyped) {
          loaded = true;
          picker.setOptions([]);
          picker.setPlaceholder('No list from this provider: type a model ID');
          picker.setDisabled(true);
          showTyped(true);
        } else chooser.clear();
        return;
      }
      loaded = true;
      const options: PickerOption[] = list.map((id) => {
        const h = hint?.(id);
        return {value: id, label: id, ...(h ? {hint: h} : {})};
      });
      if(opts.allowTyped) options.push({value: OTHER_MODEL, label: 'Other: type a model ID'});
      picker.setOptions(options, preferred && list.includes(preferred) ? preferred : list[0]);
      picker.setDisabled(false);
      showTyped(false);
      typedField.input.value = '';
    },
    clear(placeholder) {
      loaded = false;
      picker.setOptions([]);
      if(placeholder) picker.setPlaceholder(placeholder);
      picker.setDisabled(true);
      showTyped(false);
      typedField.input.value = '';
    },
    value() {
      if(!loaded) return '';
      const picked = picker.getValue();
      if(picked && picked !== OTHER_MODEL) return picked;
      return opts.allowTyped ? typedField.input.value.trim() : '';
    },
    loaded: () => loaded,
    destroy: () => picker.destroy()
  };
  chooser.clear();
  return chooser;
}

/** "On: applied to 2 personas" / "...; failed: a (why)". One wording everywhere. */
export function appliedLine(enabled: boolean, applied: number, failed: string[]): string {
  const done = `${enabled ? 'On' : 'Off'}: applied to ${applied} persona${applied === 1 ? '' : 's'}`;
  return failed.length ? `${done}; failed: ${failed.join(', ')}` : done;
}

/** What a key field shows for a stored key. Never the key: it stays in main. */
export const STORED_KEY_MASK = '••••••••••••';

/** Dots in the key field while a key is stored for what is on screen; typing replaces it. */
export function showStoredKey(input: HTMLInputElement, stored: boolean) {
  input.placeholder = stored ? STORED_KEY_MASK : '';
  input.setAttribute('data-stored-key', stored ? '1' : '0');
}
