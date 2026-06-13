/**
 * DeliveryTracker - 4-state delivery tracking with gift-wrapped receipts
 *
 * Tracks message delivery states: sending -> sent -> delivered -> read
 * Sends/receives NIP-17 gift-wrapped receipt events for delivery/read confirmation.
 * Read receipt privacy toggle: reciprocal WhatsApp behavior (if disabled,
 * neither sends nor displays others' read receipts).
 *
 * Pitfall 6: Receipt events never trigger more receipts (loop prevention).
 * Pitfall 7: Read receipts respect privacy setting (no-op if disabled).
 */

import {wrapNip17Receipt} from './nostr-crypto';
import rootScope from '@lib/rootScope';

// ─── Types ────────────────────────────────────────────────────────

export type DeliveryState = 'sending' | 'sent' | 'delivered' | 'read';

export interface DeliveryInfo {
  state: DeliveryState;
  sentAt?: number;
  deliveredAt?: number;
  readAt?: number;
}

/**
 * Minimal rumor-like event structure for receipt handling.
 */
interface RumorEvent {
  kind: number;
  content: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
  id: string;
}

// ─── State ordering for forward-only enforcement ──────────────────

const STATE_ORDER: Record<DeliveryState, number> = {
  'sending': 0,
  'sent': 1,
  'delivered': 2,
  'read': 3
};

// ─── localStorage key for read receipts toggle ───────────────────

const READ_RECEIPTS_KEY = 'nostra:read-receipts-enabled';

// ─── Static helpers ──────────────────────────────────────────────

/**
 * Check if a rumor event is a receipt (has receipt-type tag).
 * Used to prevent receipt loops (Pitfall 6).
 */
export function isReceiptEvent(rumor: RumorEvent): boolean {
  return rumor.tags?.some((t) => t[0] === 'receipt-type') ?? false;
}

/**
 * Parse receipt information from a rumor event.
 * Returns null if the event is not a receipt.
 */
export function parseReceipt(rumor: RumorEvent): {originalEventId: string; receiptType: 'delivery' | 'read'} | null {
  const receiptTag = rumor.tags?.find((t) => t[0] === 'receipt-type');
  if(!receiptTag) return null;

  const eTag = rumor.tags?.find((t) => t[0] === 'e');
  if(!eTag) return null;

  return {
    originalEventId: eTag[1],
    receiptType: receiptTag[1] as 'delivery' | 'read'
  };
}

// ─── DeliveryTracker ─────────────────────────────────────────────

export class DeliveryTracker {
  private states: Map<string, DeliveryInfo> = new Map();
  private privateKey: Uint8Array;
  private publicKey: string;
  private publishFn: (events: any[]) => Promise<void>;
  private readReceiptsEnabled: boolean;

  constructor(options: {
    privateKey: Uint8Array;
    publicKey: string;
    publishFn: (events: any[]) => Promise<void>;
  }) {
    this.privateKey = options.privateKey;
    this.publicKey = options.publicKey;
    this.publishFn = options.publishFn;

    // Load read receipts setting from localStorage (defaults to true)
    if(typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(READ_RECEIPTS_KEY);
      this.readReceiptsEnabled = stored !== 'false';
    } else {
      this.readReceiptsEnabled = true;
    }
  }

  /**
   * Mark a message as sending (initial state).
   */
  markSending(eventId: string): void {
    this.states.set(eventId, {state: 'sending'});
  }

  /**
   * Mark a message as sent (relay acknowledged).
   * Only transitions forward (sending -> sent).
   */
  markSent(eventId: string): void {
    if(!this.tryTransition(eventId, 'sent')) return;

    const info = this.states.get(eventId)!;
    info.sentAt = Date.now();

    rootScope.dispatchEvent('nostra_delivery_update', {eventId, state: 'sent'});
  }

