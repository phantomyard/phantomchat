import {afterAll, beforeEach, describe, expect, it, vi} from 'vitest';
import 'fake-indexeddb/auto';
import {readFileSync} from 'fs';

afterAll(() => {
  vi.unmock('@lib/rootScope');
  vi.restoreAllMocks();
});

vi.mock('@lib/rootScope', () => ({
  default: {dispatchEventSingle: vi.fn(), dispatchEvent: vi.fn(), addEventListener: vi.fn()}
}));

import {PEER_PROFILE_CACHE_PREFIX} from '@lib/phantomchat/peer-profile-cache';
import {setContactPrefs, _resetContactPrefsForTests} from '@lib/phantomchat/contact-prefs';
import {isCachedPeerBot, resolveContactKindForPeer} from '@lib/phantomchat/contact-kind';

const HEX = 'b'.repeat(64);

function cacheProfile(profile: Record<string, unknown>) {
  localStorage.setItem(PEER_PROFILE_CACHE_PREFIX + HEX, JSON.stringify({profile, created_at: 1}));
}

describe('contact kind for the Edit Contact pane (Local tools switch)', () => {
  beforeEach(async() => {
    localStorage.clear();
    _resetContactPrefsForTests();
    indexedDB.deleteDatabase('phantomchat-contact-prefs');
  });

  it('a legacy contact whose kind-0 profile says bot is a Phantom even when the tweb user lost pFlags.bot', async() => {
    cacheProfile({name: 'Robbie', bot: true});
    expect(isCachedPeerBot(HEX)).toBe(true);
    // userIsBot=false: the Contacts list / add-contact / injectP2PUser rebuilt the user with empty pFlags.
    const {kind} = await resolveContactKindForPeer(HEX, false);
    expect(kind).toBe('phantom');
  });

  it('a legacy contact with no bot flag anywhere stays untyped (no Local tools)', async() => {
    cacheProfile({name: 'Alice'});
    expect((await resolveContactKindForPeer(HEX, false)).kind).toBeUndefined();
    expect((await resolveContactKindForPeer(null, false)).kind).toBeUndefined();
  });

  it('the user flag still counts without a cached profile, and a stored kind always wins', async() => {
    expect((await resolveContactKindForPeer(HEX, true)).kind).toBe('phantom');
    cacheProfile({bot: true});
    await setContactPrefs(HEX, {kind: 'human'});
    const {kind, prefs} = await resolveContactKindForPeer(HEX, true);
    expect(kind).toBe('human');
    expect(prefs?.kind).toBe('human');
  });

  it('the Edit Contact pane and the main-thread mirrors use the cached kind-0 bot flag', () => {
    expect(readFileSync('src/components/sidebarRight/tabs/editContact.ts', 'utf8')).toContain('resolveContactKindForPeer(contactPubkey, isBot)');
    expect(readFileSync('src/components/sidebarLeft/tabs/contacts.ts', 'utf8')).toContain('bot: isCachedPeerBot(m.pubkey)');
    expect(readFileSync('src/lib/phantomchat/add-p2p-contact.ts', 'utf8')).toContain('bot: isCachedPeerBot(hexPubkey)');
  });
});
