/**
 * Tests for Contacts Tab UI improvements:
 * 1. Inline Checkbox, Edit (pencil), and Delete (trash) action buttons on each contact row
 * 2. Edit Contact modal popup
 * 3. Dynamic header red Delete button shown only when checkboxes are ticked
 * 4. Multi-select batch deletion of contacts and conversations
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';

const SRC = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

describe('Contacts UI — action badges & dynamic delete button', () => {
  const contactsSrc = read('components/sidebarLeft/tabs/contacts.ts');
  const popupSrc = read('components/popups/editContact.ts');

  it('provides inline Checkbox, Edit (pencil) and Delete (trash) on each contact row', () => {
    expect(contactsSrc).toMatch(/decorateContactElement/);
    expect(contactsSrc).toMatch(/contactCheckbox/);
    expect(contactsSrc).toMatch(/actionBadgeEdit/);
    expect(contactsSrc).toMatch(/actionBadgeDelete/);
    expect(contactsSrc).toMatch(/openEditContact/);
    expect(contactsSrc).toMatch(/confirmDeleteContactAndChat/);
  });

  it('stops event propagation on all row button clicks so contact chat navigation is prevented', () => {
    expect(contactsSrc).toMatch(/checkBtn\.addEventListener\('mousedown',\s*\(e\)\s*=>\s*e\.stopPropagation\(\)\)/);
    expect(contactsSrc).toMatch(/btnEdit\.addEventListener\('mousedown',\s*\(e\)\s*=>\s*e\.stopPropagation\(\)\)/);
    expect(contactsSrc).toMatch(/btnDelete\.addEventListener\('mousedown',\s*\(e\)\s*=>\s*e\.stopPropagation\(\)\)/);
  });

  it('has a dynamic red Delete button in the header that updates with ticked checkboxes', () => {
    expect(contactsSrc).toMatch(/headerDeleteBtn/);
    expect(contactsSrc).toMatch(/updateSelectionUI/);
    expect(contactsSrc).toMatch(/headerDeleteBtn\.style\.display\s*=\s*'inline-flex'/);
    expect(contactsSrc).toMatch(/headerDeleteBtn\.style\.display\s*=\s*'none'/);
    expect(contactsSrc).toMatch(/confirmBatchDeleteSelected/);
    expect(contactsSrc).toMatch(/deleteBatchContactsAndChats/);
  });

  it('exports showEditContactPopup with support for both P2P and MTProto contacts', () => {
    expect(popupSrc).toMatch(/export async function showEditContactPopup/);
    expect(popupSrc).toMatch(/renameP2PContact/);
    expect(popupSrc).toMatch(/managers\.appUsersManager\.addContact/);
  });
});