  /**
   * Handle an incoming receipt rumor event.
   * Routes to delivery or read receipt handling based on receipt-type tag.
   *
   * CRITICAL: Never process receipts for receipt events (Pitfall 6).
   */
  handleReceipt(rumor: RumorEvent): void {
    // Pitfall 6: never process receipts that are themselves receipt events
    if(isReceiptEvent(rumor)) {
      const parsed = parseReceipt(rumor);
      if(!parsed) return;

      const {originalEventId, receiptType} = parsed;

      if(receiptType === 'delivery') {
        if(!this.tryTransition(originalEventId, 'delivered')) return;
        const info = this.states.get(originalEventId)!;
        info.deliveredAt = Date.now();
        rootScope.dispatchEvent('nostra_delivery_update', {eventId: originalEventId, state: 'delivered'});
      } else if(receiptType === 'read') {
        // Pitfall 7: read receipts respect privacy setting (reciprocal)
        if(!this.readReceiptsEnabled) return;
        if(!this.tryTransition(originalEventId, 'read')) return;
        const info = this.states.get(originalEventId)!;
        info.readAt = Date.now();
        rootScope.dispatchEvent('nostra_delivery_update', {eventId: originalEventId, state: 'read'});
      }
    }
  }

  /**
   * Send a delivery receipt for a received message.
   */
  async sendDeliveryReceipt(originalEventId: string, senderPubkey: string): Promise<void> {
    const wraps = wrapNip17Receipt(this.privateKey, senderPubkey, originalEventId, 'delivery');
    await this.publishFn(wraps);
  }

  /**
   * Send a read receipt for a received message.
   * No-op if read receipts are disabled (Pitfall 7).
   */
  async sendReadReceipt(originalEventId: string, senderPubkey: string): Promise<void> {
    if(!this.readReceiptsEnabled) return;
    const wraps = wrapNip17Receipt(this.privateKey, senderPubkey, originalEventId, 'read');
    await this.publishFn(wraps);
  }

  /**
   * Get current delivery state for a message.
   */
  getState(eventId: string): DeliveryInfo | undefined {
    return this.states.get(eventId);
  }

  /**
   * Toggle read receipts enabled/disabled.
   * Persists to localStorage.
   */
  setReadReceiptsEnabled(enabled: boolean): void {
    this.readReceiptsEnabled = enabled;
    if(typeof localStorage !== 'undefined') {
      localStorage.setItem(READ_RECEIPTS_KEY, String(enabled));
    }
  }

  /**
   * Check if read receipts are enabled.
   */
  isReadReceiptsEnabled(): boolean {
    return this.readReceiptsEnabled;
  }

  /**
   * Handle a receipt for a group message.
   * Updates per-member state in GroupDeliveryTracker and dispatches aggregate update.
   *
   * @param originalEventId - The message event ID
   * @param memberPubkey - The member who sent the receipt
   * @param receiptType - 'delivery' or 'read'
   * @returns true if handled as a group receipt, false otherwise
   */
  async handleGroupReceipt(originalEventId: string, memberPubkey: string, receiptType: 'delivery' | 'read'): Promise<boolean> {
    try {
      const {GroupDeliveryTracker} = await import('./group-delivery-tracker');
      const tracker = new GroupDeliveryTracker();
      const info = tracker.getInfo(originalEventId);
      if(!info) return false;

      const state = receiptType === 'read' ? 'read' : 'delivered';
      const aggregateState = tracker.updateMemberState(originalEventId, memberPubkey, state);

      rootScope.dispatchEvent('group_delivery_update' as any, {
        messageId: originalEventId,
        groupId: info.groupId,
        aggregateState
      });

      return true;
    } catch{
      return false;
    }
  }

  // ─── Private ──────────────────────────────────────────────────

  /**
   * Attempt a forward-only state transition.
   * Returns true if transition was applied, false if blocked (backward or same).
   * Creates the state entry if it doesn't exist.
   */
  private tryTransition(eventId: string, newState: DeliveryState): boolean {
    const current = this.states.get(eventId);
    if(!current) {
      // Create with the new state
      this.states.set(eventId, {state: newState});
      return true;
    }

    const currentOrder = STATE_ORDER[current.state];
    const newOrder = STATE_ORDER[newState];

    if(newOrder <= currentOrder) {
      // Backward or same transition -- no-op
      return false;
    }

    current.state = newState;
    return true;
  }
}
