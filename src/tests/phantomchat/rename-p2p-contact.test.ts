/**
 * Regression tests for the P2P contact rename path.
 *
 * Background: the stock tweb Edit Contact → Save handler calls
 * appUsersManager.addContact → invokeApi('contacts.addContact'), which the
 * local virtual-MTProto server does not implement, so for a synthetic P2P
 * (Nostr) peer the rename silently no-ops and the name reverts to the npub
 * placeholder on the next render.
 *
 * renameP2PContact drives the working primitives instead. These tests lock in:
 * - the helper persists to IndexedDB, updates the live Worker user, the
 *   main-thread mirror, and dispatches peer_title_edit;
 * - the Edit Contact tab routes P2P peers through renameP2PContact and only
 *   non-P2P peers through the stock addContact path.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';

const SRC = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

describe('renameP2PContact — helper', () => {
  const helperSrc = read('lib/phantomchat/rename-p2p-contact.ts');

  it('exports the renameP2PContact function', () => {
    expect(helperSrc).toMatch(/export async function renameP2PContact/);
  });

  it('resolves the pubkey via getPubkey and force-writes via setMappingDisplayName', () => {
    expect(helperSrc).toMatch(/getPubkey/);
    expect(helperSrc).toMatch(/setMappingDisplayName/);
  });

  it('updates the live synthetic Worker user with first + last name', () => {
    expect(helperSrc).toMatch(/updateP2PUserName\(peerId,\s*first,\s*last\)/);
  });

  it('updates the main-thread peer mirror (first_name + last_name) and reconciles the store', () => {
    expect(helperSrc).toMatch(/mirrors\.peers\[peerIdTweb\]\.first_name\s*=\s*first/);
    expect(helperSrc).toMatch(/mirrors\.peers\[peerIdTweb\]\.last_name/);
    expect(helperSrc).toContain('reconcilePeer');
  });

  it('dispatches peer_title_edit so chat-list + topbar refresh imperatively', () => {
    expect(helperSrc).toMatch(/dispatchEvent\('peer_title_edit'/);
  });

  it('combines first + last into a trimmed display name', () => {
    expect(helperSrc).toMatch(/\[first,\s*last\]\.filter\(Boolean\)\.join\(' '\)/);
  });
});

describe('Edit Contact routes P2P peers through renameP2PContact', () => {
  const editSrc = read('components/sidebarRight/tabs/editContact.ts');

  it('gates on isP2PPeer before choosing the rename path', () => {
    expect(editSrc).toMatch(/isP2PPeer\(Number\(userId\)\)/);
  });

  it('calls renameP2PContact for P2P peers', () => {
    expect(editSrc).toMatch(/renameP2PContact\(Number\(userId\)/);
  });

  it('still uses the stock addContact path for non-P2P peers', () => {
    expect(editSrc).toMatch(/appUsersManager\.addContact\(/);
  });
});
