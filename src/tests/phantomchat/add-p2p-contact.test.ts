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
  const helperSrc = read('lib/phantomchat/add-p2p-contact.ts');

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

  it('#180/#186: the deliberate stamp rides the mapping write itself', () => {
    // The stamp is the cross-device proof that may clear a durable delete —
    // it must be gated on opts.deliberate, never minted unconditionally. And
    // it must be written ATOMICALLY with the mapping (#186): a stamp written
    // only after the guards were cleared can be lost to an IndexedDB failure,
    // leaving a live unstamped mapping whose delete fact is already gone.
    expect(helperSrc).toMatch(/opts\.deliberate \? Date\.now\(\) : undefined/);
    expect(helperSrc).toMatch(/deliberateAddAt: stampNow/);
    // No post-hoc stamp write left to lose.
    expect(helperSrc).not.toMatch(/setDeliberateAddAt/);
  });

  it('#186: DELIBERATE path — stamped mapping written BEFORE the guards are cleared', () => {
    // Order is load-bearing: the FIRST bridge.storePeerMapping (the
    // deliberate, stamped branch) must appear before the first clearDeletedPeer
    // block, so a failed stamp write aborts the add with the local delete fact
    // still intact.
    const storeIdx = helperSrc.indexOf('bridge.storePeerMapping');
    const clearIdx = helperSrc.indexOf('clearDeletedPeer');
    expect(storeIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(storeIdx);
  });

  it('#189: NON-DELIBERATE path — guards cleared BEFORE the store (tombstone guard must not suppress the sync re-add)', () => {
    // The contacts-sync caller passes no stamp; storing before the tombstone
    // is cleared runs into guard (b) and silently drops the re-add. The sync
    // branch's storePeerMapping must therefore run AFTER its clearDeletedPeer
    // (the else-branch clear), i.e. inside/after the `stampNow === undefined`
    // store block which follows both clears.
    const syncBranchIdx = helperSrc.indexOf('if(stampNow === undefined)');
    expect(syncBranchIdx).toBeGreaterThan(-1);
    const syncStoreIdx = helperSrc.indexOf('bridge.storePeerMapping', syncBranchIdx);
    expect(syncStoreIdx).toBeGreaterThan(syncBranchIdx);
    const secondClearIdx = helperSrc.indexOf('clearDeletedPeer', helperSrc.indexOf('clearDeletedPeer') + 1);
    expect(secondClearIdx).toBeGreaterThan(-1);
    expect(syncStoreIdx).toBeGreaterThan(secondClearIdx);
  });

  it('#180: a deliberate gesture always schedules a contacts publish (stamp is sync content)', () => {
    expect(helperSrc).toMatch(/\(isNew \|\| opts\.deliberate\)/);
  });
});

describe('Call sites route through addP2PContact', () => {
  const cases: Array<{label: string; file: string}> = [
    {label: 'Contacts tab',          file: 'components/sidebarLeft/tabs/contacts.ts'},
    {label: 'Add Contact popup',     file: 'components/popups/addContact.ts'},
    {label: 'Sidebar search (npub)', file: 'components/sidebarLeft/index.ts'},
    {label: 'KeyExchange scanner',   file: 'components/phantomchat/KeyExchange.tsx'}
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

    it(`#180 ${c.label} passes the deliberate flag (user gesture stamps the proof)`, () => {
      const src = read(c.file);
      expect(src).toMatch(/deliberate:\s*true/);
    });
  }

  it('#180: the sync restore path does NOT pass the deliberate flag', () => {
    // onboarding-integration wires addContact to addP2PContact for contacts-sync
    // restores — a remote deliberate re-add carries its own stamp, which
    // apply() persists; the restore call itself must stay unstamped or every
    // merged contact would be minted as "user-intended" here.
    const src = read('pages/phantomchat-onboarding-integration.ts');
    const syncCall = src.match(/addP2PContact\(\{[^}]*contacts-sync[^}]*\}\)/);
    expect(syncCall).toBeTruthy();
    expect(syncCall![0]).not.toMatch(/deliberate:\s*true/);
  });
});

describe('QR scanner user feedback', () => {
  const qrSrc = read('components/phantomchat/QRScanner.tsx');

  it('shows a toast on successful QR detection', () => {
    // Without this the overlay just disappears and the user has no cue the
    // scan worked. Reported as "cilecca" (misfire) in the field.
    expect(qrSrc).toContain("toast('QR code detected')");
  });
});
