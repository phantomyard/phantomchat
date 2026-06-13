/**
 * Tests for Nostra.chat Add Peer Dialog
 */

import '../setup';
// Use relative path for the page component
import {validateOwnId, OWN_ID_PATTERN, NostraAddPeerDialog} from '../../pages/nostra-add-peer-dialog';

// ==================== OwnID Validation Tests ====================

describe('OwnID format validation', () => {
  describe('OWN_ID_PATTERN regex', () => {
    test('accepts valid OwnID formats', () => {
      const validOwnIds = [
        'AAAAA.BBBBB.CCCCC',
        '23456.23456.23456', // digits 2-9 only (no 0, 1)
        'XXXXX.YYYYY.ZZZZZ',
        'ABCDE.FGHJK.KMNPQ', // uses J,K instead of I, and no O in last group
        'P2P23.PEER3.PNEXX'  // no 0, 1, I, O, L
      ];

      for(const ownId of validOwnIds) {
        expect(OWN_ID_PATTERN.test(ownId)).toBe(true);
      }
    });

    test('accepts uppercase letters', () => {
      expect(OWN_ID_PATTERN.test('AAAAA.BBBBB.CCCCC')).toBe(true);
    });

    test('rejects lowercase letters (only uppercase allowed)', () => {
      // Pattern is uppercase-only (no 'i' flag)
      expect(OWN_ID_PATTERN.test('aaaaa.bbbbb.ccccc')).toBe(false);
    });

    test('accepts digits 2-9 (no 0, no 1)', () => {
      expect(OWN_ID_PATTERN.test('22222.33333.44444')).toBe(true);
    });

    test('rejects too-short first segment', () => {
      expect(OWN_ID_PATTERN.test('AAAA.BBBBB.CCCCC')).toBe(false);
    });

    test('rejects too-short second segment', () => {
      expect(OWN_ID_PATTERN.test('AAAAA.BBBB.CCCCC')).toBe(false);
    });

    test('rejects too-long third segment', () => {
      expect(OWN_ID_PATTERN.test('AAAAA.BBBBB.CCCCCD')).toBe(false);
    });

    test('rejects wrong separator (space)', () => {
      expect(OWN_ID_PATTERN.test('AAAAA BBBBB CCCCC')).toBe(false);
    });

    test('rejects wrong separator (dash)', () => {
      expect(OWN_ID_PATTERN.test('AAAAA-BBBBB-CCCCC')).toBe(false);
    });

    test('rejects missing third segment', () => {
      expect(OWN_ID_PATTERN.test('AAAAA.BBBBB')).toBe(false);
    });

    test('rejects extra segment', () => {
      expect(OWN_ID_PATTERN.test('AAAAA.BBBBB.CCCCC.DDDDD')).toBe(false);
    });

    test('rejects empty string', () => {
      expect(OWN_ID_PATTERN.test('')).toBe(false);
    });

    test('rejects single char', () => {
      expect(OWN_ID_PATTERN.test('A')).toBe(false);
    });

    test('rejects O character (confusable with 0)', () => {
      // Pattern excludes O intentionally
      expect(OWN_ID_PATTERN.test('OOOOO.BBBBB.CCCCC')).toBe(false);
    });

    test('rejects I character (confusable with 1)', () => {
      // Pattern excludes I intentionally
      expect(OWN_ID_PATTERN.test('IIIII.BBBBB.CCCCC')).toBe(false);
    });

    test('rejects 0 character', () => {
      expect(OWN_ID_PATTERN.test('00000.BBBBB.CCCCC')).toBe(false);
    });

    test('rejects 1 character', () => {
      expect(OWN_ID_PATTERN.test('11111.BBBBB.CCCCC')).toBe(false);
    });
  });

  describe('validateOwnId function', () => {
    test('returns true for valid OwnID', () => {
      expect(validateOwnId('AAAAA.BBBBB.CCCCC')).toBe(true);
    });

    test('trims whitespace before validation', () => {
      expect(validateOwnId('  AAAAA.BBBBB.CCCCC  ')).toBe(true);
    });

    test('returns false for invalid OwnID', () => {
      expect(validateOwnId('AAAA.BBB.CCC')).toBe(false);
    });

    test('returns false for empty string', () => {
      expect(validateOwnId('')).toBe(false);
    });

    test('returns false for lowercase input (uppercase only)', () => {
      expect(validateOwnId('aaaaa.bbbbb.ccccc')).toBe(false);
    });
  });
});

