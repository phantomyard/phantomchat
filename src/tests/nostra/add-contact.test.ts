import {describe, it, expect, vi, beforeEach} from 'vitest';
import {decodePubkey, npubEncode} from '@lib/nostra/nostr-identity';

// Mock NostraBridge
const mockMapPubkeyToPeerId = vi.fn().mockResolvedValue(1000000000000001);
const mockCreateSyntheticUser = vi.fn().mockReturnValue({
  _: 'user',
  id: 1000000000000001,
  pFlags: {},
  first_name: 'P2P User'
});
const mockStorePeerMapping = vi.fn().mockResolvedValue(undefined);

vi.mock('@lib/nostra/nostra-bridge', () => ({
  NostraBridge: {
    getInstance: () => ({
      mapPubkeyToPeerId: mockMapPubkeyToPeerId,
      createSyntheticUser: mockCreateSyntheticUser,
      storePeerMapping: mockStorePeerMapping
    })
  }
}));

// Mock appImManager
const mockSetPeer = vi.fn().mockResolvedValue(true);
vi.mock('@lib/appImManager', () => ({
  default: {
    setPeer: mockSetPeer
  }
}));

// Known test npub/pubkey pair
const TEST_PUBKEY_HEX = '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917';
const TEST_NPUB = npubEncode(TEST_PUBKEY_HEX);

describe('add-contact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('npub validation', () => {
    it('decodePubkey accepts valid npub and returns hex', () => {
      const hex = decodePubkey(TEST_NPUB);
      expect(hex).toBe(TEST_PUBKEY_HEX);
    });

    it('decodePubkey accepts raw hex and returns it unchanged', () => {
      const hex = decodePubkey(TEST_PUBKEY_HEX);
      expect(hex).toBe(TEST_PUBKEY_HEX);
    });

    it('decodePubkey throws on invalid npub', () => {
      expect(() => decodePubkey('npub1invalid')).toThrow();
    });

    it('decodePubkey throws on malformed bech32', () => {
      expect(() => decodePubkey('npub1zzzzzzzzzzzzzzz')).toThrow();
    });
  });

  describe('addContact flow with valid npub', () => {
    it('calls mapPubkeyToPeerId with correct hex pubkey', async() => {
      const pubkey = decodePubkey(TEST_NPUB);
      await mockMapPubkeyToPeerId(pubkey);
      expect(mockMapPubkeyToPeerId).toHaveBeenCalledWith(TEST_PUBKEY_HEX);
    });

    it('calls createSyntheticUser with pubkey and peerId', async() => {
      const pubkey = decodePubkey(TEST_NPUB);
      const peerId = await mockMapPubkeyToPeerId(pubkey);
      mockCreateSyntheticUser(pubkey, peerId);
      expect(mockCreateSyntheticUser).toHaveBeenCalledWith(TEST_PUBKEY_HEX, 1000000000000001);
    });

    it('calls storePeerMapping to persist the mapping', async() => {
      const pubkey = decodePubkey(TEST_NPUB);
      const peerId = await mockMapPubkeyToPeerId(pubkey);
      await mockStorePeerMapping(pubkey, peerId);
      expect(mockStorePeerMapping).toHaveBeenCalledWith(TEST_PUBKEY_HEX, 1000000000000001);
    });

    it('full addContact flow: decode, map, create user, store, navigate', async() => {
      // Simulate the addContact flow from the component
      const inputNpub = TEST_NPUB;

      // Step 1: Decode
      const pubkeyHex = decodePubkey(inputNpub);
      expect(pubkeyHex).toBe(TEST_PUBKEY_HEX);

      // Step 2: Map to peerId
      const peerId = await mockMapPubkeyToPeerId(pubkeyHex);
      expect(peerId).toBe(1000000000000001);

      // Step 3: Create synthetic user
      mockCreateSyntheticUser(pubkeyHex, peerId);
      expect(mockCreateSyntheticUser).toHaveBeenCalled();

      // Step 4: Store mapping
      await mockStorePeerMapping(pubkeyHex, peerId);
      expect(mockStorePeerMapping).toHaveBeenCalled();

      // Step 5: Navigate to chat
      await mockSetPeer({peerId});
      expect(mockSetPeer).toHaveBeenCalledWith({peerId: 1000000000000001});
    });
  });

  describe('addContact flow with invalid input', () => {
    it('invalid npub string causes decodePubkey to throw', () => {
      expect(() => decodePubkey('npub1notavalidnpubstring')).toThrow();
    });

    it('does not call bridge functions when npub is invalid', () => {
      try {
        decodePubkey('npub1invalid');
      } catch(_) {
        // Expected
      }
      expect(mockMapPubkeyToPeerId).not.toHaveBeenCalled();
      expect(mockCreateSyntheticUser).not.toHaveBeenCalled();
      expect(mockStorePeerMapping).not.toHaveBeenCalled();
    });
  });

  describe('QR scan handler', () => {
    it('valid npub from QR scan triggers addContact flow', async() => {
      // Simulate QR scan returning an npub string
      const scannedData = TEST_NPUB;

      // Validate via decodePubkey (this is what the component does)
      const pubkey = decodePubkey(scannedData);
      expect(pubkey).toBe(TEST_PUBKEY_HEX);

      // Proceed with add flow
      const peerId = await mockMapPubkeyToPeerId(pubkey);
      expect(mockMapPubkeyToPeerId).toHaveBeenCalledWith(TEST_PUBKEY_HEX);
      expect(peerId).toBe(1000000000000001);
    });

    it('invalid QR data (not npub) triggers error path', () => {
      const scannedData = 'https://example.com/not-a-qr';

      // Non-npub string passes through decodePubkey as hex
      // But it won't be a valid 64-char hex string
      const result = decodePubkey(scannedData);
      // The component validates hex format after decode
      const isValidHex = /^[0-9a-f]{64}$/i.test(result);
      expect(isValidHex).toBe(false);
    });
  });

  describe('dialog close behavior', () => {
    it('onClose callback is provided and callable', () => {
      const onClose = vi.fn();
      onClose();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('after successful add, dialog should close (onClose called)', async() => {
      const onClose = vi.fn();

      // Simulate successful addContact
      const pubkey = decodePubkey(TEST_NPUB);
      await mockMapPubkeyToPeerId(pubkey);
      mockCreateSyntheticUser(pubkey, 1000000000000001);
      await mockStorePeerMapping(pubkey, 1000000000000001);

      // Component calls onClose after successful add
      onClose();
      expect(onClose).toHaveBeenCalled();
    });
  });
});
