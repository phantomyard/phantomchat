/*
 * The Contacts list with no rows. With no search typed it offers the add
 * right there, so a fresh install never lands on a blank list with nothing
 * to press (the corner `+` is easy to miss on an empty screen).
 *
 * Kept free of the sidebar graph so it is unit-testable.
 */

export function createContactsEmpty(query: string | undefined, onAdd: () => void): HTMLElement {
  const emptyEl = document.createElement('div');
  emptyEl.classList.add('contacts-empty');
  emptyEl.setAttribute('data-testid', 'contacts-empty');
  emptyEl.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:1rem;padding:2.5rem 1.5rem;text-align:center;color:var(--secondary-text-color);';
  const text = document.createElement('div');
  text.textContent = query ? 'No contacts found' : 'No contacts yet. Add a Phantom, a person or an AI provider to start chatting.';
  emptyEl.append(text);
  if(!query) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-primary btn-color-primary';
    btn.style.cssText = 'width:auto;padding:0 1.5rem;';
    btn.setAttribute('data-testid', 'contacts-empty-add');
    btn.textContent = 'Add your first contact';
    btn.addEventListener('click', () => onAdd());
    emptyEl.append(btn);
  }
  return emptyEl;
}
