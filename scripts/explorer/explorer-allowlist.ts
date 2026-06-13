/**
 * Canonical explorer-only console allowlist. Patterns here are committed
 * and apply to every explorer run.
 *
 * Companion file `docs/explorer-reports/allowlist.ts` is gitignored and
 * provides a per-developer extension slot for throwaway/in-progress
 * patterns. Both lists are merged in `oracles/hard.ts`.
 *
 * Each entry must document WHY the noise is benign and which FIND ID
 * surfaced it, so future maintainers can reassess if the underlying
 * scenario changes.
 */

export const EXPLORER_STABLE_CONSOLE_ALLOWLIST: readonly RegExp[] = [
  // FIND-bb9ecb86 — Chromium's network stack emits this whenever a fetch or
  // WebSocket attempt fires while context.setOffline(true) is active. The
  // explorer's `network` cold-zone deliberately toggles offline; this is a
  // mechanical side-effect, not a product bug.
  /Failed to load resource: net::ERR_INTERNET_DISCONNECTED/,
  /WebSocket connection to .* failed.*net::ERR_INTERNET_DISCONNECTED/,

  // FIND-2e8cec33 — the harness Blossom upload mock (src/tests/fuzz/harness.ts)
  // returns a synthetic `https://blossom.fuzz/<sha>.png` URL that DNS cannot
  // resolve. The avatar/render code path then tries to fetch it and Chromium
  // emits ERR_NAME_NOT_RESOLVED. Real production origins serve a reachable
  // URL; fuzz noise only.
  /blossom\.fuzz/,
  /Failed to load resource: net::ERR_NAME_NOT_RESOLVED.*blossom/
];
