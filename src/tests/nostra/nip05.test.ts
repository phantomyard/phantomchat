/**
 * Tests for NIP-05 identity verification and kind 0 metadata
 */

import {describe, it, expect, vi, beforeEach} from 'vitest';
import {verifyNip05, buildNip05Instructions} from '@lib/nostra/nip05';

// Mock fetch for NIP-05 verification tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('NIP-05 verification', () => {
  const testPubkey = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

  describe('verifyNip05', () => {
    it('returns error for invalid alias format (no @)', async() => {
      const result = await verifyNip05('alice', testPubkey);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Invalid NIP-05 format');
    });

    it('returns error for invalid alias format (empty name)', async() => {
      const result = await verifyNip05('@example.com', testPubkey);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Invalid NIP-05 format');
    });

    it('returns error for invalid domain', async() => {
      const result = await verifyNip05('alice@nodot', testPubkey);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Invalid domain');
    });

    it('verifies valid NIP-05 alias with matching pubkey', async() => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async() => ({
          names: {
            alice: testPubkey
          }
        })
      });

      const result = await verifyNip05('alice@example.com', testPubkey);
      expect(result.ok).toBe(true);

      // Verify correct URL was fetched
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/.well-known/nostr.json?name=alice'
      );
    });

    it('fails when pubkey does not match', async() => {
      const wrongPubkey = '1111111111111111111111111111111111111111111111111111111111111111';
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async() => ({
          names: {
            alice: wrongPubkey
          }
        })
      });

      const result = await verifyNip05('alice@example.com', testPubkey);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Pubkey mismatch');
    });

    it('fails when name not found in nostr.json', async() => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async() => ({
          names: {
            bob: testPubkey
          }
        })
      });

      const result = await verifyNip05('alice@example.com', testPubkey);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not found in nostr.json');
    });

    it('fails when nostr.json has no names object', async() => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async() => ({})
      });

      const result = await verifyNip05('alice@example.com', testPubkey);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('missing names object');
    });

    it('handles HTTP error from server', async() => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404
      });

      const result = await verifyNip05('alice@example.com', testPubkey);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('404');
    });

    it('handles CORS/network error', async() => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const result = await verifyNip05('alice@example.com', testPubkey);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('CORS or network error');
    });

    it('handles generic fetch error', async() => {
      mockFetch.mockRejectedValueOnce(new Error('DNS resolution failed'));

      const result = await verifyNip05('alice@example.com', testPubkey);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('DNS resolution failed');
    });

    it('case-insensitive pubkey comparison', async() => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async() => ({
          names: {
            alice: testPubkey.toUpperCase()
          }
        })
      });

      const result = await verifyNip05('alice@example.com', testPubkey);
      expect(result.ok).toBe(true);
    });
  });

  describe('buildNip05Instructions', () => {
    it('generates correct JSON snippet', () => {
      const snippet = buildNip05Instructions('alice', testPubkey);
      const parsed = JSON.parse(snippet);
      expect(parsed.names.alice).toBe(testPubkey);
    });

    it('handles names with special characters', () => {
      const snippet = buildNip05Instructions('alice-bob', testPubkey);
      const parsed = JSON.parse(snippet);
      expect(parsed.names['alice-bob']).toBe(testPubkey);
    });
  });
});

describe('Kind 0 metadata event structure', () => {
  it('kind 0 content is valid JSON with name and nip05 fields', () => {
    const metadata = {
      name: 'Alice',
      display_name: 'Alice',
      nip05: 'alice@example.com'
    };

    const content = JSON.stringify(metadata);
    const parsed = JSON.parse(content);

    expect(parsed.name).toBe('Alice');
    expect(parsed.display_name).toBe('Alice');
    expect(parsed.nip05).toBe('alice@example.com');
  });

  it('kind 0 event has correct structure', () => {
    const metadata = {
      name: 'Alice',
      nip05: 'alice@example.com'
    };

    const event = {
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [] as string[][],
      content: JSON.stringify(metadata)
    };

    expect(event.kind).toBe(0);
    expect(event.tags).toEqual([]);
    expect(typeof event.created_at).toBe('number');

    const parsedContent = JSON.parse(event.content);
    expect(parsedContent.name).toBe('Alice');
    expect(parsedContent.nip05).toBe('alice@example.com');
  });
});
