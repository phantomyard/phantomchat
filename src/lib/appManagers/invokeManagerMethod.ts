/*
 * #16: guarded dispatch for the MTProto "manager" message port. The worker
 * indexes a manager by a string method name (`manager[method](...args)`); a
 * bad/renamed method previously surfaced as an opaque `TypeError: manager[
 * method] is not a function` with no hint of WHICH manager/method. This helper
 * checks first and throws a descriptive, identifiable error instead.
 */
export function invokeManagerMethod(manager: any, name: string, method: string, args: any[]): any {
  const fn = manager?.[method];
  if(typeof fn !== 'function') {
    throw new Error(`appManagersManager: ${String(name)}.${String(method)} is not a function`);
  }
  return fn.apply(manager, args);
}
