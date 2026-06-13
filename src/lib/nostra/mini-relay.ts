/**
 * MiniRelay — NIP-01 Nostr relay protocol handler with store-and-forward.
 *
 * Handles EVENT, REQ, CLOSE commands per NIP-01.
 * Validates events (kind whitelist, age, size, rate limit).
 * Manages subscriptions per peer.
 * Implements store-and-forward for offline contacts.
 */

import {RelayStore, NostrEvent, NIP01Filter} from '@lib/nostra/relay-store';

// ─── Constants ─────────────────────────────────────────────────────

export const MAX_EVENT_SIZE = 64 * 1024; // 64KB
export const MAX_EVENT_AGE = 72 * 3600;  // 72 hours in seconds
export const ALLOWED_KINDS = new Set([1059]); // gift-wrap only
export const MAX_SUBS_PER_PEER = 20;
export const MAX_SUBS_TOTAL = 100;
export const RATE_LIMIT_PER_SECOND = 10;

// ─── Types ─────────────────────────────────────────────────────────

export type SendFn = (peerId: string, msg: string) => void;

interface Subscription {
  filters: NIP01Filter[];
}

interface RateWindow {
  count: number;
  windowStart: number;
}

// ─── MiniRelay ─────────────────────────────────────────────────────

export class MiniRelay {
  private store: RelayStore;
  private contactPubkeys: Set<string>;
  private send: SendFn;

  // peerId → subId → Subscription
  private subs: Map<string, Map<string, Subscription>> = new Map();

  // peerId → pubkey (for connected peers)
  private peerPubkeys: Map<string, string> = new Map();

  // pubkey → peerId (reverse lookup)
  private pubkeyToPeer: Map<string, string> = new Map();

  // peerId → RateWindow
  private rateWindows: Map<string, RateWindow> = new Map();

  constructor(store: RelayStore, contactPubkeys: string[], send: SendFn) {
    this.store = store;
    this.contactPubkeys = new Set(contactPubkeys);
    this.send = send;
  }

  // ─── Public API ────────────────────────────────────────────────────

  updateContacts(pubkeys: string[]): void {
    this.contactPubkeys = new Set(pubkeys);
  }

  async handleMessage(peerId: string, raw: string): Promise<void> {
    let msg: unknown[];
    try {
      msg = JSON.parse(raw);
    } catch(_) {
      this.sendNotice(peerId, 'invalid JSON');
      return;
    }

    if(!Array.isArray(msg) || msg.length === 0) {
      this.sendNotice(peerId, 'invalid message format');
      return;
    }

    const type = msg[0];

    if(type === 'EVENT') {
      await this.handleEvent(peerId, msg[1] as NostrEvent);
    } else if(type === 'REQ') {
      await this.handleReq(peerId, msg[1] as string, msg.slice(2) as NIP01Filter[]);
    } else if(type === 'CLOSE') {
      this.handleClose(peerId, msg[1] as string);
    } else {
      this.sendNotice(peerId, `unknown command: ${type}`);
    }
  }

  onPeerDisconnected(peerId: string): void {
    this.subs.delete(peerId);
    const pubkey = this.peerPubkeys.get(peerId);
    if(pubkey) {
      this.pubkeyToPeer.delete(pubkey);
      this.peerPubkeys.delete(peerId);
    }
    this.rateWindows.delete(peerId);
  }

  async onPeerConnected(peerId: string, peerPubkey: string): Promise<void> {
    this.peerPubkeys.set(peerId, peerPubkey);
    this.pubkeyToPeer.set(peerPubkey, peerId);
    await this.flushForwardQueue(peerId, peerPubkey);
  }

  // ─── EVENT handling ────────────────────────────────────────────────

  private async handleEvent(peerId: string, event: NostrEvent): Promise<void> {
    if(!event || typeof event !== 'object') {
      this.sendOK(peerId, '', false, 'invalid: missing event');
      return;
    }

    const {id} = event;

    // Kind whitelist
    if(!ALLOWED_KINDS.has(event.kind)) {
      this.sendOK(peerId, id, false, `blocked: kind ${event.kind} not allowed`);
      return;
    }

    // Size check
    const rawSize = JSON.stringify(event).length;
    if(rawSize > MAX_EVENT_SIZE) {
      this.sendOK(peerId, id, false, 'invalid: event too large');
      return;
    }

    // Age check
    const now = Math.floor(Date.now() / 1000);
    if(event.created_at < now - MAX_EVENT_AGE) {
      this.sendOK(peerId, id, false, 'invalid: event too old');
      return;
    }

    // Rate limit
    if(!this.checkRateLimit(peerId)) {
      this.sendOK(peerId, id, false, 'rate-limited: slow down');
      return;
    }

    // Save event (dedup)
    const saved = await this.store.saveEvent(event);
    if(!saved) {
      this.sendOK(peerId, id, true, 'duplicate: already have this event');
      return;
    }

    this.sendOK(peerId, id, true, '');

    // Store-and-forward for p-tag recipients
    const pTags = event.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
    for(const recipientPubkey of pTags) {
      if(!this.contactPubkeys.has(recipientPubkey)) continue;
      const connectedPeerId = this.findConnectedPeer(recipientPubkey);
      if(connectedPeerId !== null) {
        // Forward immediately
        this.send(connectedPeerId, JSON.stringify(['EVENT', 'forward', event]));
      } else {
        // Enqueue for later
        await this.store.enqueueForward(recipientPubkey, id);
      }
    }

    // Push to active subscriptions (from other peers)
    await this.pushToSubscriptions(event, peerId);
  }

