/*
 * Native editable-field context menu: the template built from Chromium's
 * context-menu params. Suggestions must map to replaceMisspelling(), the
 * misspelled word must reach the dictionary, and the edit section must be
 * gated by params.editFlags.
 */
import {describe, it, expect, vi} from 'vitest';
import {buildEditableMenuItems, type EditableContextParams, type SpellcheckTarget} from './contextMenu';

function makeParams(overrides: Partial<EditableContextParams> = {}): EditableContextParams {
  return {
    isEditable: true,
    misspelledWord: '',
    dictionarySuggestions: [],
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false
    },
    ...overrides
  };
}

function makeTarget(): SpellcheckTarget & {
  replaceMisspelling: ReturnType<typeof vi.fn>;
  session: {addWordToSpellCheckerDictionary: ReturnType<typeof vi.fn>};
} {
  return {
    replaceMisspelling: vi.fn(),
    session: {addWordToSpellCheckerDictionary: vi.fn(() => true)}
  };
}

const labels = (items: ReturnType<typeof buildEditableMenuItems>) =>
  items.map((item) => item.type === 'separator' ? '---' : item.label);

describe('buildEditableMenuItems', () => {
  it('maps each dictionary suggestion to replaceMisspelling', () => {
    const target = makeTarget();
    const items = buildEditableMenuItems(makeParams({
      misspelledWord: 'recomendations',
      dictionarySuggestions: ['recommendations', 'recommendation', 'recriminations']
    }), target);

    expect(labels(items).slice(0, 3)).toEqual(['recommendations', 'recommendation', 'recriminations']);
    (items[1].click as Function)({}, {}, {});
    expect(target.replaceMisspelling).toHaveBeenCalledWith('recommendation');
    expect(target.replaceMisspelling).toHaveBeenCalledTimes(1);
  });

  it('caps suggestions at 5', () => {
    const target = makeTarget();
    const items = buildEditableMenuItems(makeParams({
      misspelledWord: 'teh',
      dictionarySuggestions: ['the', 'ten', 'tech', 'tea', 'tee', 'th', 'tet', 'tex']
    }), target);

    expect(labels(items).filter((l) => l !== '---' && l !== 'Add to dictionary')).toHaveLength(5);
  });

  it('offers Add to dictionary with the misspelled word', () => {
    const target = makeTarget();
    const items = buildEditableMenuItems(makeParams({misspelledWord: 'phantomchat'}), target);

    const add = items.find((item) => item.label === 'Add to dictionary');
    expect(add).toBeDefined();
    (add!.click as Function)({}, {}, {});
    expect(target.session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith('phantomchat');
  });

  it('shows a disabled placeholder when suggestions have not resolved yet', () => {
    const target = makeTarget();
    const items = buildEditableMenuItems(makeParams({
      misspelledWord: 'teh',
      dictionarySuggestions: []
    }), target);

    expect(items[0].label).toBe('No spelling suggestions');
    expect(items[0].enabled).toBe(false);
  });

  it('gates edit commands on editFlags and keeps no trailing separators', () => {
    const target = makeTarget();
    const items = buildEditableMenuItems(makeParams({
      editFlags: {
        canUndo: false,
        canRedo: false,
        canCut: true,
        canCopy: true,
        canPaste: false,
        canSelectAll: true
      }
    }), target);

    expect(labels(items)).toEqual(['Cut', 'Copy', 'Select All']);
  });

  it('returns nothing for a non-editable field with no spelling word', () => {
    const target = makeTarget();
    const items = buildEditableMenuItems(makeParams({isEditable: false}), target);
    expect(items).toEqual([]);
  });
});
