/*
 * The relay connection of one External AI. The renderer's relay stack is not
 * available in main, so this is a small client of its own over nostr-tools.
 */
import {finalizeEvent, type Event as NostrEvent} from 'nostr-tools/pure';
import {SimplePool} from 'nostr-tools/pool';

export const NOSTR_KIND_GIFTWRAP = 1059;
/** Polling covers an event a relay failed to push live. */
const CATCH_UP_INTERVAL_MS = 60_000;
const CATCH_UP_WINDOW_SEC = 120;

export interface MemberProfile {
  name: string | null;
  bot: boolean;
}

export interface RelayLink {
  start(sinceSec: number, onEvent: (event: NostrEvent) => void): void;
  publish(event: NostrEvent): Promise<void>;
  profiles(pubkeys: string[]): Promise<Map<string, MemberProfile>>;
  setRelays(relays: string[]): void;
  stop(): void;
}

export function parseProfile(content: string): MemberProfile {
  try {
    const parsed = JSON.parse(content);
    const name = [parsed?.display_name, parsed?.displayName, parsed?.name].find((v) => typeof v === 'string' && v.trim());
    return {name: name ? String(name).trim() : null, bot: parsed?.bot === true};
  } catch{
    return {name: null, bot: false};
  }
}

/**
 * A relay's unanswered NIP-42 AUTH must not surface as an unhandled rejection:
 * nostr-tools fires auth() from its frame handler and holds no reference to it.
 * Wrapped per instance, since each entry point of the library bundles its own class.
 */
class GuardedPool extends SimplePool {
  constructor(secretKey: Uint8Array) {
    super({enablePing: true, enableReconnect: true});
    this.automaticallyAuth = (relayUrl: string) => {
      const relay = this.relays.get(relayUrl) as any;
      if(relay && !relay.__authGuarded) {
        relay.__authGuarded = true;
        const original = relay.auth.bind(relay);
        relay.auth = (signer: unknown) => {
          const pending = original(signer);
          pending.catch(() => {});
          return pending;
        };
      }
      return (template: Parameters<typeof finalizeEvent>[0]) => Promise.resolve(finalizeEvent(template, secretKey));
    };
  }
}

export class NostrRelayLink implements RelayLink {
  private readonly pool: GuardedPool;
  private subscription?: {close(): void};
  private poll?: ReturnType<typeof setInterval>;
  private relays: string[];
  private since = 0;
  private onEvent?: (event: NostrEvent) => void;

  constructor(private readonly pubkey: string, secretKey: Uint8Array, relays: string[]) {
    this.pool = new GuardedPool(secretKey);
    this.relays = relays;
  }

  start(sinceSec: number, onEvent: (event: NostrEvent) => void): void {
    this.since = sinceSec;
    this.onEvent = onEvent;
    this.subscribe();
    this.poll = setInterval(() => {
      const since = Math.floor(Date.now() / 1000) - CATCH_UP_WINDOW_SEC;
      this.pool.querySync(this.relays, {kinds: [NOSTR_KIND_GIFTWRAP], '#p': [this.pubkey], since})
      .then((events) => events.forEach((event) => this.onEvent?.(event)))
      .catch(() => {});
    }, CATCH_UP_INTERVAL_MS);
    this.poll.unref?.();
  }

  private subscribe(): void {
    this.subscription?.close();
    this.subscription = this.pool.subscribeMany(this.relays, {
      kinds: [NOSTR_KIND_GIFTWRAP],
      '#p': [this.pubkey],
      since: this.since
    }, {
      onevent: (event) => this.onEvent?.(event)
    });
  }

  setRelays(relays: string[]): void {
    if(relays.join() === this.relays.join()) return;
    this.relays = relays;
    if(this.onEvent) {
      this.since = Math.floor(Date.now() / 1000) - CATCH_UP_WINDOW_SEC;
      this.subscribe();
    }
  }

  async publish(event: NostrEvent): Promise<void> {
    await Promise.any(this.pool.publish(this.relays, event));
  }

  async profiles(pubkeys: string[]): Promise<Map<string, MemberProfile>> {
    const out = new Map<string, MemberProfile>();
    if(!pubkeys.length) return out;
    const events = await this.pool.querySync(this.relays, {kinds: [0], authors: pubkeys}, {maxWait: 3000});
    const newest = new Map<string, NostrEvent>();
    for(const event of events) {
      const current = newest.get(event.pubkey);
      if(!current || current.created_at < event.created_at) newest.set(event.pubkey, event);
    }
    for(const [pubkey, event] of newest) out.set(pubkey, parseProfile(event.content));
    return out;
  }

  stop(): void {
    this.subscription?.close();
    if(this.poll) clearInterval(this.poll);
    this.pool.destroy();
  }
}
