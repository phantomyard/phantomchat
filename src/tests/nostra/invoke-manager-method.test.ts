/**
 * #16 — appManagersManager guarded dispatch.
 *
 * The worker dispatches manager calls by string method name. A missing/renamed
 * method used to throw an opaque `manager[method] is not a function`. This
 * helper throws a descriptive error naming the manager + method instead.
 */
import {describe, it, expect} from 'vitest';
import {invokeManagerMethod} from '@lib/appManagers/invokeManagerMethod';

describe('invokeManagerMethod (#16)', () => {
  it('calls the method and returns its result', () => {
    const mgr = {add: (a: number, b: number) => a + b};
    expect(invokeManagerMethod(mgr, 'appX', 'add', [2, 3])).toBe(5);
  });

  it('preserves the manager as `this`', () => {
    const mgr = {n: 7, getN() { return (this as any).n; }};
    expect(invokeManagerMethod(mgr, 'appX', 'getN', [])).toBe(7);
  });

  it('throws a descriptive error naming manager + method when the method is missing', () => {
    expect(() => invokeManagerMethod({}, 'appUsersManager', 'doesNotExist', []))
      .toThrow(/appUsersManager\.doesNotExist is not a function/);
  });

  it('throws a descriptive error when the manager itself is missing', () => {
    expect(() => invokeManagerMethod(undefined, 'appChatsManager', 'getChat', []))
      .toThrow(/appChatsManager\.getChat is not a function/);
  });
});
