/*
 * A fresh install has no contacts: the Contacts list says so and offers the
 * add, and Chats `+` goes straight to the New Contact pane (as Sessions `+`).
 */
import {describe, it, expect, vi} from 'vitest';
import fs from 'fs';
import {createContactsEmpty} from '@lib/phantomchat/contacts-empty';

const read = (path: string) => fs.readFileSync(path, 'utf-8');

describe('Contacts empty state', () => {
  it('with no search, explains and offers the add', () => {
    const onAdd = vi.fn();
    const el = createContactsEmpty(undefined, onAdd);
    expect(el.textContent).toContain('No contacts yet');
    const btn = el.querySelector('[data-testid="contacts-empty-add"]') as HTMLButtonElement;
    expect(btn.textContent).toBe('Add your first contact');
    btn.click();
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('a search with no match says so, with no add button', () => {
    const el = createContactsEmpty('zz', vi.fn());
    expect(el.textContent).toBe('No contacts found');
    expect(el.querySelector('button')).toBeNull();
  });

  it('an EMPTY worker answer draws the empty state, not a blank list', () => {
    const src = read('src/components/sidebarLeft/tabs/contacts.ts');
    const body = src.slice(src.indexOf('private renderContactsList('), src.indexOf('this.createList();', src.indexOf('private renderContactsList(')));
    expect(body).toMatch(/if\(!contacts\.length\)\s*\{\s*this\.renderEmpty\(query\);\s*return;/);
    // Both list paths pass the search through, so "No contacts found" vs the add is right.
    expect(src).toContain('this.renderContactsList(contacts, middleware, query)');
    expect(src).toContain('this.renderContactsList(peerIds, middleware, query)');
  });

  it('Chats + with no contacts opens the New Contact pane instead of the empty list', () => {
    const src = read('src/components/sidebarLeft/index.ts');
    const start = src.indexOf('private async openNewPrivateChatFlow()');
    const body = src.slice(start, src.indexOf('this.createTab(AppContactsTab).open();', start));
    expect(body).toContain('await this.listSessionContacts()');
    expect(body).toContain('openAddContactPane');
    expect(body).toContain('setInnerPeer');
  });
});
