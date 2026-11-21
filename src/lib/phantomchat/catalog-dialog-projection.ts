import type {GroupRecord} from './group-types';
import {isSessionPeer} from './group-types';
import {syncStep} from './session-sync-recovery';

type Dialog = {peerId?: number; folder_id?: number; index_1?: number; index_3?: number; index_4?: number};

/** A converged catalog is not enough: persisted worker rows may still be stale.
 * Rebuild only missing/misplaced rows from the current store, then remove
 * orphan rows. This path is independent of the legacy groups snapshot.
 */
export async function reconcileCatalogDialogs(deps: {
  groups(): Promise<GroupRecord[]>;
  dialogs(): Promise<Dialog[]>;
  reload(peerId: number): Promise<unknown>;
  sweep(signal: AbortSignal): Promise<void>;
}, signal: AbortSignal): Promise<void> {
  const step = <T>(work: Promise<T>) => syncStep(work, signal);
  const [groups, dialogs] = await step(Promise.all([deps.groups(), deps.dialogs()]));
  const byPeer = new Map(dialogs.map((dialog) => [Number(dialog.peerId), dialog]));
  const repairs = groups.filter((group) => {
    const dialog = byPeer.get(group.peerId);
    if(!dialog) return true;
    const archive = !!group.archivedAt;
    const index = archive ? 'index_1' : isSessionPeer(group.peerId) ? 'index_4' : 'index_3';
    return (dialog.folder_id || 0) !== (archive ? 1 : 0) || !dialog[index] ||
      (['index_1', 'index_3', 'index_4'] as const).some((key) => key !== index && !!dialog[key]);
  });
  await step(Promise.all(repairs.map((group) => {
    signal.throwIfAborted();
    // reloadConversation re-reads the record; never write the earlier snapshot.
    return deps.reload(group.peerId);
  })));
  signal.throwIfAborted();
  await step(deps.sweep(signal));
}
