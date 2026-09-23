/**
 * Top bar avatar visibility rule (cosmetic):
 * the avatar in the chat top bar is redundant while the left bar holds a
 * single item — that one peer's avatar is already on the left. Show the top
 * bar avatar only when there are two or more items (any mix of contacts and
 * groups).
 */
export function shouldShowTopbarAvatar(leftBarItemCount: number): boolean {
  return leftBarItemCount > 1;
}