// ==================== NostraAddPeerDialog Tests ====================

describe('NostraAddPeerDialog', () => {
  let mockOnConnect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOnConnect = vi.fn();
    // Ensure clean DOM state for each test
    const existing = (window as any).__nostraAddPeerDialog as NostraAddPeerDialog | undefined;
    if(existing && !existing.isDestroyed()) {
      existing.destroy();
    }
    delete (window as any).__nostraAddPeerDialog;
  });

  afterEach(() => {
    // Clean up any open dialogs after each test
    const existing = (window as any).__nostraAddPeerDialog as NostraAddPeerDialog | undefined;
    if(existing && !existing.isDestroyed()) {
      existing.destroy();
    }
    delete (window as any).__nostraAddPeerDialog;
  });

  describe('create factory', () => {
    test('creates a dialog instance without showing it', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);

      expect(dialog).toBeInstanceOf(NostraAddPeerDialog);
      expect(dialog.isDestroyed()).toBe(false);

      // Overlay should not be visible yet (display: none)
      const overlay = document.body.querySelector('.nostra-dialog-overlay') as HTMLElement | null;
      expect(overlay).toBeTruthy();
      expect(overlay!.style.display).toBe('none');

      dialog.destroy();
    });

    test('appends overlay to document.body', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      const overlay = document.body.querySelector('.nostra-dialog-overlay');
      expect(overlay).toBeTruthy();
      dialog.destroy();
    });

    test('creates dialog container inside overlay', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      const overlay = document.body.querySelector('.nostra-dialog-overlay');
      const container = overlay!.querySelector('.nostra-dialog');
      expect(container).toBeTruthy();
      dialog.destroy();
    });

    test('multiple create calls create separate overlays', () => {
      const dialog1 = NostraAddPeerDialog.create(mockOnConnect);
      const dialog2 = NostraAddPeerDialog.create(mockOnConnect);

      const overlays = document.body.querySelectorAll('.nostra-dialog-overlay');
      expect(overlays.length).toBe(2);

      dialog1.destroy();
      dialog2.destroy();
    });
  });

  describe('show/hide lifecycle', () => {
    test('show() makes overlay visible', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.show();

      const overlay = document.body.querySelector('.nostra-dialog-overlay') as HTMLElement;
      expect(overlay!.style.display).toBe('flex');

      dialog.destroy();
    });

    test('show() renders dialog content', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.show();

      // Check that key elements are rendered
      expect(document.querySelector('#nostra-ownid-input')).toBeTruthy();
      expect(document.querySelector('#nostra-dialog-cancel')).toBeTruthy();
      expect(document.querySelector('#nostra-dialog-connect')).toBeTruthy();

      dialog.destroy();
    });

    test('show() renders dialog heading', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.show();

      const heading = document.querySelector('.nostra-dialog-header h2');
      expect(heading!.textContent).toBe('Connect with a Peer');

      dialog.destroy();
    });

    test('hide() hides the overlay', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.show();
      dialog.hide();

      const overlay = document.body.querySelector('.nostra-dialog-overlay') as HTMLElement;
      expect(overlay!.style.display).toBe('none');

      dialog.destroy();
    });

    test('hide() clears the input value', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.show();
      // Type into the input first
      const input = document.querySelector('#nostra-ownid-input') as HTMLInputElement;
      input.value = 'TEST';
      dialog.hide();

      // After hide, input should be cleared
      const inputAfter = document.querySelector('#nostra-ownid-input') as HTMLInputElement;
      expect(inputAfter!.value).toBe('');

      dialog.destroy();
    });

    test('show() is idempotent (no re-render on second call)', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.show();
      dialog.show(); // Second show

      // Should still have only one input element
      const inputs = document.querySelectorAll('#nostra-ownid-input');
      expect(inputs.length).toBe(1);

      dialog.destroy();
    });

    test('show() after hide() shows the dialog again', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.show();
      dialog.hide();
      dialog.show();

      const overlay = document.body.querySelector('.nostra-dialog-overlay') as HTMLElement;
      expect(overlay!.style.display).toBe('flex');

      dialog.destroy();
    });
  });

  describe('destroy lifecycle', () => {
    test('destroy() removes overlay from DOM', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.destroy();

      const overlay = document.body.querySelector('.nostra-dialog-overlay');
      expect(overlay).toBeNull();
    });

    test('destroy() marks dialog as destroyed', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      expect(dialog.isDestroyed()).toBe(false);
      dialog.destroy();
      expect(dialog.isDestroyed()).toBe(true);
    });

    test('show() after destroy() is a no-op', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.destroy();

      // Should not throw
      expect(() => dialog.show()).not.toThrow();
    });

    test('hide() after destroy() is a no-op', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.destroy();

      // Should not throw
      expect(() => dialog.hide()).not.toThrow();
    });

    test('double destroy is safe', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.destroy();
      expect(() => dialog.destroy()).not.toThrow();
    });
  });

  describe('Cancel button', () => {
    test('Cancel button hides the dialog', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.show();

      const cancelBtn = document.querySelector('#nostra-dialog-cancel') as HTMLButtonElement;
      cancelBtn.click();

      const overlay = document.body.querySelector('.nostra-dialog-overlay') as HTMLElement;
      expect(overlay!.style.display).toBe('none');

      dialog.destroy();
    });

    test('Cancel button does not call onConnect', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.show();

      const cancelBtn = document.querySelector('#nostra-dialog-cancel') as HTMLButtonElement;
      cancelBtn.click();

      expect(mockOnConnect).not.toHaveBeenCalled();

      dialog.destroy();
    });
  });

  describe('OwnID input field', () => {
    test('input field accepts text', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.show();

      const input = document.querySelector('#nostra-ownid-input') as HTMLInputElement;
      input.value = 'AAAAA.BBBBB.CCCCC';

      expect(input.value).toBe('AAAAA.BBBBB.CCCCC');

      dialog.destroy();
    });

    test('input has correct placeholder', () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.show();

      const input = document.querySelector('#nostra-ownid-input') as HTMLInputElement;
      expect(input!.placeholder).toBe('XXXXX.XXXXX.XXXXX');

      dialog.destroy();
    });
  });

  describe('Connect button validation', () => {
    test('Connect button with invalid OwnID shows error without calling onConnect', async () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.show();

      // Type an invalid OwnID (too short)
      const input = document.querySelector('#nostra-ownid-input') as HTMLInputElement;
      input.value = 'AAAA.BBB.CCC';

      // Click connect
      const connectBtn = document.querySelector('#nostra-dialog-connect') as HTMLButtonElement;
      connectBtn.click();

      // Wait for synchronous validation (no async needed for invalid input)
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should NOT have called onConnect
      expect(mockOnConnect).not.toHaveBeenCalled();

      // Error message should be visible
      const errorEl = document.querySelector('#nostra-ownid-error') as HTMLElement;
      expect(errorEl!.style.display).toBe('block');
      expect(errorEl!.textContent).toContain('Invalid format');

      dialog.destroy();
    });

    test('Connect button with empty input shows error', async () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.show();

      // Leave input empty
      const input = document.querySelector('#nostra-ownid-input') as HTMLInputElement;
      expect(input!.value).toBe('');

      // Click connect
      const connectBtn = document.querySelector('#nostra-dialog-connect') as HTMLButtonElement;
      connectBtn.click();

      await new Promise(resolve => setTimeout(resolve, 10));

      // Should NOT have called onConnect
      expect(mockOnConnect).not.toHaveBeenCalled();

      // Error message should be visible
      const errorEl = document.querySelector('#nostra-ownid-error') as HTMLElement;
      expect(errorEl!.style.display).toBe('block');

      dialog.destroy();
    });
  });

  describe('Escape key closes dialog', () => {
    test('Escape key hides the dialog', async () => {
      const dialog = NostraAddPeerDialog.create(mockOnConnect);
      dialog.show();

      // Press Escape
      document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));

      await new Promise(resolve => setTimeout(resolve, 10));

      const overlay = document.body.querySelector('.nostra-dialog-overlay') as HTMLElement;
      expect(overlay!.style.display).toBe('none');

      dialog.destroy();
    });
  });
});
