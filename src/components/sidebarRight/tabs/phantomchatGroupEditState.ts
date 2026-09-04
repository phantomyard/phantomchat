export function getGroupMemberChanges(original: string[], draft: string[]) {
  const originalSet = new Set(original);
  const draftSet = new Set(draft);
  return {
    added: draft.filter((pubkey) => !originalSet.has(pubkey)),
    removed: original.filter((pubkey) => !draftSet.has(pubkey))
  };
}
