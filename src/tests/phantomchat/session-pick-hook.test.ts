/**
 * #292 review (Kai at b21b342): Sessions' `+` lost its pick hook.
 *
 * `open()` forwards its own args to `init` (`sliderTab.ts`), and the session
 * flow calls `open()` with none — so `init` patched `this.onPickPeer =
 * params?.onPickPeer` unconditionally and nulled the hook `setPickPeerHook()`
 * had installed one line earlier. First `+` press opened a DM. The inverse
 * leak (pick mode surviving into a normal Contacts visit) came from the same
 * assign.
 *
 * The decision is exercised directly — it is the real code path `init` runs —
 * rather than through a DOM-mocked tab, which would pin the mock instead.
 */

import '../setup';
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'fs';
import {resolve} from 'path';
import {resolvePickPeerHook} from '@lib/phantomchat/session-pick-hook';

const hook = (tag: string) => (() => tag) as any;

describe('#292: Contacts pick hook survives init()', () => {
  it('KEEPS the hook when open() calls init() with no params (the `+` path)', () => {
    const installed = hook('session');
    expect(resolvePickPeerHook(installed, undefined)).toBe(installed);
  });

  it('takes a hook supplied through init params', () => {
    const supplied = hook('session');
    expect(resolvePickPeerHook(undefined, {onPickPeer: supplied})).toBe(supplied);
  });

  it('clears when params are passed without a hook (pick mode never leaks into a plain Contacts visit)', () => {
    expect(resolvePickPeerHook(hook('stale'), {onPickPeer: undefined})).toBe(undefined);
  });

  it('init() assigns through the helper, not `params?.onPickPeer` directly', () => {
    // resolvePickPeerHook is only as good as its call site.
    const src = readFileSync(
      resolve(__dirname, '../../components/sidebarLeft/tabs/contacts.ts'),
      'utf8'
    );
    expect(src).toContain('this.onPickPeer = resolvePickPeerHook(this.onPickPeer, params)');
    expect(src).not.toContain('this.onPickPeer = params?.onPickPeer');
  });
});
