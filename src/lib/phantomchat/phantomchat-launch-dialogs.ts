/**
 * Launch-time chat-list hygiene and chat-open relay catch-up.
 *
 * 1. refreshDialogPreviews — once after launch, reload every cached dialog from
 *    the local store via tweb's own `reloadConversation` (→ messages.getPeerDialogs
 *    → applyDialogs). Once tweb has marked the dialog list fully loaded it boots
 *    from its persisted copy and never calls getDialogs again, so any top message
 *    missing from worker storage left that chat-list preview blank until the
 *    chat was opened.
 *
 * 2. openTopChatOnDesktop — on desktop only, open the first chat in the list so
 *    the user doesn't land on an empty message pane. Never on mobile (it would
 *    hide the chat list), never over a deep link, never over a chat the user
 *    already opened.
 *
 * 3. installChatOpenCatchUp — when a 1:1 chat is opened, ask the relays for
 *    anything missed in it (ChatAPI.catchUpConversation, throttled to once a
 *    minute per chat).
 *
 * Everything here is fire-and-forget background work except the returned
 * `previewsReady` promise (#217): the cold-start ready gate waits on it so the
 * chat list paints with real summaries instead of the empty-then-populate
 * flash. Failures are swallowed to a debug line either way.
 *
 * On a COLD profile the one boot-time refresh is not enough (#234-class bug):
 * the local message store is still empty when it runs, so every preview
 * renders blank, and the #159 background backfill fills the store only
 * afterwards — largely during the receive gate, whose deliveries are stored
 * but deliberately not projected (see the receive-boot note in the onboarding
 * integration). Nothing re-ran the refresh, so previews stayed blank until a
 * new live message landed in each chat. `wirePreviewRefreshReruns` closes
 * that gap: the refresh re-runs when the cold drain delivers rows (the pool's
 * per-page 'phantomchat_backfill_progress' event — a deep drain resumes
 * across 15s catch-up ticks, which the pass-level backfill-complete event
 * never covers) plus a couple of bounded-timer backstops, so the sidebar
 * converges without waiting for user activity.
 */

import type {ChatCatchUpOutcome} from './chat-api';

const LOG_PREFIX = '[PhantomChatLaunchDialogs]';

/** How long openTopChatOnDesktop waits for a first-ever dialog list to load. */
export const TOP_CHAT_WAIT_ATTEMPTS = 10;
export const TOP_CHAT_WAIT_INTERVAL_MS = 500;

/**
 * Post-install re-runs of the preview refresh — a BACKSTOP only. The real
 * convergence signal is the pool's per-page 'phantomchat_backfill_progress'
 * event (fired every time a cold-drain tick delivers new rows), which keeps
 * re-running the refresh no matter how long a deep drain takes. These two
 * fixed timers cover a drain that has not delivered anything yet (slow relay
 * connects, long first page) so the schedule stays bounded.
 */
export const PREVIEW_RERUN_DELAYS_MS = [20_000, 60_000];

/**
 * Re-run the preview refresh when the backfill settles and on a bounded
 * post-install schedule. Runs are coalesced: a backfill burst plus the timed
 * re-runs must never stack concurrent refreshes — one runs at a time and a
 * request that arrives mid-run gets one trailing re-run, not one per event.
 */
export function wirePreviewRefreshReruns(opts: {
  run: () => Promise<number>;
  /** Subscribe to ChatAPI backfill completion ('phantomchat_backfill_complete'). */
  onBackfillComplete?: (fn: () => void) => void;
  /** Subscribe to pool cold-drain progress ('phantomchat_backfill_progress'). */
  onBackfillProgress?: (fn: () => void) => void;
  /** Injectable timer (defaults to setTimeout) so tests don't wait real time. */
  schedule?: (fn: () => void, ms: number) => void;
  delaysMs?: number[];
}): void {
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  let inFlight = false;
  let requested = false;
  const runOnce = () => {
    if(inFlight) {
      requested = true;
      return;
    }
    inFlight = true;
    Promise.resolve()
    .then(opts.run)
    .catch((err) => console.debug(LOG_PREFIX, 'preview re-run failed', (err as Error)?.message))
    .finally(() => {
      inFlight = false;
      if(requested) {
        requested = false;
        runOnce();
      }
    });
  };

  opts.onBackfillComplete?.(runOnce);
  opts.onBackfillProgress?.(runOnce);
  for(const ms of (opts.delaysMs ?? PREVIEW_RERUN_DELAYS_MS)) {
    schedule(runOnce, ms);
  }
}

