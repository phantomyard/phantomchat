/**
 * Selected state for the folders strip's Archive tile.
 *
 * The tile sits outside HorizontalMenu's container, so `selectTab` never
 * writes `.active` on it, and opening Archive (a sidebar tab, not a filter)
 * left the previously selected folder chip highlighted. The archive tab moves
 * `appDialogsManager.filterId` to the archive folder on open and back on
 * close, so this is driven from `setFilterId`: the tile is active exactly
 * while the archive list is the current one, and the strip carries a class
 * that mutes the folder chip HorizontalMenu still marks `.active`. That chip
 * keeps its class on purpose: HorizontalMenu reads it to know which tab to
 * return to.
 */

import {FOLDER_ID_ARCHIVE} from '@appManagers/constants';

export const ARCHIVE_SELECTED_ROW_CLASS = 'is-archive-selected';

export function syncArchiveTileSelection(row: HTMLElement | undefined, tile: HTMLElement | undefined, filterId: number) {
  const selected = filterId === FOLDER_ID_ARCHIVE;
  tile?.classList.toggle('active', selected);
  row?.classList.toggle(ARCHIVE_SELECTED_ROW_CLASS, selected);
}
