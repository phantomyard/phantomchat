/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import Icon from '@components/icon';

/**
 * A list picker the phone can actually use.
 *
 * The New Contact pane used to open a native <select>: on a phone that is a
 * full-screen OS wheel with every model in it, no search, and a long list the
 * pane cannot shorten. This replaces it with one control: a field that looks
 * like the pane's other fields, and a sheet with a search box, 44px rows and a
 * short "first N" list instead of the whole catalogue.
 *
 * The sheet is a bottom sheet on a phone (thumb reach, keyboard never hides
 * the field) and a centred card on a desktop. Everything carries a test id
 * derived from `testId` so the pane's tests drive the same path a user does.
 */

export interface PickerOption {
  value: string;
  label: string;
  /** Secondary line, e.g. a model the engine picks by default. */
  hint?: string;
}

export interface ListPickerOptions {
  /** Base data-testid; every element inside derives from it. */
  testId: string;
  /** Accessible name of the sheet and of the trigger. */
  label: string;
  /** Trigger text before anything is picked. */
  placeholder: string;
  /** Rows shown before the rest folds behind "Show all". 0 shows everything. */
  limit?: number;
  onChange?: (value: string) => void;
}

export interface ListPicker {
  trigger: HTMLButtonElement;
  setOptions(options: PickerOption[], selected?: string): void;
  /** Replace the text shown while nothing is selected. */
  setPlaceholder(text: string): void;
  /** A disabled picker shows the placeholder and does not open. */
  setDisabled(disabled: boolean): void;
  getValue(): string | undefined;
  getOptions(): readonly PickerOption[];
  /** Close an open sheet, e.g. when the pane goes away. */
  destroy(): void;
}

const TRIGGER_CSS = 'display:flex;align-items:center;justify-content:space-between;gap:.5rem;width:100%;min-height:3.375rem;padding:0 .875rem;border:1px solid var(--input-search-border-color, var(--border-color));border-radius:var(--border-radius-medium, .75rem);box-sizing:border-box;background:var(--surface-color);color:var(--primary-text-color);font-size:1rem;font-family:inherit;text-align:start;cursor:pointer;';
const SHEET_CSS = 'display:flex;flex-direction:column;width:min(26rem, 100%);max-height:70vh;background:var(--surface-color);border-radius:1rem;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.35);';
const SEARCH_CSS = 'width:100%;height:2.75rem;padding:0 .875rem;border:none;border-bottom:1px solid var(--border-color);box-sizing:border-box;background:transparent;color:var(--primary-text-color);font-size:1rem;font-family:inherit;outline:none;';
const ROW_CSS = 'display:flex;align-items:center;justify-content:space-between;gap:.75rem;width:100%;min-height:44px;padding:.5rem .875rem;border:none;background:transparent;color:var(--primary-text-color);font-size:1rem;font-family:inherit;text-align:start;cursor:pointer;';

const isPhone = () => typeof window !== 'undefined' && window.innerWidth <= 640;