export interface DialogRef {
  peerId: number;
}

export interface RefreshPreviewDeps {
  /** Cached dialogs of the main (All chats) folder, in list order. */
  getDialogs(): Promise<DialogRef[]>;
  reloadConversation(peerId: number): Promise<unknown>;
}

/**
 * Reload every cached dialog once. Returns how many were requested. All calls
 * are issued together so the worker batches them into one getPeerDialogs.
 */
export async function refreshDialogPreviews(deps: RefreshPreviewDeps): Promise<number> {
  let dialogs: DialogRef[];
  try {
    dialogs = await deps.getDialogs();
  } catch(err) {
    console.debug(LOG_PREFIX, 'preview refresh: dialog read failed', (err as Error)?.message);
    return 0;
  }

  const peerIds = [...new Set((dialogs || []).map((d) => d?.peerId).filter((p): p is number => typeof p === 'number' && p !== 0))];
  if(!peerIds.length) return 0;

  await Promise.all(peerIds.map((peerId) =>
    Promise.resolve()
    .then(() => deps.reloadConversation(peerId))
    .catch((err) => console.debug(LOG_PREFIX, 'preview refresh failed for', peerId, (err as Error)?.message))
  ));
  console.debug(LOG_PREFIX, 'preview refresh requested for', peerIds.length, 'dialog(s)');
  return peerIds.length;
}

export interface OpenTopChatDeps {
  getDialogs(): Promise<DialogRef[]>;
  isMobile(): boolean;
  /** Peer of the chat currently open, if any. */
  currentPeerId(): number | undefined;
  /** True when the app was launched with a link that opens a specific chat. */
  launchedWithDeepLink: boolean;
  openPeer(peerId: number): void;
  sleep?(ms: number): Promise<void>;
  attempts?: number;
  intervalMs?: number;
}

/**
 * Open the top dialog on desktop. Waits briefly for a first-ever dialog list to
 * arrive. Returns the opened peerId, or null when it (correctly) did nothing.
 */
export async function openTopChatOnDesktop(deps: OpenTopChatDeps): Promise<number | null> {
  if(deps.launchedWithDeepLink) return null;

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = deps.attempts ?? TOP_CHAT_WAIT_ATTEMPTS;
  const intervalMs = deps.intervalMs ?? TOP_CHAT_WAIT_INTERVAL_MS;

  for(let i = 0; i < attempts; i++) {
    // Re-checked every round: the user may resize to mobile or pick a chat
    // while we wait, and their choice always wins.
    if(deps.isMobile() || deps.currentPeerId()) return null;

    let dialogs: DialogRef[] = [];
    try {
      dialogs = await deps.getDialogs();
    } catch(err) {
      console.debug(LOG_PREFIX, 'top chat: dialog read failed', (err as Error)?.message);
    }
    const top = (dialogs || []).find((d) => typeof d?.peerId === 'number' && d.peerId !== 0);

    if(top) {
      if(deps.isMobile() || deps.currentPeerId()) return null;
      deps.openPeer(top.peerId);
      return top.peerId;
    }

    if(i < attempts - 1) await sleep(intervalMs);
  }
  return null;
}

export interface ChatOpenCatchUpDeps {
  resolvePubkey(peerId: number): Promise<string | null>;
  catchUp(pubkey: string): Promise<ChatCatchUpOutcome>;
}

