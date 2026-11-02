/**
 * The small "running on this PC" pill shown while a remote contact's tool call
 * runs (#276). A plain element on purpose: it has to be visible from any screen.
 */
let element: HTMLElement | null = null;

export function setLocalToolsRunning(running: number): void {
  if(running <= 0) {
    element?.remove();
    element = null;
    return;
  }
  if(!element) {
    element = document.createElement('div');
    element.className = 'local-tools-indicator';
    element.setAttribute('role', 'status');
    element.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:5;padding:4px 10px;border-radius:12px;font-size:.8125rem;pointer-events:none;background:var(--surface-color);color:var(--primary-text-color);border:1px solid var(--border-color)';
    document.body.append(element);
  }
  element.textContent = running === 1 ? 'A contact is running a command on this PC' : `Contacts are running ${running} commands on this PC`;
}
