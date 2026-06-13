import {describe, it, expect} from 'vitest';
import {
  generateNostrIdentity,
  importFromMnemonic,
  validateMnemonic,
  npubEncode,
  nsecEncode,
  decodePubkey
} from '@lib/nostra/nostr-identity';

describe('nostr-identity', () => {
  describe('NIP-06 test vector', () => {
    const testMnemonic = 'leader monkey parrot ring guide accident before fence cannon height naive bean';
    const expectedPrivkeyHex = '7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a';
    const expectedPubkeyHex = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';

    it('derives correct private key from test vector mnemonic', () => {
      const identity = importFromMnemonic(testMnemonic);
      expect(identity.privateKey).toBe(expectedPrivkeyHex);
    });

    it('derives correct public key from test vector mnemonic', () => {
      const identity = importFromMnemonic(testMnemonic);
      expect(identity.publicKey).toBe(expectedPubkeyHex);
    });
  });

  describe('generateNostrIdentity', () => {
    it('returns object with mnemonic, privateKey, publicKey, npub, nsec', () => {
      const identity = generateNostrIdentity();
      expect(identity).toHaveProperty('mnemonic');
      expect(identity).toHaveProperty('privateKey');
      expect(identity).toHaveProperty('publicKey');
      expect(identity).toHaveProperty('npub');
      expect(identity).toHaveProperty('nsec');
    });

    it('generates valid 12-word mnemonic', () => {
      const identity = generateNostrIdentity();
      const words = identity.mnemonic.split(' ');
      expect(words.length).toBe(12);
    });

    it('generates npub starting with npub1', () => {
      const identity = generateNostrIdentity();
      expect(identity.npub.startsWith('npub1')).toBe(true);
    });

    it('generates nsec starting with nsec1', () => {
      const identity = generateNostrIdentity();
      expect(identity.nsec.startsWith('nsec1')).toBe(true);
    });

    it('generates different identities each call', () => {
      const a = generateNostrIdentity();
      const b = generateNostrIdentity();
      expect(a.privateKey).not.toBe(b.privateKey);
    });
  });

  describe('importFromMnemonic', () => {
    it('returns same structure as generateNostrIdentity', () => {
      const identity = importFromMnemonic('leader monkey parrot ring guide accident before fence cannon height naive bean');
      expect(identity).toHaveProperty('mnemonic');
      expect(identity).toHaveProperty('privateKey');
      expect(identity).toHaveProperty('publicKey');
      expect(identity).toHaveProperty('npub');
      expect(identity).toHaveProperty('nsec');
    });

    it('throws on invalid mnemonic', () => {
      expect(() => importFromMnemonic('invalid words that are not a real mnemonic phrase at all')).toThrow();
    });
  });

  describe('validateMnemonic', () => {
    it('returns true for valid mnemonic', () => {
      expect(validateMnemonic('leader monkey parrot ring guide accident before fence cannon height naive bean')).toBe(true);
    });

    it('returns false for invalid mnemonic', () => {
      expect(validateMnemonic('foo bar baz')).toBe(false);
    });
  });

  describe('npubEncode', () => {
    it('returns string starting with npub1', () => {
      const result = npubEncode('17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917');
      expect(result.startsWith('npub1')).toBe(true);
    });
  });

  describe('nsecEncode', () => {
    it('returns string starting with nsec1', () => {
      const {hexToBytes} = require('nostr-tools/utils');
      const privBytes = hexToBytes('7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a');
      const result = nsecEncode(privBytes);
      expect(result.startsWith('nsec1')).toBe(true);
    });
  });

  describe('decodePubkey', () => {
    it('returns hex when given hex', () => {
      const hex = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';
      expect(decodePubkey(hex)).toBe(hex);
    });

    it('returns hex when given npub', () => {
      const hex = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';
      const npub = npubEncode(hex);
      expect(decodePubkey(npub)).toBe(hex);
    });
  });
});
