/**
 * Does the session picker have to bring the LEFT COLUMN forward before it
 * opens (owner 2026-11-02, "Open New Session" on a text selection)?
 *
 * The picker lives in the left column, and this flow is dispatched from the
 * chat pane's selection menu. Two DIFFERENT facts decide whether the column is
 * actually out of view, and the class alone answers neither:
 *
 *   - Layout. `_leftSidebar.scss` renders the column with a plain
 *     `display: flex` under `respond-to(no-floating-left-sidebar)` — i.e. wider
 *     than 925px, `mediaSizes.isLessThanFloatingLeftSidebar` false — so it is on
 *     screen no matter which tab is active. Only at or below that width is it
 *     floating/handheld and slid out of view (`respond-to(floating-left-sidebar)`
 *     keys the translate off `body.is-left-column-shown`, handhelds off its
 *     absence).
 *   - The class. `is-left-column-shown` is toggled by `selectTab` as
 *     `id === APP_TABS.CHATLIST` (`appImManager.ts:2395`) — it means "the
 *     chatlist tab is active", not "the column is visible", and it has no width
 *     condition. Opening a peer runs `selectTab(APP_TABS.CHAT)` at every width,
 *     so with a DM open at 1280 the class is ABSENT while the column is on
 *     screen.
 *
 * Revealing there is not harmless: `selectTab` also rewrites the hash
 * (`overrideHash(undefined)` for CHATLIST), so with a DM open on a wide screen
 * the call cleared the hash of a chat that stays on screen behind the picker,
 * and backing out of the picker left it unaddressable across a reload (Robert,
 * #400 at 701b048). Gating on the layout is what keeps the reveal for the
 * widths that need it and keeps it away from the ones that do not.
 */
export function needsLeftColumnReveal(params: {
  isLessThanFloatingLeftSidebar: boolean;
  leftColumnShown: boolean;
}): boolean {
  return params.isLessThanFloatingLeftSidebar && !params.leftColumnShown;
}
