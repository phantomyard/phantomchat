/**
 * ensure-sender-user-injected.ts
 *
 * Shared helper that injects a User object for a Nostr pubkey into the
 * main-thread mirrors and the Worker's appUsersManager. Used by both the
 * 1-on-1 message receive path (nostra-message-handler.ts) and the group
 * receive path (nostra-groups-sync.ts).
 *
 * Without this, `getPeer(senderPeerId)` returns undefined and bubble titles
 * fall back to `I18n.format('HiddenName')` → "Deleted Account"
 * (getPeerTitle.ts:68 + lang.ts).
 *
 * Steps performed (idempotent — early-return if peer already present):
 *   1. Resolve a display name: existing virtual-peers-db mapping > hex fallback.
 *   2. Build a User via NostraPeerMapper.createTwebUser.
 *   3. Write into apiManagerProxy.mirrors.peers[peerId].
 *   4. reconcilePeer(peerId, user) — notifies <ChatList> / <TopBar> stores.
 *   5. appUsersManager.injectP2PUser — seeds the Worker side so getHistory /
 *      avatar derivation succeed there too.
 *   6. Fire-and-forget kind 0 fetch — upgrades hex fallback to the user's
 *      published display name and dispatches `peer_title_edit`.
 *
 * Failures are logged and swallowed — every step is non-critical for the
 * caller's flow (message persistence proceeds either way).
 */

import {NostraPeerMapper} from '@lib/nostra/nostra-peer-mapper';
import {MOUNT_CLASS_TO} from '@config/debug';
import rootScope from '@lib/rootScope';
import {logSwallow} from '@lib/nostra/log-swallow';

export interface EnsureSenderUserInjectedOpts {
  senderPubkey: string;
  peerId: number;
  /** Optional log-prefix override (defaults to '[ensureSenderUserInjected]'). */
  logPrefix?: string;
}

export interface EnsureSenderUserInjectedResult {
  /** True if a new User was injected; false if the peer was already present. */
  isNewPeer: boolean;
}

/**
 * Resolve the best-known display name for a pubkey at injection time.
 * Prefer any existing virtual-peers-db mapping (set by a prior contact-add
 * or kind 0 fetch); otherwise fall back to 'npub...<hex8>'.
 */
async function resolveInitialDisplayName(senderPubkey: string, logPrefix: string): Promise<string> {
  const fallback = 'npub...' + senderPubkey.slice(0, 8);
  try {
    const {getMapping} = await import('@lib/nostra/virtual-peers-db');
    const existing = await getMapping(senderPubkey);
    if(existing?.displayName) return existing.displayName;
  } catch(e: any) {
    console.debug(logPrefix, 'getMapping non-critical:', e?.message);
  }
  return fallback;
}

/**
 * Background kind 0 fetch — upgrades the hex fallback to the user's
 * published display name. Runs only after a fresh injection so we don't
 * spam relays on every incoming message for a known peer.
 */
function scheduleKind0Upgrade(
  senderPubkey: string,
  peerId: number,
  initialDisplayName: string,
  logPrefix: string
): void {
  const proxy = MOUNT_CLASS_TO.apiManagerProxy;
  void(async() => {
    try {
      const [{fetchNostrProfile, profileToDisplayName}, {updateMappingProfile}] = await Promise.all([
        import('@lib/nostra/nostr-profile'),
        import('@lib/nostra/virtual-peers-db')
      ]);
      const profile = await fetchNostrProfile(senderPubkey);
      if(!profile) return;
      const k0Name = profileToDisplayName(profile);
      if(!k0Name || k0Name === initialDisplayName) return;

      await updateMappingProfile(senderPubkey, k0Name, profile);

      try {
        await rootScope.managers.appUsersManager.updateP2PUserName(peerId, k0Name);
      } catch(e) { logSwallow('ensureSenderUserInjected.updateP2PUserName', e); }

      if(proxy?.mirrors?.peers?.[peerId]) {
        proxy.mirrors.peers[peerId].first_name = k0Name;
        try {
          const {reconcilePeer} = await import('@stores/peers');
          reconcilePeer(peerId, proxy.mirrors.peers[peerId]);
        } catch(e) { logSwallow('ensureSenderUserInjected.reconcilePeer.kind0', e); }
      }

      rootScope.dispatchEvent('peer_title_edit', {peerId: (peerId as number).toPeerId(false)});
    } catch(e: any) {
      console.debug(logPrefix, 'kind 0 fetch non-critical:', e?.message);
    }
  })();
}

/**
 * Ensure a User object exists in main-thread mirrors and the Worker's
 * appUsersManager for the given senderPubkey/peerId. Idempotent: returns
 * `{isNewPeer: false}` immediately if the peer is already present.
 */
export async function ensureSenderUserInjected(
  opts: EnsureSenderUserInjectedOpts
): Promise<EnsureSenderUserInjectedResult> {
  const {senderPubkey, peerId} = opts;
  const logPrefix = opts.logPrefix || '[ensureSenderUserInjected]';
  const proxy = MOUNT_CLASS_TO.apiManagerProxy;

  if(!proxy?.mirrors?.peers) return {isNewPeer: false};
  if(proxy.mirrors.peers[peerId]) return {isNewPeer: false};

  const displayName = await resolveInitialDisplayName(senderPubkey, logPrefix);

  const mapper = new NostraPeerMapper();
  const user = mapper.createTwebUser({peerId, firstName: displayName, pubkey: senderPubkey});
  proxy.mirrors.peers[peerId] = user;

  try {
    const {reconcilePeer} = await import('@stores/peers');
    reconcilePeer(peerId, user);
  } catch(e: any) {
    console.debug(logPrefix, 'reconcilePeer non-critical:', e?.message);
  }

  try {
    const {NostraBridge} = await import('@lib/nostra/nostra-bridge');
    const bridge = NostraBridge.getInstance();
    const avatar = bridge.deriveAvatarFromPubkeySync(senderPubkey);
    await rootScope.managers.appUsersManager.injectP2PUser(senderPubkey, peerId, displayName, avatar);
  } catch(e: any) {
    console.debug(logPrefix, 'injectP2PUser non-critical:', e?.message);
  }

  scheduleKind0Upgrade(senderPubkey, peerId, displayName, logPrefix);

  return {isNewPeer: true};
}
