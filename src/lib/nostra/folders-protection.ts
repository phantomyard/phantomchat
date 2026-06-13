import {PROTECTED_FOLDERS} from '@appManagers/constants';

/**
 * Returns true if the folder id cannot be deleted by the user.
 * Protected folders can still be renamed and reordered.
 */
export function isProtectedFolder(id: number): boolean {
  return PROTECTED_FOLDERS.has(id);
}
