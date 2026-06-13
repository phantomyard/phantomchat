/**
 * Tests for NIP-65 module — kind 10002 relay list event building and parsing
 */

import '../setup';
import {buildNip65Event, parseNip65Event, NOSTR_KIND_RELAY_LIST} from '@lib/nostra/nip65';
import type {RelayConfig} from '@lib/nostra/nostr-relay-pool';

// Generate a deterministic 32-byte private key for tests
const TEST_PRIVATE_KEY = new Uint8Array(32);
TEST_PRIVATE_KEY[0] = 1; // minimal valid key

describe('NIP-65 module', () => {
  describe('NOSTR_KIND_RELAY_LIST', () => {
    it('should be 10002', () => {
      expect(NOSTR_KIND_RELAY_LIST).toBe(10002);
    });
  });

  describe('buildNip65Event', () => {
    it('creates kind 10002 event with correct r tags for read+write relays', () => {
      const relays: RelayConfig[] = [
        {url: 'wss://relay.damus.io', read: true, write: true}
      ];

      const event = buildNip65Event(relays, TEST_PRIVATE_KEY);

      expect(event.kind).toBe(10002);
      expect(event.content).toBe('');
      expect(event.tags).toEqual([['r', 'wss://relay.damus.io']]);
      expect(event.id).toBeDefined();
      expect(event.sig).toBeDefined();
    });

    it('creates r tags with read marker for read-only relays', () => {
      const relays: RelayConfig[] = [
        {url: 'wss://read-only.relay', read: true, write: false}
      ];

      const event = buildNip65Event(relays, TEST_PRIVATE_KEY);

      expect(event.tags).toEqual([['r', 'wss://read-only.relay', 'read']]);
    });

    it('creates r tags with write marker for write-only relays', () => {
      const relays: RelayConfig[] = [
        {url: 'wss://write-only.relay', read: false, write: true}
      ];

      const event = buildNip65Event(relays, TEST_PRIVATE_KEY);

      expect(event.tags).toEqual([['r', 'wss://write-only.relay', 'write']]);
    });

    it('handles mixed read/write/both relays', () => {
      const relays: RelayConfig[] = [
        {url: 'wss://both.relay', read: true, write: true},
        {url: 'wss://read.relay', read: true, write: false},
        {url: 'wss://write.relay', read: false, write: true}
      ];

      const event = buildNip65Event(relays, TEST_PRIVATE_KEY);

      expect(event.tags).toEqual([
        ['r', 'wss://both.relay'],
        ['r', 'wss://read.relay', 'read'],
        ['r', 'wss://write.relay', 'write']
      ]);
    });

    it('uses strictly newer created_at than provided previous timestamp', () => {
      const relays: RelayConfig[] = [
        {url: 'wss://relay.damus.io', read: true, write: true}
      ];

      const previousTimestamp = Math.floor(Date.now() / 1000) + 100; // far future
      const event = buildNip65Event(relays, TEST_PRIVATE_KEY, previousTimestamp);

      expect(event.created_at).toBeGreaterThan(previousTimestamp);
    });

    it('works without previousTimestamp parameter', () => {
      const relays: RelayConfig[] = [
        {url: 'wss://relay.damus.io', read: true, write: true}
      ];

      const beforeTime = Math.floor(Date.now() / 1000) - 1;
      const event = buildNip65Event(relays, TEST_PRIVATE_KEY);

      expect(event.created_at).toBeGreaterThanOrEqual(beforeTime);
    });
  });

  describe('parseNip65Event', () => {
    it('extracts RelayConfig[] from event with read+write relay', () => {
      const event = {
        tags: [['r', 'wss://relay.damus.io']]
      };

      const configs = parseNip65Event(event);

      expect(configs).toEqual([
        {url: 'wss://relay.damus.io', read: true, write: true}
      ]);
    });

    it('extracts read-only relay from read marker', () => {
      const event = {
        tags: [['r', 'wss://read.relay', 'read']]
      };

      const configs = parseNip65Event(event);

      expect(configs).toEqual([
        {url: 'wss://read.relay', read: true, write: false}
      ]);
    });

    it('extracts write-only relay from write marker', () => {
      const event = {
        tags: [['r', 'wss://write.relay', 'write']]
      };

      const configs = parseNip65Event(event);

      expect(configs).toEqual([
        {url: 'wss://write.relay', read: false, write: true}
      ]);
    });

    it('ignores non-r tags', () => {
      const event = {
        tags: [
          ['p', 'somepubkey'],
          ['r', 'wss://relay.damus.io'],
          ['e', 'someeventid']
        ]
      };

      const configs = parseNip65Event(event);

      expect(configs).toHaveLength(1);
      expect(configs[0].url).toBe('wss://relay.damus.io');
    });

    it('ignores r tags without URL', () => {
      const event = {
        tags: [['r'], ['r', 'wss://valid.relay']]
      };

      const configs = parseNip65Event(event);

      expect(configs).toHaveLength(1);
      expect(configs[0].url).toBe('wss://valid.relay');
    });

    it('handles empty tags', () => {
      const event = {tags: [] as string[][]};
      const configs = parseNip65Event(event);
      expect(configs).toEqual([]);
    });
  });
});
