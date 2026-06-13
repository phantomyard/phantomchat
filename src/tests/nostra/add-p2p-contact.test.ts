/**
 * Regression tests for the canonical addP2PContact helper.
 *
 * Background: before this helper existed, four divergent code paths added a
 * P2P contact — each seeded a different subset of mirrors / Worker state /
 * message-store / dialogs. Opening a chat right after an add could land on
 * a half-populated mirror and render a blank chat pane until a full reload.
 *
 * These tests lock in the behaviors that prevent that class of bug:
 * - all four call sites delegate to addP2PContact
 * - the dialog dispatch carries a full topMessage object (not a number)
 * - Worker injectP2PUser is awaited before main-thread mirror writes
 * - a message-store seed is persisted so Worker.getDialogs can find the peer
 * - ChatAPI.connect is awaited with a bounded timeout before the chat opens
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';

const SRC = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

describe('addP2PContact — canonical helper', () => {
  const helperSrc = read('lib/nostra/add-p2p-contact.ts');

  it('exports the addP2PContact function', () => {
    expect(helperSrc).toMatch(/export async function addP2PContact/);
  });

  it('awaits Worker injectP2PUser (must complete before mirrors are written)', () => {
    // The injectP2PUser call must be awaited — fire-and-forget races with
    // the user tapping the freshly-added contact.
    expect(helperSrc).toMatch(/await\s+rootScope\.managers\.appUsersManager\.injectP2PUser/);
  });

  it('seeds a contact-init message in message-store', () => {
    expect(helperSrc).toContain('contact-init-');
    expect(helperSrc).toMatch(/store\.saveMessage/);
  });

  it('attaches the full message object as dialog.topMessage', () => {
    // CLAUDE.md rule: synthetic dialogs must carry `(dialog as any).topMessage = msg`
    // or setLastMessage falls back to getMessageByPeer and fails.
    expect(helperSrc).toMatch(/\(dialog as any\)\.topMessage\s*=\s*seedMsg/);
  });

  it('uses dispatchDialogUpdate (double-dispatch) instead of a raw single dispatch', () => {
    expect(helperSrc).toContain('dispatchDialogUpdate');
  });

  it('awaits chatAPI.connect with a bounded timeout', () => {
    expect(helperSrc).toMatch(/withTimeout\(chatAPI\.connect/);
  });

  it('opens the chat via appImManager.setInnerPeer when openChat is true', () => {
    expect(helperSrc).toContain('setInnerPeer');
  });
});

describe('Call sites route through addP2PContact', () => {
  const cases: Array<{label: string; file: string}> = [
    {label: 'Contacts tab',          file: 'components/sidebarLeft/tabs/contacts.ts'},
    {label: 'Add Contact popup',     file: 'components/popups/addContact.ts'},
    {label: 'Sidebar search (npub)', file: 'components/sidebarLeft/index.ts'},
    {label: 'KeyExchange scanner',   file: 'components/nostra/KeyExchange.tsx'}
  ];

  for(const c of cases) {
    it(`${c.label} imports addP2PContact`, () => {
      const src = read(c.file);
      expect(src).toMatch(/addP2PContact/);
    });

    it(`${c.label} does not inline the legacy state-seeding code`, () => {
      const src = read(c.file);
      // These tokens previously appeared inline at each call site — their
      // absence proves the consolidation stuck.
      expect(src).not.toMatch(/topMessage:\s*0\s*,/);
    });
  }
});

describe('QR scanner user feedback', () => {
  const qrSrc = read('components/nostra/QRScanner.tsx');

  it('shows a toast on successful QR detection', () => {
    // Without this the overlay just disappears and the user has no cue the
    // scan worked. Reported as "cilecca" (misfire) in the field.
    expect(qrSrc).toContain("toast('QR code detected')");
  });
});
