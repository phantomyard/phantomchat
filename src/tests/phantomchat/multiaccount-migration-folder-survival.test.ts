/**
 * Regression: the boot-time single→multi-account migration must NOT re-run on
 * every restart in this P2P fork, because that path reloads account 1 from the
 * old/empty `tweb` database and overwrites tweb-account-1, wiping local-only
 * state (custom folders / filtersArr).
 *
 * Root cause it guards (confirmed live, create→close→reopen):
 *   checkIfHasMultiAccount() returned
 *     !!(AccountController.get(1))[`dc${baseDcId}_auth_key`]
 *   i.e. it gated the migration on a Telegram MTProto DC auth key. PhantomChat
 *   is P2P and NEVER creates DC auth keys, so this was ALWAYS false → the
 *   destructive legacy migration (loadOldState + moveStoragesToMultiAccount
 *   Format + deleteOldDatabase) ran on EVERY boot and clobbered account 1's
 *   folders.
 *
 * The fix: treat account 1 as already established in the new-format storage once
 * its `stateCreatedTime` has been persisted (so the migration runs at most once,
 * on a genuinely fresh profile). Removing that branch makes the second test fail.
 */
import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach} from 'vitest';
import App from '@config/app';
import sessionStorage from '@lib/sessionStorage';
import StateStorage from '@lib/stateStorage';
import {checkIfHasMultiAccount} from '@appManagers/utils/state/loadState';

const DC_KEY = `dc${App.baseDcId}_auth_key`;

async function pollUntil<T>(fn: () => Promise<T>, timeout = 2000): Promise<T> {
  const start = Date.now();
  let v = await fn();
  while((v === undefined || v === null) && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 10));
    v = await fn();
  }
  return v;
}

describe('checkIfHasMultiAccount — P2P must not re-run the destructive old-DB migration', () => {
  beforeEach(async() => {
    indexedDB.deleteDatabase('tweb-account-1');
    indexedDB.deleteDatabase('tweb-account-1_test');
    await sessionStorage.delete('account1' as any).catch(() => {});
  });

  it('returns false on a genuinely fresh profile (legacy migration runs once)', async() => {
    await sessionStorage.set({account1: {}} as any);
    expect(await checkIfHasMultiAccount()).toBe(false);
  });

  it('returns true once account 1 is established (stateCreatedTime present), even with no DC auth key', async() => {
    await sessionStorage.set({account1: {}} as any);

    const ss = new StateStorage(1);
    await ss.set({stateCreatedTime: Date.now()} as any);
    // AppStorage flushes to IDB fire-and-forget; ensure it has landed.
    await pollUntil(() => new StateStorage(1).get('stateCreatedTime'));

    expect(await checkIfHasMultiAccount()).toBe(true);
  });

  it('returns true when account 1 carries a legacy Telegram DC auth key', async() => {
    await sessionStorage.set({account1: {[DC_KEY]: 'deadbeefdeadbeef'}} as any);
    expect(await checkIfHasMultiAccount()).toBe(true);
  });
});
