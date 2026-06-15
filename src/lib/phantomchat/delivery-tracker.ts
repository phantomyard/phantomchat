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

const READ_RECEIPTS_KEY = 'phantomchat:read-receipts-enabled';

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

/**
 * Retry schedule for un-acked outgoing DMs (ALWAYS-ON — independent of the
 * read-receipts UI toggle). A DM is a single-shot NIP-17 wrap with no
 * redundancy, so if the relays that accepted the publish never reach the
 * recipient (idle subscription, transient relay outage) the message is lost
 * with no signal. We resend the EXACT same wrap events (same rumor id, so the
 * receiver dedups — never a double) until a delivery receipt arrives or we
 * exhaust the schedule. Backoff: ~8s, ~20s, ~45s.
 *
 * IMPORTANT (FIND-ghost-first-msg): the retry must NOT re-publish the identical
 * outer gift-wrap. Relays will not re-forward a duplicate event id to a
 * subscriber that has already EOSE'd, so a verbatim resend can never rescue a
 * message the recipient's live subscription missed (the "first message ghosts,
 * second works" bug). Production therefore registers a re-wrap closure that
 * mints a FRESH outer wrap (new outer id, same rumor id → receiver dedups) on
 * every attempt. The legacy array form is kept only for older tests.
 */
const RETRY_DELAYS_MS = [8000, 20000, 45000];
// Cap on tracked outgoing payloads so a long session can't grow unbounded.
const MAX_TRACKED_OUTGOING = 200;

export class DeliveryTracker {
  private states: Map<string, DeliveryInfo> = new Map();
  private privateKey: Uint8Array;
  private publicKey: string;
  private publishFn: (events: any[]) => Promise<void>;
  private readReceiptsEnabled: boolean;

  // ─── Always-on delivery retry ──────────────────────────────────
  // Re-publishes an un-acked message if no delivery receipt comes back in time.
  // Each tracked message stores a normalized resend thunk: the production path
  // re-wraps the rumor in a fresh outer gift-wrap; the legacy path re-publishes
  // the stored wraps via resendFn.
  private resendFn?: (wraps: any[]) => Promise<void>;
  private outgoingResend: Map<string, () => Promise<void>> = new Map();
  private outgoingOrder: string[] = [];
  private retryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(options: {
    privateKey: Uint8Array;
    publicKey: string;
    publishFn: (events: any[]) => Promise<void>;
    /**
     * Re-publish callback for the retry layer. Given the original signed wrap
     * events, publishes them to all write relays again. Optional so legacy
     * tests can omit it (retry simply becomes a no-op). NOT gated by the
     * read-receipts toggle — delivery reliability is fundamental.
     */
    resendFn?: (wraps: any[]) => Promise<void>;
  }) {
    this.privateKey = options.privateKey;
    this.publicKey = options.publicKey;
    this.publishFn = options.publishFn;
    this.resendFn = options.resendFn;

    // Load read receipts setting from localStorage (defaults to true).
    // NOTE: this toggle governs READ-receipt (blue "seen") send/display ONLY.
    // The delivery-receipt + retry mechanism below ignores it entirely.
    if(typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(READ_RECEIPTS_KEY);
      this.readReceiptsEnabled = stored !== 'false';
    } else {
      this.readReceiptsEnabled = true;
    }
  }