export function createListPicker(opts: ListPickerOptions): ListPicker {
  const {testId, label} = opts;
  let items: PickerOption[] = [];
  let selected: string | undefined;
  let disabled = false;
  let placeholder = opts.placeholder;
  let overlay: HTMLElement | undefined;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.setAttribute('data-testid', testId);
  trigger.setAttribute('aria-label', label);
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.style.cssText = TRIGGER_CSS;

  const valueEl = document.createElement('span');
  valueEl.setAttribute('data-testid', `${testId}-value`);
  valueEl.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  const chevron = document.createElement('span');
  chevron.style.cssText = 'flex:none;display:flex;color:var(--secondary-text-color);';
  chevron.append(Icon('arrow_down'));
  trigger.append(valueEl, chevron);

  const renderTrigger = () => {
    const current = items.find((item) => item.value === selected);
    valueEl.textContent = current ? current.label : placeholder;
    valueEl.style.color = current ? 'var(--primary-text-color)' : 'var(--secondary-text-color)';
    trigger.disabled = disabled;
    trigger.style.opacity = disabled ? '.6' : '';
    trigger.style.cursor = disabled ? 'default' : 'pointer';
  };

  const pick = (item: PickerOption) => {
    const changed = selected !== item.value;
    selected = item.value;
    renderTrigger();
    close();
    if(changed) opts.onChange?.(item.value);
  };

  let onKeyDown: ((event: KeyboardEvent) => void) | undefined;
  const close = () => {
    overlay?.remove();
    overlay = undefined;
    if(onKeyDown) document.removeEventListener('keydown', onKeyDown, true);
    onKeyDown = undefined;
  };

  const buildRow = (item: PickerOption, onPick: (item: PickerOption) => void) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.style.cssText = ROW_CSS;
    row.setAttribute('data-testid', `${testId}-option-${item.value}`);
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(item.value === selected));
    const text = document.createElement('span');
    text.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;';
    const title = document.createElement('span');
    title.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    title.textContent = item.label;
    text.append(title);
    if(item.hint) {
      const hint = document.createElement('span');
      hint.style.cssText = 'font-size:.8125rem;color:var(--secondary-text-color);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      hint.textContent = item.hint;
      text.append(hint);
    }
    row.append(text);
    if(item.value === selected) {
      const check = document.createElement('span');
      check.style.cssText = 'flex:none;display:flex;color:var(--primary-color);';
      check.append(Icon('check'));
      row.append(check);
    }
    row.addEventListener('click', () => onPick(item));
    return row;
  };

  const open = () => {
    if(disabled || overlay) return;
    const phone = isPhone();
    overlay = document.createElement('div');
    overlay.style.cssText = `position:fixed;inset:0;z-index:5000;display:flex;justify-content:center;background:rgba(0,0,0,.4);${phone ? 'align-items:flex-end;' : 'align-items:center;padding:1rem;box-sizing:border-box;'}`;
    overlay.setAttribute('data-testid', `${testId}-sheet`);

    const sheet = document.createElement('div');
    sheet.style.cssText = SHEET_CSS + (phone ? 'border-bottom-left-radius:0;border-bottom-right-radius:0;' : '');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', label);

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:.75rem;padding:.75rem .875rem;';
    const heading = document.createElement('div');
    heading.style.cssText = 'font-size:1rem;font-weight:500;color:var(--primary-text-color);';
    heading.textContent = label;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--secondary-text-color);cursor:pointer;';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.setAttribute('data-testid', `${testId}-close`);
    closeBtn.append(Icon('close'));
    closeBtn.addEventListener('click', close);
    header.append(heading, closeBtn);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;overflow-y:auto;overscroll-behavior:contain;';
    list.setAttribute('role', 'listbox');
    list.setAttribute('data-testid', `${testId}-list`);

    let query = '';
    let expanded = false;

    const renderList = () => {
      const needle = query.trim().toLowerCase();
      const matches = needle ?
        items.filter((item) => `${item.label} ${item.value}`.toLowerCase().includes(needle)) :
        items;
      const limit = opts.limit ?? 0;
      const shown = !needle && !expanded && limit > 0 ? matches.slice(0, limit) : matches;
      list.replaceChildren(...shown.map((item) => buildRow(item, pick)));
      if(!matches.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:1rem .875rem;font-size:.875rem;color:var(--secondary-text-color);';
        empty.setAttribute('data-testid', `${testId}-empty`);
        empty.textContent = 'No matches';
        list.append(empty);
      } else if(shown.length < matches.length) {
        const more = document.createElement('button');
        more.type = 'button';
        more.style.cssText = ROW_CSS + 'justify-content:center;color:var(--primary-color);font-weight:500;';
        more.setAttribute('data-testid', `${testId}-show-all`);
        more.textContent = `Show all ${matches.length}`;
        more.addEventListener('click', () => {
          expanded = true;
          renderList();
        });
        list.append(more);
      }
    };

    sheet.append(header);
    // Search earns its row only when the list is long enough to scroll.
    if(items.length > 6) {
      const search = document.createElement('input');
      search.type = 'search';
      search.style.cssText = SEARCH_CSS + 'flex:none;';
      search.setAttribute('placeholder', 'Search');
      search.setAttribute('aria-label', `Search ${label.toLowerCase()}`);
      search.setAttribute('data-testid', `${testId}-search`);
      search.addEventListener('input', () => {
        query = search.value;
        renderList();
      });
      sheet.append(search);
      if(!phone) requestAnimationFrame(() => search.focus());
    }
    sheet.append(list);
    overlay.append(sheet);
    overlay.addEventListener('click', (event) => {
      if(event.target === overlay) close();
    });
    document.body.append(overlay);
    renderList();

    onKeyDown = (event: KeyboardEvent) => {
      if(event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    // Capture: the pane below also listens for Escape, and one Escape must
    // close the sheet, not the pane under it.
    document.addEventListener('keydown', onKeyDown, true);
  };

  trigger.addEventListener('click', open);
  renderTrigger();

  return {
    trigger,
    setOptions(next, nextSelected) {
      items = next;
      selected = nextSelected !== undefined ? nextSelected : (items.some((item) => item.value === selected) ? selected : undefined);
      renderTrigger();
      if(overlay) close();
    },
    setPlaceholder(text) {
      placeholder = text;
      renderTrigger();
    },
    setDisabled(next) {
      disabled = next;
      if(disabled) close();
      renderTrigger();
    },
    getValue: () => selected,
    getOptions: () => items,
    destroy: close
  };
}
