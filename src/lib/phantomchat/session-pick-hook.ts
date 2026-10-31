/**
 * Session picker mode: which pick hook is in force for ONE `open()` of the
 * Contacts tab.
 *
 * `SliderSuperTab.open()` forwards its own arguments to `init()` and then
 * nulls `init` (`sliderTab.ts`) — and the session flow (`sidebarLeft
 * .openNewSessionFlow`) calls `open()` with NO arguments, on a freshly built
 * instance, because `AppContactsTab.noSame = true`. So the hook that
 * `setPickPeerHook()` installs one line earlier is nulled at open if `init`
 * assigns `this.onPickPeer = params?.onPickPeer` unconditionally: the FIRST
 * `+` press in Sessions opened a DM, and it only started working on the second
 * press (Kai, #292 review at b21b342).
 *
 * Semantics — one rule, both directions:
 *   - no params        → the caller said nothing about picking; keep whatever
 *                        is set (this is the `+` / `open()` path).
 *   - params present   → the caller owns this open, so the hook is exactly
 *                        `params.onPickPeer` (absent = cleared). That is what
 *                        keeps pick mode from leaking into a later, ordinary
 *                        Contacts visit alongside `onClose`'s reset.
 */
export function resolvePickPeerHook(
  current?: (peerId: PeerId) => void,
  params?: {onPickPeer?: (peerId: PeerId) => void}
): ((peerId: PeerId) => void) | undefined {
  return params ? params.onPickPeer : current;
}