  /**
   * Register how to re-publish an outgoing message if no delivery ack arrives.
   * Call right before markSent(). Bounded LRU so memory can't grow without
   * limit.
   *
   * @param resend Either a re-wrap closure (production: mints a fresh outer
   *   gift-wrap each call so relays re-forward it; same rumor id → receiver
   *   dedups) or, for legacy callers/tests, the array of signed wraps to
   *   re-publish verbatim via `resendFn`.
   */
  registerOutgoing(eventId: string, resend: any[] | (() => void | Promise<void>)): void {
    let thunk: (() => Promise<void>) | undefined;
    if(typeof resend === 'function') {
      thunk = () => Promise.resolve(resend());
    } else if(resend?.length && this.resendFn) {
      const wraps = resend;
      const fn = this.resendFn;
      thunk = () => Promise.resolve(fn(wraps));
    }
    if(!thunk) return;

    if(!this.outgoingResend.has(eventId)) this.outgoingOrder.push(eventId);
    this.outgoingResend.set(eventId, thunk);
    while(this.outgoingOrder.length > MAX_TRACKED_OUTGOING) {
      const evicted = this.outgoingOrder.shift()!;
      this.outgoingResend.delete(evicted);
      this.clearRetry(evicted);
    }
  }

  /**
   * Schedule (or reschedule) a resend attempt for an un-acked message.
   * Stops once the message reaches 'delivered'/'read' or the schedule is
   * exhausted. Each attempt re-publishes the same wraps (receiver dedups).
   */
  private scheduleRetry(eventId: string, attempt: number): void {
    if(attempt >= RETRY_DELAYS_MS.length) {
      this.clearRetry(eventId);
      return;
    }
    const existing = this.retryTimers.get(eventId);
    if(existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.retryTimers.delete(eventId);
      const info = this.states.get(eventId);
      // Acked (delivered/read) → nothing to do.
      if(info && STATE_ORDER[info.state] >= STATE_ORDER['delivered']) {
        this.clearRetry(eventId);
        return;
      }
      const resend = this.outgoingResend.get(eventId);
      if(resend) {
        // Fire-and-forget. Production re-wraps (fresh outer id, same rumor id →
        // relay re-forwards, receiver dedups). No double message either way.
        Promise.resolve(resend()).catch(() => { /* relay retry is best-effort */ });
      }
      this.scheduleRetry(eventId, attempt + 1);
    }, RETRY_DELAYS_MS[attempt]);

    this.retryTimers.set(eventId, timer);
  }

  /** Cancel retries and drop the stored wraps for a message. */
  private clearRetry(eventId: string): void {
    const timer = this.retryTimers.get(eventId);
    if(timer) {
      clearTimeout(timer);
      this.retryTimers.delete(eventId);
    }
    if(this.outgoingResend.delete(eventId)) {
      const idx = this.outgoingOrder.indexOf(eventId);
      if(idx !== -1) this.outgoingOrder.splice(idx, 1);
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

    rootScope.dispatchEvent('phantomchat_delivery_update', {eventId, state: 'sent'});

    // Arm the always-on retry. If a delivery receipt doesn't come back before
    // the first delay, we re-publish. No-op when nothing was registered
    // (offline path, or a legacy caller with no resendFn).
    if(this.outgoingResend.has(eventId)) {
      this.scheduleRetry(eventId, 0);
    }
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
        // Always stop retries once the peer confirms receipt — even if the
        // state was already past 'delivered'. This is independent of the
        // read-receipts toggle (delivery acks are the reliability mechanism).
        this.clearRetry(originalEventId);
        if(!this.tryTransition(originalEventId, 'delivered')) return;
        const info = this.states.get(originalEventId)!;
        info.deliveredAt = Date.now();
        rootScope.dispatchEvent('phantomchat_delivery_update', {eventId: originalEventId, state: 'delivered'});
      } else if(receiptType === 'read') {
        // A read receipt also proves delivery — stop retrying regardless of
        // the toggle, BEFORE the privacy gate below.
        this.clearRetry(originalEventId);
        // Pitfall 7: read receipts respect privacy setting (reciprocal).
        // This gate governs the blue "seen" TICK only, never delivery/retry.
        if(!this.readReceiptsEnabled) return;
        if(!this.tryTransition(originalEventId, 'read')) return;
        const info = this.states.get(originalEventId)!;
        info.readAt = Date.now();
        rootScope.dispatchEvent('phantomchat_delivery_update', {eventId: originalEventId, state: 'read'});
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
