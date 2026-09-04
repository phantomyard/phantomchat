import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, vi} from 'vitest';
import {isGroupPeer} from '@lib/phantomchat/group-types';
import {isP2PPeerId} from '@lib/phantomchat/bridge-invariants';

// Polyfill Number.prototype.toPeerId / isUser if needed
if(!(Number.prototype as any).isUser) {
  (Number.prototype as any).isUser = function() {
    return (this as number) >= 0;
  };
}

describe('Topbar click routing logic', () => {
  type TabType = 'AppPhantomChatGroupEditTab' | 'AppEditContactTab' | 'StandardPeerInfo';

  function resolveTopbarClickRoute(peerId: any): TabType {
    const numericPeerId = +peerId;
    if(isGroupPeer(numericPeerId)) {
      return 'AppPhantomChatGroupEditTab';
    } else if(isP2PPeerId(numericPeerId) || (peerId && typeof peerId.isUser === 'function' ? peerId.isUser() : numericPeerId >= 0)) {
      return 'AppEditContactTab';
    } else {
      return 'StandardPeerInfo';
    }
  }

  it('routes synthetic Phantom groups (< -2e15) directly to AppPhantomChatGroupEditTab', () => {
    const syntheticGroupPeerId = -2000000000000001;
    expect(isGroupPeer(syntheticGroupPeerId)).toBe(true);
    expect(resolveTopbarClickRoute(syntheticGroupPeerId)).toBe('AppPhantomChatGroupEditTab');
  });

  it('replaces a group editor that belongs to a different group', async() => {
    const fs = await import('fs');
    const source = fs.readFileSync('src/components/chat/topbar.ts', 'utf-8');

    expect(source).toContain('existingTab.groupPeerId === +this.peerId');
    expect(source).toContain('createTab(AppPhantomChatGroupEditTab, true)');
  });

  it('routes synthetic P2P direct peers (>= 1e15) to AppEditContactTab', () => {
    const p2pPeerId = 1000000000000001;
    expect(isP2PPeerId(p2pPeerId)).toBe(true);
    expect(resolveTopbarClickRoute(p2pPeerId)).toBe('AppEditContactTab');
  });

  it('routes standard MTProto users (> 0) to AppEditContactTab', () => {
    const mtprotoUserPeerId = 987654321;
    expect(isGroupPeer(mtprotoUserPeerId)).toBe(false);
    expect(isP2PPeerId(mtprotoUserPeerId)).toBe(false);
    expect(resolveTopbarClickRoute(mtprotoUserPeerId)).toBe('AppEditContactTab');
  });

  it('routes standard MTProto groups (e.g. -12345678) to StandardPeerInfo', () => {
    const mtprotoGroupPeerId = -12345678;
    expect(isGroupPeer(mtprotoGroupPeerId)).toBe(false);
    expect(isP2PPeerId(mtprotoGroupPeerId)).toBe(false);
    expect(resolveTopbarClickRoute(mtprotoGroupPeerId)).toBe('StandardPeerInfo');
  });

  it('routes standard MTProto channels / supergroups (e.g. -1001234567890) to StandardPeerInfo', () => {
    const mtprotoChannelPeerId = -1001234567890;
    expect(isGroupPeer(mtprotoChannelPeerId)).toBe(false);
    expect(isP2PPeerId(mtprotoChannelPeerId)).toBe(false);
    expect(resolveTopbarClickRoute(mtprotoChannelPeerId)).toBe('StandardPeerInfo');
  });
});
