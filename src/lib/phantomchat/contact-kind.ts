/**
 * The effective contact type for the Edit Contact pane, and so whether it
 * offers the Local tools switch.
 *
 * A legacy contact (added before the type picker) has no stored kind, so its
 * type falls back to the peer's kind-0 `bot` flag. That flag must come from
 * the cached kind-0 profile, not only from the tweb user's `pFlags.bot`:
 * several paths rebuild the synthetic user with empty pFlags (the Contacts
 * list, add-contact, the Worker's injectP2PUser), so the user flag alone made
 * the switch appear or vanish depending on which path ran last.
 */

import {getContactPrefs, resolveContactKind, type ContactKind, type ContactPrefs} from './contact-prefs';
import {loadCachedPeerProfile} from './peer-profile-cache';

/** True when the peer's cached kind-0 profile says it is a bot (a phantombot). */
export function isCachedPeerBot(pubkey: string): boolean {
  return !!loadCachedPeerProfile(pubkey)?.profile?.bot;
}

export async function resolveContactKindForPeer(
  pubkey: string | null,
  userIsBot: boolean
): Promise<{kind: ContactKind | undefined, prefs: ContactPrefs | undefined}> {
  const prefs = pubkey ? await getContactPrefs(pubkey) : undefined;
  const isBot = userIsBot || (!!pubkey && isCachedPeerBot(pubkey));
  return {kind: resolveContactKind(prefs?.kind, isBot), prefs};
}
