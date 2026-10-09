/**
 * Network liveness gate shared by the relay pool and the per-relay retry loops.
 *
 * Why this exists: a hard network outage (radio off, WiFi gone) used to leave
 * every relay retrying on its fast schedule. Observed in the field: 300+ dials
 * per minute during a 33-minute outage: each one a guaranteed-fail WebSocket
 * handshake that also flooded the error log and churned main-thread retry
 * timers. `navigator.onLine === false` is a strong NEGATIVE signal (a dial
 * cannot succeed while it holds), so retry paths gate on it and park on a slow
 * probe instead. `onLine === true` proves nothing about reachability, so it is
 * never trusted to mean "reachable": it only lifts the gate and lets the
 * normal retry schedule resume.
 */

/**
 * Slow probe cadence while the device is known-offline. One pending probe per
 * retry loop stands in for the entire outage.
 */
export const OFFLINE_RETRY_PROBE_MS = 30_000;

export function isNetworkOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}
