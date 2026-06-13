// @ts-nocheck
import type {Invariant, InvariantTier, FuzzContext, Action, FailureDetails} from '../types';
import {consoleClean} from './console';
import {noDupMid, bubbleChronological, noAutoPin, sentBubbleVisibleAfterSend} from './bubbles';
import {deliveryUiMatchesTracker, deliveryTrackerNoOrphans} from './delivery';
import {avatarDomMatchesCache} from './avatar';
import {mirrorsIdbCoherent, peersComplete, storedMessageIdentityComplete} from './state';
import {offlineQueuePurged} from './queue';
import {noNip04, idbSeedEncrypted, editPreservesMidTimestamp, editAuthorCheck, virtualPeerIdStable} from './regression';
import {reactionDedupe, noKind7SelfEchoDrop, reactionBilateral, reactionAuthorCheck, reactionRemoveKind, reactionAggregatedRender} from './reactions';
import {reactionsPickerNonempty} from './reactions-ui';
import {historyRehydratesIdentical, offlineQueuePersistence, noDupAfterDeleteRace, noOrphanTempMidPostReload} from './lifecycle';
import {invProfileKind0SingleActive, invProfileCacheCoherent, invProfilePropagates} from './profile';
import {groupAdminIsMember, groupStoreUniqueIds, groupBilateralMembership, groupPeerIdDeterministic, groupNoOrphanMirrorPeer} from './groups';

export const ALL_INVARIANTS: Invariant[] = [
  consoleClean,
  noDupMid,
  bubbleChronological,
  noAutoPin,
  sentBubbleVisibleAfterSend,
  noDupAfterDeleteRace,
  deliveryUiMatchesTracker,
  avatarDomMatchesCache,
  // Cheap — reactions
  reactionDedupe,
  noKind7SelfEchoDrop,
  reactionAggregatedRender,
  reactionsPickerNonempty,
  invProfileKind0SingleActive,
  groupAdminIsMember,
  // Medium tier
  mirrorsIdbCoherent,
  storedMessageIdentityComplete,
  peersComplete,
  deliveryTrackerNoOrphans,
  offlineQueuePurged,
  reactionBilateral,
  historyRehydratesIdentical,
  offlineQueuePersistence,
  noOrphanTempMidPostReload,
  invProfileCacheCoherent,
  groupStoreUniqueIds,
  groupBilateralMembership,
  // Regression tier
  noNip04,
  idbSeedEncrypted,
  editPreservesMidTimestamp,
  editAuthorCheck,
  virtualPeerIdStable,
  reactionAuthorCheck,
  reactionRemoveKind,
  invProfilePropagates,
  groupPeerIdDeterministic,
  groupNoOrphanMirrorPeer
];

const MEDIUM_EVERY = 10;

export async function runTier(
  tier: InvariantTier,
  ctx: FuzzContext,
  action?: Action
): Promise<FailureDetails | null> {
  if(tier === 'medium' && ctx.actionIndex % MEDIUM_EVERY !== 0) return null;

  for(const inv of ALL_INVARIANTS) {
    if(inv.tier !== tier) continue;
    const result = await inv.check(ctx, action);
    if(!result.ok) {
      return {
        invariantId: inv.id,
        tier: inv.tier,
        message: result.message || 'invariant failed',
        evidence: result.evidence,
        action
      };
    }
  }
  return null;
}

/**
 * Called at the end of each fuzz sequence. Runs the regression tier so
 * end-of-sequence state invariants can observe the IDB / relay state.
 * Cheap/medium tier already ran per-action inside runSequence.
 */
export async function runEndOfSequence(ctx: FuzzContext, action?: Action): Promise<FailureDetails | null> {
  return runRegressionOnce(ctx, action);
}

/**
 * Called once at the end of the whole run. Same semantics as runEndOfSequence
 * but runs even if the final sequence ended cleanly — captures relay-wide
 * invariants (no-nip04) and migration-wide ones that wouldn't surface per-seq.
 */
export async function runEndOfRun(ctx: FuzzContext): Promise<FailureDetails | null> {
  return runRegressionOnce(ctx);
}

async function runRegressionOnce(ctx: FuzzContext, action?: Action): Promise<FailureDetails | null> {
  for(const inv of ALL_INVARIANTS) {
    if(inv.tier !== 'regression') continue;
    const result = await inv.check(ctx, action);
    if(!result.ok) {
      return {invariantId: inv.id, tier: inv.tier, message: result.message || 'invariant failed', evidence: result.evidence, action};
    }
  }
  return null;
}
