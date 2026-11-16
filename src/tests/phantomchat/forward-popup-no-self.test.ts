/**
 * Forward must never offer your own account. In Telegram that row was "Saved
 * Messages"; PhantomChat has none, so PopupForward sets exceptSelf.
 * PopupPickUser is replaced by a recorder so only PopupForward's options are
 * under test.
 */
import {describe, it, expect, vi} from 'vitest';

const captured: any[] = [];
vi.mock('@components/popups/pickUser', () => ({
  default: class {
    constructor(options: any) {
      captured.push(options);
    }
  }
}));
vi.mock('@lib/appImManager', () => ({default: {}}));
vi.mock('@lib/rootScope', () => ({default: {myId: 1, managers: {}}}));
vi.mock('@components/toast', () => ({toastNew: () => {}}));
vi.mock('@components/popups', () => ({default: {createPopup: () => {}}}));
vi.mock('@stores/appState', () => ({useAppConfig: () => ({}), useIsFrozen: () => false}));

describe('PopupForward', () => {
  it('excludes your own account from the picker', async() => {
    const PopupForward = (await import('@components/popups/forward')).default;
    new (PopupForward as any)({1: [1]});
    expect(captured).toHaveLength(1);
    expect(captured[0].exceptSelf).toBe(true);
    expect(captured[0].peerType).toEqual(['dialogs', 'contacts']);
  });
});