/**
 * Handle one `peer_changed` payload. Groups and unknown peers are ignored.
 * Resolves to the catch-up outcome, or null when nothing was attempted.
 */
export async function onChatOpenedCatchUp(payload: unknown, deps: ChatOpenCatchUpDeps): Promise<ChatCatchUpOutcome | null> {
  const raw = typeof payload === 'number' ? payload : (payload as any)?.peerId;
  const peerId = Number(raw);
  // Group peers are negative; their wraps aren't addressed per chat either, and
  // the launch/reconnect backfill covers them.
  if(!Number.isFinite(peerId) || peerId <= 0) return null;

  try {
    const pubkey = await deps.resolvePubkey(peerId);
    if(!pubkey) return null;
    return await deps.catchUp(pubkey);
  } catch(err) {
    console.debug(LOG_PREFIX, 'chat-open catch-up failed', (err as Error)?.message);
    return null;
  }
}

/** True when the launch URL carries a non-trivial hash — a chat deep link
 *  (#@user, #<peerId>, tgaddr) but also any other routed view (#/settings,
 *  #/addstickers/…). Consumers only use it to mean "a deep link decides the
 *  initial view", so every hash launch counts. */
export function isChatDeepLink(hash: string | undefined | null): boolean {
  if(!hash) return false;
  const h = hash.trim();
  if(h === '' || h === '#' || h === '#/im' || h === '#/') return false;
  return true;
}

/**
 * Production wiring. Called once from the onboarding integration after the chat
 * page is mounted and ChatAPI exists.
 */
export function installLaunchDialogs(opts: {
  rootScope: any;
  appImManager: any;
  chatAPI: {catchUpConversation(pubkey: string): Promise<ChatCatchUpOutcome>};
  launchedWithDeepLink: boolean;
  isMobile(): boolean;
}): {previewsReady: Promise<number>} {
  const {rootScope, appImManager, chatAPI} = opts;
  const getDialogs = async(): Promise<DialogRef[]> => {
    const dialogs = await rootScope.managers.dialogsStorage.getFolderDialogs(0);
    return (dialogs || []) as DialogRef[];
  };

  if(appImManager?.addEventListener) {
    appImManager.addEventListener('peer_changed', (payload: unknown) => {
      void onChatOpenedCatchUp(payload, {
        resolvePubkey: async(peerId) => {
          const {getPubkey} = await import('./virtual-peers-db');
          return getPubkey(peerId);
        },
        catchUp: (pubkey) => chatAPI.catchUpConversation(pubkey)
      });
    });
  }

  const refreshOnce = () => refreshDialogPreviews({
    getDialogs,
    reloadConversation: (peerId) => rootScope.managers.appMessagesManager.reloadConversation(peerId)
  });
  const previewsReady = refreshOnce();

  // Cold-profile convergence: the boot refresh above ran against a store the
  // background backfill hadn't filled yet. Re-run when a backfill pass
  // completes and on the bounded post-install schedule (see the header note).
  wirePreviewRefreshReruns({
    run: refreshOnce,
    onBackfillComplete: typeof rootScope.addEventListener === 'function' ?
      (fn) => { rootScope.addEventListener('phantomchat_backfill_complete', fn); } :
      undefined,
    onBackfillProgress: typeof rootScope.addEventListener === 'function' ?
      (fn) => { rootScope.addEventListener('phantomchat_backfill_progress', fn); } :
      undefined
  });

  void openTopChatOnDesktop({
    getDialogs,
    isMobile: opts.isMobile,
    currentPeerId: () => appImManager?.chat?.peerId || undefined,
    launchedWithDeepLink: opts.launchedWithDeepLink,
    openPeer: (peerId) => appImManager.setInnerPeer({peerId})
  }).catch((err) => console.debug(LOG_PREFIX, 'top chat open failed', (err as Error)?.message));

  return {previewsReady};
}