  // ─── REQ handling ──────────────────────────────────────────────────

  private async handleReq(peerId: string, subId: string, filters: NIP01Filter[]): Promise<void> {
    if(typeof subId !== 'string' || subId.length === 0) {
      this.sendNotice(peerId, 'invalid: missing subscription id');
      return;
    }

    // Check per-peer subscription limit
    const peerSubs = this.subs.get(peerId) || new Map();
    if(!peerSubs.has(subId) && peerSubs.size >= MAX_SUBS_PER_PEER) {
      this.sendNotice(peerId, `too many subscriptions: max ${MAX_SUBS_PER_PEER} per peer`);
      return;
    }

    // Check total subscription limit
    const totalSubs = this.countTotalSubs();
    if(!this.hasSub(peerId, subId) && totalSubs >= MAX_SUBS_TOTAL) {
      this.sendNotice(peerId, `too many subscriptions: max ${MAX_SUBS_TOTAL} total`);
      return;
    }

    // Store subscription
    peerSubs.set(subId, {filters});
    this.subs.set(peerId, peerSubs);

    // Query stored events for each filter and send them
    for(const filter of filters) {
      const events = await this.store.queryEvents(filter);
      for(const event of events) {
        this.send(peerId, JSON.stringify(['EVENT', subId, event]));
      }
    }

    // Send EOSE
    this.send(peerId, JSON.stringify(['EOSE', subId]));
  }

  // ─── CLOSE handling ────────────────────────────────────────────────

  private handleClose(peerId: string, subId: string): void {
    const peerSubs = this.subs.get(peerId);
    if(peerSubs) {
      peerSubs.delete(subId);
    }
  }

  // ─── Forward queue flush ───────────────────────────────────────────

  private async flushForwardQueue(peerId: string, peerPubkey: string): Promise<void> {
    const queue = await this.store.getForwardQueue(peerPubkey);
    for(const entry of queue) {
      const event = await this.store.getEvent(entry.eventId);
      if(event) {
        this.send(peerId, JSON.stringify(['EVENT', 'forward', event]));
      }
      await this.store.removeForward(entry.id!);
    }
  }

  // ─── Subscription push ─────────────────────────────────────────────

  private async pushToSubscriptions(event: NostrEvent, sourcePeerId: string): Promise<void> {
    for(const [peerId, peerSubs] of this.subs) {
      if(peerId === sourcePeerId) continue; // don't echo back to sender
      for(const [subId, sub] of peerSubs) {
        const matches = sub.filters.some((f) => this.eventMatchesFilter(event, f));
        if(matches) {
          this.send(peerId, JSON.stringify(['EVENT', subId, event]));
        }
      }
    }
  }

  // ─── Filter matching ───────────────────────────────────────────────

  private eventMatchesFilter(event: NostrEvent, filter: NIP01Filter): boolean {
    if(filter.ids && !filter.ids.includes(event.id)) return false;
    if(filter.authors && !filter.authors.includes(event.pubkey)) return false;
    if(filter.kinds && !filter.kinds.includes(event.kind)) return false;
    if(filter.since !== undefined && event.created_at < filter.since) return false;
    if(filter.until !== undefined && event.created_at > filter.until) return false;
    if(filter['#p']) {
      const pValues = event.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
      const pSet = new Set(filter['#p']);
      if(!pValues.some((v) => pSet.has(v))) return false;
    }
    return true;
  }

  // ─── Rate limiting ─────────────────────────────────────────────────

  private checkRateLimit(peerId: string): boolean {
    const now = Date.now();
    const window = this.rateWindows.get(peerId);

    if(!window || now - window.windowStart >= 1000) {
      this.rateWindows.set(peerId, {count: 1, windowStart: now});
      return true;
    }

    if(window.count >= RATE_LIMIT_PER_SECOND) {
      return false;
    }

    window.count++;
    return true;
  }

  // ─── Peer lookup ───────────────────────────────────────────────────

  /**
   * Find connected peer ID by pubkey.
   * Returns null if not connected (wired in Plan 3).
   */
  findConnectedPeer(pubkey: string): string | null {
    return this.pubkeyToPeer.get(pubkey) || null;
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  private sendOK(peerId: string, eventId: string, accepted: boolean, message: string): void {
    this.send(peerId, JSON.stringify(['OK', eventId, accepted, message]));
  }

  private sendNotice(peerId: string, message: string): void {
    this.send(peerId, JSON.stringify(['NOTICE', message]));
  }

  private countTotalSubs(): number {
    let total = 0;
    for(const peerSubs of this.subs.values()) {
      total += peerSubs.size;
    }
    return total;
  }

  private hasSub(peerId: string, subId: string): boolean {
    const peerSubs = this.subs.get(peerId);
    return peerSubs ? peerSubs.has(subId) : false;
  }
}
