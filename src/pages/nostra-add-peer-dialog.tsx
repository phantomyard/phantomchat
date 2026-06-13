/**
 * Nostra.chat Add Peer Dialog
 *
 * Minimal modal dialog that lets users initiate a P2P chat by pasting an OwnID.
 * Follows the NostraOnboarding vanilla-DOM pattern.
 */

import {MOUNT_CLASS_TO} from '@config/debug';
import './nostra-onboarding-tweb.css';

const LOG_PREFIX = '[NostraAddPeerDialog]';

/** OwnID validation: 3 groups of 5 alphanumeric chars (no 0/O/1/I/L confusables), separated by dots */
export const OWN_ID_PATTERN = /^(?!.*[oOiIlL])[A-Z2-9]{5}\.[A-Z2-9]{5}\.[A-Z2-9]{5}$/;

/**
 * Validate an OwnID format.
 * @param ownId - The OwnID string to validate
 * @returns true if valid, false otherwise
 */
export function validateOwnId(ownId: string): boolean {
  return OWN_ID_PATTERN.test(ownId.trim());
}

/**
 * Show the Add Peer dialog.
 * Exposed globally for console access and future button wiring.
 */
export function showAddPeerDialog(): void {
  // Reuse existing instance if not destroyed
  const existing = (window as any).__nostraAddPeerDialog as NostraAddPeerDialog | undefined;
  if(existing && !existing.isDestroyed()) {
    existing.show();
    return;
  }

  const dialog = NostraAddPeerDialog.create((ownId) => {
    // Once connected, synthetic peers will appear in the sidebar via displayBridge.
    // The user opens the chat via the sidebar.
    console.log(`${LOG_PREFIX} connection initiated to:`, ownId);
  });
  (window as any).__nostraAddPeerDialog = dialog;
  dialog.show();
}

// Expose for console/debug use
if(typeof window !== 'undefined') {
  (window as any).__showAddPeerDialog = showAddPeerDialog;
}

/**
 * Add Peer modal dialog component.
 */
export class NostraAddPeerDialog {
  private container: HTMLElement;
  private overlay: HTMLElement;
  private onConnect: (ownId: string) => void;
  private _destroyed = false;
  private _rendered = false;

  private constructor(
    container: HTMLElement,
    overlay: HTMLElement,
    onConnect: (ownId: string) => void
  ) {
    this.container = container;
    this.overlay = overlay;
    this.onConnect = onConnect;
  }

  /**
   * Factory method to create a new dialog instance.
   */
  static create(onConnect: (ownId: string) => void): NostraAddPeerDialog {
    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'nostra-dialog-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `;

    // Create dialog container
    const container = document.createElement('div');
    container.className = 'nostra-dialog';

    overlay.appendChild(container);
    document.body.appendChild(overlay);

    return new NostraAddPeerDialog(container, overlay, onConnect);
  }

  isDestroyed(): boolean {
    return this._destroyed;
  }

  show(): void {
    if(this._destroyed) return;
    if(!this._rendered) {
      this.render();
      this._rendered = true;
    }
    this.overlay.style.display = 'flex';

    // Focus the input after show
    requestAnimationFrame(() => {
      const input = this.container.querySelector<HTMLInputElement>('#nostra-ownid-input');
      input?.focus();
    });
  }

  hide(): void {
    this.overlay.style.display = 'none';
    // Clear input when hiding
    const input = this.container.querySelector<HTMLInputElement>('#nostra-ownid-input');
    const errorEl = this.container.querySelector('#nostra-ownid-error') as HTMLElement | null;
    if(input) {
      input.value = '';
      input.style.borderColor = '#2d3748';
    }
    if(errorEl) {
      errorEl.style.display = 'none';
    }
  }

  destroy(): void {
    if(this._destroyed) return;
    this._destroyed = true;
    this.overlay.remove();
    delete (window as any).__nostraAddPeerDialog;
  }

