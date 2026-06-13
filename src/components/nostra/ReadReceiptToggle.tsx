/**
 * ReadReceiptToggle - Privacy setting toggle for read receipts
 *
 * Simple on/off toggle in Settings > Privacy for controlling whether
 * read receipts (blue checks) are sent and displayed.
 *
 * Reciprocal behavior (WhatsApp-style): if disabled, you don't send
 * read receipts and you don't see others' read receipts.
 */

import {createSignal, JSX} from 'solid-js';

/** Logger prefix */
const LOG_PREFIX = '[ReadReceiptToggle]';

/** localStorage key matching delivery-tracker.ts */
const READ_RECEIPTS_KEY = 'nostra:read-receipts-enabled';

/**
 * Read the current read receipts setting from localStorage.
 */
function getReadReceiptsEnabled(): boolean {
  if(typeof localStorage === 'undefined') return true;
  const stored = localStorage.getItem(READ_RECEIPTS_KEY);
  return stored !== 'false';
}

/**
 * Persist the read receipts setting to localStorage.
 */
function setReadReceiptsSetting(enabled: boolean): void {
  if(typeof localStorage === 'undefined') return;
  localStorage.setItem(READ_RECEIPTS_KEY, String(enabled));
}

/**
 * ReadReceiptToggle component for Privacy & Security settings.
 *
 * Props:
 * - class: optional CSS class
 */
export default function ReadReceiptToggle(props: {
  class?: string;
}): JSX.Element {
  const [enabled, setEnabled] = createSignal(getReadReceiptsEnabled());

  const handleToggle = () => {
    const newValue = !enabled();
    setEnabled(newValue);
    setReadReceiptsSetting(newValue);

    // Also update delivery tracker instance if available
    const chatAPI = (window as any).__nostraChatAPI;
    if(chatAPI) {
      const tracker = chatAPI.getDeliveryTracker?.();
      if(tracker) {
        tracker.setReadReceiptsEnabled(newValue);
      }
    }

    console.log(`${LOG_PREFIX} read receipts ${newValue ? 'enabled' : 'disabled'}`);
  };

  return (
    <div class={`read-receipt-toggle ${props.class || ''}`}>
      <div class="read-receipt-toggle__row">
        <div class="read-receipt-toggle__label">
          <div class="read-receipt-toggle__title">Conferme di lettura</div>
          <div class="read-receipt-toggle__description">
            Se disattivato, non invierai conferme di lettura e non vedrai quelle degli altri
          </div>
        </div>
        <label class="read-receipt-toggle__switch">
          <input
            type="checkbox"
            checked={enabled()}
            onChange={handleToggle}
          />
          <span class="read-receipt-toggle__slider"></span>
        </label>
      </div>
    </div>
  );
}
