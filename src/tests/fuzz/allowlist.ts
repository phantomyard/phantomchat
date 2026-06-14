/**
 * Known-benign console messages. Anything matching these patterns is filtered
 * out before INV-console-clean evaluates.
 *
 * Additions to this list are a policy decision — each new entry should cite
 * why the noise is benign (dev-only, informational, transient).
 *
 * Keep patterns narrow: prefer matching the specific logger prefix + a
 * substring, rather than broad wildcards. Overly-broad entries silence real
 * bugs.
 */

export const CONSOLE_ALLOWLIST: readonly RegExp[] = [
  // Vite dev server (not our code)
  /\[vite\]/i,
  /\[HMR\]/i,

  // Chromium internal warnings
  /DevTools/,

  // ServiceWorker installation logs — safe and one-shot
  /ServiceWorker registration successful/,
  /SW installed, waiting/i,

  // PhantomChat.chat informational loggers — NOT errors, they log in info/log channel
  /\[PhantomChatSync\] buffer size \d+/,
  /\[PhantomChatOnboarding\] kind 0 publish/,
  /\[ChatAPI\] subscription active/,
  /\[NostrRelay\] connected to/,

  // Playwright emits console.log of Playwright events when headed
  /pw:/,

  // Chromium headless: Push API unavailable because notification permission is
  // denied by default in headless mode. Benign in fuzz context; the real app
  // path handles permission-denied gracefully.
  /\[PUSH-API\] the user has blocked notifications/,

  // PhantomChat's internal logger prints informational messages at console.warn
  // level with the shape:
  //   [warning] <any color/format-placeholders> [<elapsed>] [<MODULE-TAG>] …
  // Treating ALL warnings as errors was too aggressive — modules like
  // [MP-MTPROTO], [MP-CRYPTO], [ChatAPI], [PhantomChatSync], [IDB-tweb-common]
  // routinely log state transitions via warn. Playwright surfaces the raw
  // warn format including printf placeholders (`%s`, `%c`) and ANSI colour
  // tokens (`\x1b[36m` → `[36m`), so we cannot match the prefix literally —
  // we anchor on the distinctive `[<N>] [<TAG>] …` shape further in. Real
  // warnings from browser APIs lack this structural pair, and real errors
  // fire as console.error / pageerror which we keep flagging.
  /^\[warning\] .*\[\d+(?:\.\d+)?\] \[[A-Za-z][A-Za-z0-9-]+\]/,

  // SolidJS dev-only developer warnings for resources created outside a
  // reactive root ("computations", "cleanups", "effects", etc). Emitted only
  // by the dev build (`pnpm start`) — production builds have these warnings
  // stripped. For the fuzzer's --backend=local mode (dev-server only) this
  // is unavoidable noise; the production path is checked separately in
  // --backend=real runs (Phase 3).
  /\w+ created outside a `createRoot` or `render`/,

  // tweb's PEER_CHANGED_ERROR is thrown by design to cancel in-flight
  // promises when the user switches chats (see bubbles.ts:281,
  // `const PEER_CHANGED_ERROR = new Error('peer changed')`). Most callers
  // convert it via `middlewarePromise` or a silent `.catch(noop)`, but
  // Playwright still surfaces it as `[pageerror] peer changed` in a few
  // unhandled-rejection paths. It's cancellation signal, not a regression.
  /^\[pageerror\] peer changed(?:\n|$)/,

  // Chromium resource-preload diagnostic: when the Vite dev server preloads
  // a WASM/asset module via <link rel="preload"> but the user's action path
  // doesn't hit it, Chromium emits a "preloaded but not used" warning. It is
  // a diagnostic about resource hints, not a runtime bug.
  /preloaded using link preload but not used within a few seconds/,

  // Dev-mode ServiceWorker registration fails because Vite's dev server
  // serves sw.ts as a module worker, but Playwright's headless Chromium
  // cannot start module-type SW scripts. This is a Vite/Playwright dev
  // limitation, not a production bug. Production builds serve a compiled
  // sw.js that registers fine.
  /SW registration failed.*ServiceWorker cannot be started/,
  /Failed to register a ServiceWorker.*ServiceWorker cannot be started/,

  // `appMessagesManager.noIdsDialogs` is a pre-existing diagnostic that fires
  // via `this.log.error(...)` → `console.error(...)` when a P2P dialog
  // object arrives without a top-message ID during `saveApiDialogs`. This is
  // a known limitation of the Virtual MTProto bridge (the bridge returns
  // dialogs with synthetic topMessage objects, but the getDialogs pager
  // occasionally receives a dialog before the message index is warm). It is
  // not a regression introduced by any Phase 2b change; it predates the
  // fuzzer and fires within the first few seconds of boot during P2P contact
  // exchange. Allowlisted so it doesn't mask the actual FIND under test.
  /\[ACC-\d+-MESSAGES\] noIdsDialogs\b/
];

/**
 * Returns true if the message is in the allowlist (i.e. should be ignored).
 */
export function isAllowlisted(message: string): boolean {
  return CONSOLE_ALLOWLIST.some((re) => re.test(message));
}
