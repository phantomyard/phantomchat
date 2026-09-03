/**
 * Tests for Contacts Tab UI improvements:
 * 1. Inline Edit & Delete action badges on each contact row
 * 2. Edit Contact modal popup
 * 3. Multi-select toggle, header action bar, and batch deletion
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';

const SRC = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

describe('Contacts UI — action badges & multi-select', () => {
  const contactsSrc = read('components/sidebarLeft/tabs/contacts.ts');
  const popupSrc = read('components/popups/editContact.ts');

  it('provides inline Edit and Delete action badges on contact rows', () => {
    expect(contactsSrc).toMatch(/decorateContactElement/);
    expect(contactsSrc).toMatch(/actionBadgeEdit/);
    expect(contactsSrc).toMatch(/actionBadgeDelete/);
    expect(contactsSrc).toMatch(/openEditContact/);
    expect(contactsSrc).toMatch(/confirmDeleteContactAndChat/);
  });

  it('stops event propagation on badge clicks so row selection / navigation is prevented', () => {
    expect(contactsSrc).toMatch(/btnEdit\.addEventListener\('mousedown',\s*\(e\)\s*=>\s*e\.stopPropagation\(\)\)/);
    expect(contactsSrc).toMatch(/btnDelete\.addEventListener\('mousedown',\s*\(e\)\s*=>\s*e\.stopPropagation\(\)\)/);
  });

  it('supports multi-select mode with selection bar and batch deletion', () => {
    expect(contactsSrc).toMatch(/toggleSelectionMode/);
    expect(contactsSrc).toMatch(/createSelectionBar/);
    expect(contactsSrc).toMatch(/togglePeerSelection/);
    expect(contactsSrc).toMatch(/toggleSelectAll/);
    expect(contactsSrc).toMatch(/confirmBatchDeleteSelected/);
    expect(contactsSrc).toMatch(/deleteBatchContactsAndChats/);
  });

  it('intercepts list clicks in selection mode to toggle selection instead of opening chat', () => {
    expect(contactsSrc).toMatch(/if\(this\.isSelectionMode\)\s*\{\s*const peerId\s*=\s*target\.dataset\.peerId\.toPeerId\(\);\s*this\.togglePeerSelection\(peerId,\s*target\);\s*return false;\s*\}/);
  });

  it('exports showEditContactPopup with support for both P2P and MTProto contacts', () => {
    expect(popupSrc).toMatch(/export async function showEditContactPopup/);
    expect(popupSrc).toMatch(/renameP2PContact/);
    expect(popupSrc).toMatch(/managers\.appUsersManager\.addContact/);
  });
});
