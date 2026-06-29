/**
 * Read-receipts privacy setting — single source of truth.
 *
 * PhantomChat couples typing / recording indicators to the read-receipts
 * toggle, WhatsApp-style: when read receipts are OFF the client neither sends
 * read receipts (delivery-tracker) NOR publishes typing / recording indicators
 * (virtual-mtproto-server emit), AND it suppresses incoming typing indicators
 * from others (phantomchat-typing-receive). One switch, mutual.
 *
 * The flag is persisted in `localStorage`. Everything that consumes it
 * (delivery-tracker, the VMT emit handler, the typing receiver, the Settings
 * toggle) lives on the MAIN thread, where `localStorage` is available — but we
 * still guard `typeof localStorage` so the module is safe to import in a Worker
 * build (it simply defaults to enabled there).
 *
 * Default is ENABLED (absent key → true) so a fresh install behaves like every
 * other chat app; only an explicit `'false'` disables.
 */

export const READ_RECEIPTS_KEY = 'phantomchat:read-receipts-enabled';

/** Reads the current setting. Defaults to true (enabled) when unset/unreadable. */
export function getReadReceiptsEnabled(): boolean {
  try {
    if(typeof localStorage === 'undefined') return true;
    return localStorage.getItem(READ_RECEIPTS_KEY) !== 'false';
  } catch{
    return true;
  }
}

/** Persists the setting. No-op if `localStorage` is unavailable. */
export function setReadReceiptsEnabledSetting(enabled: boolean): void {
  try {
    if(typeof localStorage === 'undefined') return;
    localStorage.setItem(READ_RECEIPTS_KEY, enabled ? 'true' : 'false');
  } catch{}
}
