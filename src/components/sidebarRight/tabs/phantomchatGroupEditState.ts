export function getGroupMemberChanges(original: string[], draft: string[]) {
  const originalSet = new Set(original);
  const draftSet = new Set(draft);
  return {
    added: draft.filter((pubkey) => !originalSet.has(pubkey)),
    removed: original.filter((pubkey) => !draftSet.has(pubkey))
  };
}

/**
 * What a check-button press (or Enter in the name field) has to persist.
 *
 * `hasChanges` is false when the name is unchanged and the roster matches —
 * the caller still closes the editor in that case, so the button is a
 * reliable "done" affordance rather than a dead click. An empty or
 * whitespace-only name is never saved: `name` stays empty and `nameChanged`
 * false, so a cleared field can never wipe the chat title.
 */
export function getGroupEditSavePlan(
  originalName: string,
  draftName: string,
  originalMembers: string[],
  draftMembers: string[]
) {
  const name = draftName.trim();
  const nameChanged = !!name && name !== originalName;
  const {added, removed} = getGroupMemberChanges(originalMembers, draftMembers);
  return {
    name,
    nameChanged,
    added,
    removed,
    hasChanges: nameChanged || added.length > 0 || removed.length > 0
  };
}
