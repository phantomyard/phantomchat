/**
 * GroupDeliveryTracker - Per-member delivery aggregation for group messages
 *
 * Tracks delivery state per member for each group message and computes
 * an aggregate state following WhatsApp-style rules:
 * - 'read' only when ALL members are 'read'
 * - 'delivered' when all are 'delivered' or 'read'
 * - 'sent' when at least one member has advanced past 'sending'
 * - 'sending' when no member has advanced
 */

import type {DeliveryState} from './delivery-tracker';
import type {GroupDeliveryInfo} from './group-types';

// ─── In-memory tracking ────────────────────────────────────────────

const groupDeliveryMap = new Map<string, GroupDeliveryInfo>();

// ─── Aggregate computation ─────────────────────────────────────────

/**
 * Compute aggregate delivery state from per-member states.
 *
 * Rules (WhatsApp-style, per D-05):
 * - Empty → 'sending'
 * - All 'read' → 'read'
 * - All 'delivered' or 'read' → 'delivered'
 * - At least one advanced past 'sending' → 'sent'
 * - Otherwise → 'sending'
 */
export function computeAggregateState(memberStates: Record<string, DeliveryState>): DeliveryState {
  const states = Object.values(memberStates);
  if(states.length === 0) return 'sending';
  if(states.every(s => s === 'read')) return 'read';
  if(states.every(s => s === 'delivered' || s === 'read')) return 'delivered';
  if(states.some(s => s !== 'sending')) return 'sent';
  return 'sending';
}

// ─── GroupDeliveryTracker ──────────────────────────────────────────

export class GroupDeliveryTracker {
  /**
   * Initialize tracking for a new group message.
   * Sets all members to 'sending' state.
   */
  initMessage(messageId: string, groupId: string, memberPubkeys: string[]): void {
    const memberStates: Record<string, DeliveryState> = {};
    for(const pk of memberPubkeys) {
      memberStates[pk] = 'sending';
    }
    groupDeliveryMap.set(messageId, {
      messageId,
      groupId,
      memberStates,
      aggregateState: 'sending'
    });
  }

  /**
   * Update a specific member's delivery state.
   * Recomputes and returns the new aggregate state.
   */
  updateMemberState(messageId: string, memberPubkey: string, state: DeliveryState): DeliveryState {
    const info = groupDeliveryMap.get(messageId);
    if(!info) return 'sending';
    info.memberStates[memberPubkey] = state;
    info.aggregateState = computeAggregateState(info.memberStates);
    return info.aggregateState;
  }

  /**
   * Get full delivery info for a message.
   */
  getInfo(messageId: string): GroupDeliveryInfo | undefined {
    return groupDeliveryMap.get(messageId);
  }

  /**
   * Get per-member states for a message.
   */
  getMemberStates(messageId: string): Record<string, DeliveryState> {
    const info = groupDeliveryMap.get(messageId);
    return info ? info.memberStates : {};
  }
}
