export type MergeInputs = {
  remoteCreatedAt: number | null;
  localPublishedAt: number;
  localModifiedAt: number;
  hasLocalCustomFolders: boolean;
};

export type MergeDecision =
  | {action: 'publish-local', showToast: false}
  | {action: 'remote-wins', showToast: boolean}
  | {action: 'local-wins', showToast: false}
  | {action: 'in-sync', showToast: false}
  | {action: 'no-op', showToast: false};

/**
 * Pure last-write-wins merge decision. Returns one of 5 actions based on
 * timestamp comparison. The toast flag is set only when the user had
 * unpublished local offline edits that are being overwritten by a newer
 * remote snapshot — so they learn their work was discarded instead of
 * silently vanishing.
 */
export function decideMerge(i: MergeInputs): MergeDecision {
  if(i.remoteCreatedAt === null) {
    return i.hasLocalCustomFolders ?
      {action: 'publish-local', showToast: false} :
      {action: 'no-op', showToast: false};
  }

  if(i.localModifiedAt > i.remoteCreatedAt) {
    return {action: 'local-wins', showToast: false};
  }

  if(i.remoteCreatedAt === i.localPublishedAt) {
    return {action: 'in-sync', showToast: false};
  }

  // Remote wins. Toast if user had unpublished offline changes being overwritten.
  const localHadUnpublishedChanges =
    i.localModifiedAt > i.localPublishedAt && i.localModifiedAt > 0;
  return {action: 'remote-wins', showToast: localHadUnpublishedChanges};
}
