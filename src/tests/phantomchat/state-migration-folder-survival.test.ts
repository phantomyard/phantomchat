/**
 * Regression: the boot-time STATE migration must NOT wipe local-only state
 * (custom folders / filtersArr) on every restart.
 *
 * Root cause it guards (confirmed live, Carbon, 1.0.131):
 *   - vite.config.ts never defined `VITE_BUILD`, so `App.build = +undefined = NaN`.
 *     The migration gate `state.build !== BUILD` is therefore ALWAYS true
 *     (nothing equals NaN) → the migration block runs on EVERY boot.
 *   - Inside it, the upstream Telegram-tweb branch `if(state.build < 526)
 *     writer.reset()` then nukes all state. PhantomChat builds are 1.0.<run_number>
 *     (low hundreds, and stored NaN serialises back to null → `null < 526` is
 *     true), so reset() fired every boot. Chats survive (separate storage,
 *     re-synced from Nostr); filtersArr is local-only → gone forever.
 *
 * The fix: (1) define VITE_BUILD as a finite integer, and (2) remove the
 * tweb-legacy `<526`/`<562` migration branches that never applied to this fork.
 * This test drives the REAL migration step so removing either fix fails it.
 */
import 'fake-indexeddb/auto';
import {describe, it, expect} from 'vitest';
import App from '@config/app';
import {STATE_INIT} from '@config/state';
import {STATE_STEPS, StateWriter} from '@appManagers/utils/state/loadState';

function makeWriter(overrides: Partial<typeof STATE_INIT>) {
  const w = StateWriter((() => {}) as any);
  w.state = {
    ...JSON.parse(JSON.stringify(STATE_INIT)),
    authState: {_: 'authStateSignedIn'},
    ...overrides
  } as any;
  return w;
}

function customFolders() {
  return [
    {id: 0, title: 'All'},
    {id: 3, title: 'Groups'},
    {id: 1, title: 'Archive'},
    {id: 4, title: 'Work', includePeerIds: [101, 102]},
    {id: 5, title: 'Family', includePeerIds: [103]}
  ] as any;
}

describe('state migration — custom folder survival across restart', () => {
  it('App.build is a finite integer (VITE_BUILD must be defined)', () => {
    // If VITE_BUILD is undefined, App.build is NaN and the migration gate
    // `state.build !== BUILD` is permanently true → migration runs every boot.
    expect(Number.isFinite(App.build)).toBe(true);
  });

  it('does NOT wipe filtersArr when a low PhantomChat build triggers migration', () => {
    // build 100 is a realistic 1.0.<run_number> value, below the old 526/562
    // thresholds. The migration block enters (build !== BUILD) but must leave
    // the user's folders intact.
    const w = makeWriter({build: 100 as any, version: '1.0.100', filtersArr: customFolders()});

    STATE_STEPS.VERSION(w);

    const ids = w.state.filtersArr.map((f: any) => f.id);
    expect(ids).toContain(4);
    expect(ids).toContain(5);
  });

  it('does NOT wipe filtersArr when stored build is null (NaN serialised)', () => {
    // A NaN build (the old VITE_BUILD-undefined bug) round-trips through storage
    // as null; `null < 526` is true, which used to call writer.reset().
    const w = makeWriter({build: null as any, version: '1.0.0', filtersArr: customFolders()});

    STATE_STEPS.VERSION(w);

    const ids = w.state.filtersArr.map((f: any) => f.id);
    expect(ids).toContain(4);
    expect(ids).toContain(5);
  });
});