  private render(): void {
    this.container.style.cssText = `
      background: #1a1a2e;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 2rem;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    `;

    this.container.innerHTML = `
      <div class="nostra-dialog-header">
        <h2 style="
          margin: 0 0 0.5rem 0;
          font-size: 1.25rem;
          font-weight: 700;
          color: #fff;
        ">Connect with a Peer</h2>
        <p style="
          margin: 0 0 1.5rem 0;
          font-size: 0.875rem;
          color: #8892b0;
        ">Enter their OwnID to start a P2P chat</p>
      </div>

      <div class="nostra-dialog-body">
        <label for="nostra-ownid-input" style="
          display: block;
          font-size: 0.75rem;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: #8892b0;
          margin-bottom: 0.5rem;
        ">Their OwnID</label>
        <input
          type="text"
          id="nostra-ownid-input"
          placeholder="XXXXX.XXXXX.XXXXX"
          autocomplete="off"
          autocorrect="off"
          autocapitalize="characters"
          spellcheck="false"
          style="
            width: 100%;
            padding: 0.875rem 1rem;
            border: 2px solid #2d3748;
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.05);
            color: #fff;
            font-size: 1rem;
            font-family: 'Monaco', 'Menlo', monospace;
            letter-spacing: 0.05em;
            box-sizing: border-box;
            outline: none;
            transition: border-color 0.2s ease;
          "
        />
        <p id="nostra-ownid-error" style="
          color: #ff6b6b;
          font-size: 0.75rem;
          margin: 0.5rem 0 0 0;
          display: none;
        "></p>
      </div>

      <div class="nostra-dialog-actions" style="
        display: flex;
        gap: 0.75rem;
        margin-top: 1.5rem;
      ">
        <button
          id="nostra-dialog-cancel"
          style="
            flex: 1;
            padding: 0.875rem 1rem;
            border: 2px solid #2d3748;
            border-radius: 8px;
            background: transparent;
            color: #8892b0;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
          "
        >Cancel</button>
        <button
          id="nostra-dialog-connect"
          style="
            flex: 1;
            padding: 0.875rem 1rem;
            border: none;
            border-radius: 8px;
            background: linear-gradient(135deg, #229EDD, #1a9fd4);
            color: white;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
          "
        >Connect</button>
      </div>
    `;

    this.attachEventListeners();
  }

  private attachEventListeners(): void {
    const cancelBtn = this.container.querySelector('#nostra-dialog-cancel') as HTMLButtonElement;
    const connectBtn = this.container.querySelector('#nostra-dialog-connect') as HTMLButtonElement;
    const input = this.container.querySelector('#nostra-ownid-input') as HTMLInputElement;
    const errorEl = this.container.querySelector('#nostra-ownid-error') as HTMLElement;

    cancelBtn.addEventListener('click', () => {
      this.hide();
    });

    // Close on overlay click (outside dialog box)
    this.overlay.addEventListener('click', (e: MouseEvent) => {
      if((e.target as HTMLElement) === this.overlay) {
        this.hide();
      }
    });

    // Close on Escape key
    const handleEscape = (e: KeyboardEvent) => {
      if(e.key === 'Escape') {
        this.hide();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);

    // Enter key triggers connect
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if(e.key === 'Enter') {
        e.preventDefault();
        this.handleConnect(input, errorEl);
      }
    });

    // Clear error on input change
    input.addEventListener('input', () => {
      errorEl.style.display = 'none';
      input.style.borderColor = '#2d3748';
    });

    connectBtn.addEventListener('click', () => {
      this.handleConnect(input, errorEl);
    });
  }

  private async handleConnect(input: HTMLInputElement, errorEl: HTMLElement): Promise<void> {
    const rawValue = input.value.trim();
    const ownId = rawValue.toUpperCase();

    if(!OWN_ID_PATTERN.test(ownId)) {
      errorEl.textContent = 'Invalid format. Expected: XXXXX.XXXXX.XXXXX';
      errorEl.style.display = 'block';
      input.style.borderColor = '#ff6b6b';
      console.log(`${LOG_PREFIX} invalid ownId format`);
      return;
    }

    console.log(`${LOG_PREFIX} connecting to ownId:`, ownId.slice(0, 8) + '...');

    // Disable connect button during connection attempt
    const connectBtn = this.container.querySelector('#nostra-dialog-connect') as HTMLButtonElement;
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting...';

    try {
      // Connect via ChatAPI (exposed globally by onboarding integration)
      const chatAPI = (window as any).__nostraChatAPI;
      if(chatAPI) {
        await chatAPI.connect(ownId);
      }

      console.log(`${LOG_PREFIX} connection initiated to:`, ownId);
      this.hide();
      this.onConnect(ownId);
    } catch(err) {
      console.error(`${LOG_PREFIX} connection failed:`, err);
      errorEl.textContent = `Connection failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
      errorEl.style.display = 'block';
      input.style.borderColor = '#ff6b6b';
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'Connect';
    }
  }
}
