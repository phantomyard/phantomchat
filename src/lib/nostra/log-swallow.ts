/*
 * Nostra.chat — non-fatal error logging helper
 *
 * Centralizes the pattern previously written inline as `catch{}` /
 * `.catch(() => {})`. Preserves fire-and-forget semantics (the caller
 * still doesn't wait on the result) but routes the error through the
 * standard logger at debug level so failures are observable when
 * DEBUG is on and silent in production builds.
 *
 * Usage:
 *   try { await x.close(); } catch(e) { logSwallow('RelayClose', e); }
 *   x.publish(event).catch(swallowHandler('MeshForwardPublish'));
 */

import {logger} from '@lib/logger';

const log = logger('Nostra/swallow');

export function logSwallow(context: string, err: unknown): void {
  log.debug('[' + context + '] non-fatal', err);
}

export function swallowHandler(context: string): (err: unknown) => void {
  return (err: unknown) => logSwallow(context, err);
}
