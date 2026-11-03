// @vitest-environment jsdom
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import {FOLDER_ID_ALL, FOLDER_ID_ARCHIVE, FOLDER_ID_GROUPS} from '@appManagers/constants';
import {ARCHIVE_SELECTED_ROW_CLASS, syncArchiveTileSelection} from '@lib/phantomchat/archive-tile-selection';

function strip() {
  const row = document.createElement('div');
  const chip = document.createElement('div');
  chip.classList.add('chatlist-folder-badge', 'active');
  const tile = document.createElement('button');
  tile.classList.add('chatlist-folder-badge', 'chatlist-archive-badge');
  row.append(chip, tile);
  return {row, chip, tile};
}

describe('folders strip archive tile selection (#358)', () => {
  it('marks the tile selected while the archive list is current and clears it on close', () => {
    const {row, chip, tile} = strip();

    syncArchiveTileSelection(row, tile, FOLDER_ID_ARCHIVE);
    expect(tile.classList.contains('active')).toBe(true);
    expect(row.classList.contains(ARCHIVE_SELECTED_ROW_CLASS)).toBe(true);
    // HorizontalMenu reads the chip's .active to know where to return.
    expect(chip.classList.contains('active')).toBe(true);

    syncArchiveTileSelection(row, tile, FOLDER_ID_GROUPS);
    expect(tile.classList.contains('active')).toBe(false);
    expect(row.classList.contains(ARCHIVE_SELECTED_ROW_CLASS)).toBe(false);
  });

  it('starts unselected on the default folder and tolerates an unbuilt strip', () => {
    const {row, tile} = strip();
    syncArchiveTileSelection(row, tile, FOLDER_ID_ALL);
    expect(tile.classList.contains('active')).toBe(false);
    expect(() => syncArchiveTileSelection(undefined, undefined, FOLDER_ID_ARCHIVE)).not.toThrow();
  });

  it('setFilterId drives the tile, and its label goes through the lang pack', () => {
    // appDialogsManager cannot be constructed under jsdom without the whole
    // app; pin the two call sites the behaviour above depends on.
    const src = readFileSync('src/lib/appDialogsManager.ts', 'utf8');
    const setter = src.slice(src.indexOf('public setFilterId(filterId: number) {'));
    expect(setter.slice(0, setter.indexOf('\n  }'))).toContain('syncArchiveTileSelection(this.foldersRow, this.archiveFolderButton, filterId)');
    expect(src).toContain('_i18n(archiveLabel, \'ChatList.Filter.Archive\')');
    expect(src).not.toContain('archiveLabel.textContent = \'Archived\'');
  });
});
