/**
 * The list picker behind the Provider and Model fields: short first list,
 * search over everything, and no way to open it while it is waiting for the
 * token's model list.
 */
import 'fake-indexeddb/auto';
import {describe, expect, it} from 'vitest';
import {createListPicker} from '@components/listPicker';
import {
  isInsidePeerEditorPane,
  isInsidePeerEditorPopup,
  isPeerEditorToggleEntryPoint,
  shouldDismissPeerEditorOnPointerDown
} from '@lib/phantomchat/peer-editor-dismiss';

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const options = (n: number) => Array.from({length: n}, (_, i) => ({value: `m-${i}`, label: `Model ${i}`}));

describe('list picker', () => {
  it('shows the first rows, folds the rest behind Show all, and searches every option', () => {
    const changed: string[] = [];
    const picker = createListPicker({testId: 'p', label: 'Model', placeholder: 'None', limit: 3, onChange: (v) => changed.push(v)});
    document.body.append(picker.trigger);
    picker.setOptions(options(25));
    expect(q('p-value').textContent).toBe('None');

    picker.trigger.click();
    expect(document.querySelectorAll('[data-testid^="p-option-"]').length).toBe(3);
    q('p-show-all').click();
    expect(document.querySelectorAll('[data-testid^="p-option-"]').length).toBe(25);

    // The search reaches the rows the short list hid.
    const search = q('p-search') as HTMLInputElement;
    search.value = 'model 23';
    search.dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('[data-testid^="p-option-"]').length).toBe(1);

    q('p-option-m-23').click();
    expect(picker.getValue()).toBe('m-23');
    expect(q('p-value').textContent).toBe('Model 23');
    expect(changed).toEqual(['m-23']);
    // Picking closes the sheet.
    expect(q('p-sheet')).toBeNull();
    picker.destroy();
  });

  it('a disabled picker shows its placeholder and does not open', () => {
    const picker = createListPicker({testId: 'd', label: 'Model', placeholder: 'Enter your token to load models'});
    document.body.append(picker.trigger);
    picker.setDisabled(true);
    picker.trigger.click();
    expect(q('d-sheet')).toBeNull();
    expect(q('d-value').textContent).toBe('Enter your token to load models');
    picker.destroy();
  });

  it('a pick in the sheet is not an outside click for the editor pane', () => {
    // The Provider contact Edit pane's Model / Provider / Voice ID pickers open
    // this sheet at document.body. The pane's outside-click rule must treat a
    // pointer there as the pane's own, or picking a model closes the pane
    // before the check button can save it.
    const column = document.createElement('div');
    column.id = 'column-right';
    document.body.append(column);
    const picker = createListPicker({testId: 'e', label: 'Model', placeholder: 'None'});
    column.append(picker.trigger);
    picker.setOptions(options(3));
    picker.trigger.click();

    const row = q('e-option-m-1');
    expect(isInsidePeerEditorPane(row)).toBe(false);
    expect(isInsidePeerEditorPopup(row)).toBe(true);
    expect(shouldDismissPeerEditorOnPointerDown({
      isInsidePane: isInsidePeerEditorPane(row),
      isInsidePopup: isInsidePeerEditorPopup(row),
      isToggleEntryPoint: isPeerEditorToggleEntryPoint(row, 1)
    })).toBe(false);
    // The backdrop too: tapping it closes the sheet, not the pane under it.
    expect(isInsidePeerEditorPopup(q('e-sheet'))).toBe(true);

    picker.destroy();
    column.remove();
  });
});
