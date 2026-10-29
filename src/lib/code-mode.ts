/*
 * Code Mode — a thin-client "coding inbox" inside PhantomChat.
 *
 * Andrew's call (2026-10-29): phantomcode is a MODE, not a second app. The
 * phantoms already run their own harnesses and do the work; PhantomChat stays
 * a thin client with no filesystem access and no local spawn, so Code Mode is
 * UI plus the transport that already exists — never an engine.
 *
 * SESSION-FIRST (#279, superseding the contact-derived inbox of #277).
 * The left column is a list of SESSIONS, not of phantoms:
 *
 *   [ the app's own Search field ]
 *   Active      — idle sessions, newest first
 *   Archived    — manual archive, newest first
 *   Working     — sessions with a live typing indicator, stacked bottom-up
 *
 * A session is a 2-member private group (you + one phantom, see
 * `code-session-service`), which is what makes two independent threads with
 * the SAME phantom possible: each one gets its own `group:<groupId>`
 * conversation on the phantom side, with no protocol change.
 *
 * Creation lives in the ordinary ✏️ menu (`New Coding Session`), not in this
 * inbox: it opens the bot-filtered contact picker, mints the session group and
 * drops the user into the real chat pane. Until the first message the row is
 * labelled `New session`; the first send renames it `<first 10 chars>…`. The
 * phantom is fixed at creation — there is no mid-session switch.
 *
 * This module holds the PURE plumbing — the mode flag, the rail glyph, the
 * auto-naming rule and the group/sort/badge logic — so all of it is testable
 * without a browser. Storage lives in `code-sessions-db`, transport in
 * `code-session-service`, live turn state in `code-session-runtime`.
 *
 * Deliberately NOT here: any filter/folder storage. Code Mode is not a
 * `dialogFilter`, so it can never leak into `filter_order` or the FoldersSync
 * snapshot, and it needs no migration.
 */

/** StateSettings key under `settings.` where the Code Mode flag lives. */
export const CODE_MODE_SETTING_KEY = 'codeModeEnabled' as const;

/** Class added to `<body>`, and nothing else, so the whole skin is css-scoped. */
export const CODE_MODE_BODY_CLASS = 'code-mode' as const;

/**
 * Rail glyph. Andrew (2026-10-29): a `#` badge, in the same icon style as the
 * other rail entries — so it is rendered as TEXT inside the folder-item icon
 * slot (`iconText`), not as an emoji. An emoji renders as a colour sticker and
 * breaks the monochrome rail; text inherits the icon size, weight and colour.
 */
export const CODE_MODE_RAIL_GLYPH = '#';

/** LangPack key for the rail label. */
export const CODE_MODE_LANG_KEY = 'CodeMode' as const;

/** rootScope event fired whenever the mode is entered or left. */
export const CODE_MODE_EVENT = 'code_mode_changed' as const;

/** rootScope event fired whenever the session list or a runtime state changed. */
export const CODE_SESSIONS_CHANGED_EVENT = 'code_sessions_changed' as const;

/**
 * rootScope event asking the folders rail to select Code Mode. The pencil menu
 * lives outside the rail (it is the global ✏️ button) and "New Coding Session"
 * has to land the user in Code Mode, so it asks rather than reaching into the
 * rail's state.
 */
export const CODE_MODE_ENTER_EVENT = 'code_mode_enter_requested' as const;

/**
 * Characters of the first prompt that become the session title before the
 * ellipsis. Andrew's rule: "the first 10 chars of the first prompt + …".
 */
export const SESSION_TITLE_CHARS = 10 as const;

/** Appended to a truncated auto-title. */
export const SESSION_TITLE_ELLIPSIS = '…' as const;

/**
 * How long after the last typing tick a session still counts as Working. The
 * phantom re-publishes a tick every ~2s and tweb auto-expires the dots after
 * 6s, so a slightly wider window keeps the row from flickering between ticks
 * without ever outliving the turn.
 */
export const WORKING_TYPING_WINDOW_MS = 8000 as const;

/**
 * Grace period after a send during which a session shows as Working even
 * before the first typing tick lands — otherwise the row would not appear in
 * its "Working" place until the phantom's round-trip completed.
 */
export const WORKING_SEND_GRACE_MS = 6000 as const;

/**
 * Hard cap on a turn (Andrew, 2026-10-29): a dead phantom must not pin a
 * session in Working forever. Past this the turn is marked Interrupted.
 */
export const WORKING_HARD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A settings value read back from IndexedDB is untrusted shape: anything that
 * is not literally `true` means "off".
 */
export function isCodeModeEnabled(value: unknown): boolean {
  return value === true;
}

/**
 * Toggle the skin class on an element (the real one is `document.body`).
 * Returns whether the class is now present, so callers/tests can assert
 * without re-reading the DOM.
 */
export function applyCodeModeClass(
  element: {classList: Pick<DOMTokenList, 'add' | 'remove'>},
  enabled: boolean
): boolean {
  if(enabled) element.classList.add(CODE_MODE_BODY_CLASS);
  else element.classList.remove(CODE_MODE_BODY_CLASS);
  return enabled;
}

/** The title a session gets from its very first prompt. */
export function autoSessionTitle(prompt: string): string {
  // Collapse runs of whitespace: a prompt that starts with a newline or an
  // indent must not produce a title made of blanks.
  const clean = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  if(!clean) return '';
  if(clean.length <= SESSION_TITLE_CHARS) return clean;
  return clean.slice(0, SESSION_TITLE_CHARS) + SESSION_TITLE_ELLIPSIS;
}

/**
 * Compact elapsed time for a Working row ("4s", "1m 12s", "1h 03m"), matching
 * the OpenCode counter Andrew pointed at. Sub-hour values keep seconds so a
 * short turn visibly ticks.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if(hours > 0) return hours + 'h ' + String(minutes).padStart(2, '0') + 'm';
  if(minutes > 0) return minutes + 'm ' + String(seconds).padStart(2, '0') + 's';
  return seconds + 's';
}

/** Compact relative age for an idle row ("now", "5m", "3h", "2d"). */
export function formatSessionAge(lastActiveAtMs: number, nowMs: number): string {
  if(!lastActiveAtMs) return '';
  const delta = Math.max(0, Math.floor((nowMs - lastActiveAtMs) / 1000));
  if(delta < 60) return 'now';
  if(delta < 3600) return Math.floor(delta / 60) + 'm';
  if(delta < 86400) return Math.floor(delta / 3600) + 'h';
  if(delta < 86400 * 30) return Math.floor(delta / 86400) + 'd';
  return '';
}

/** What a turn ended as, decided by `code-session-runtime`. */
export type CodeTurnEnd = 'done' | 'interrupted';

/**
 * Per-device live state for one session. NOT synced: "this turn is running"
 * and "you have not read it yet" are device facts, not account facts.
 */
export interface CodeSessionRuntime {
  /** Last activity (send or receive), unix millis — drives row ordering. */
  lastActiveAt: number;
  /** Turn in flight: when it started (unix millis), 0 when idle. */
  workingSince?: number;
  /** Last typing tick from the phantom (unix millis, 0/none when idle). */
  lastTypingAt?: number;
  /** When a turn ended (unix millis) — paired with `end`. */
  endedAt?: number;
  /** How it ended; cleared by reading the session. */
  end?: CodeTurnEnd;
  /** Unread since the last time this session was opened. */
  unread?: boolean;
}

/** A row in the Code rail. */
export interface CodeSessionRow {
  groupId: string;
  title: string;
  archived: boolean;
  createdAt: number;
  lastActiveAt: number;
  /** No message sent yet: the row shows the `New session` label, not a title. */
  pending: boolean;
}

/** Everything `groupSessionRows` needs from one session. */
export interface CodeSessionInput {
  groupId: string;
  title: string;
  archived: boolean;
  createdAt: number;
  /**
   * False until the first message names the session. Pending sessions ARE
   * listed (labelled `New session`), because the user has to be able to come
   * back to a session they created and did not use yet.
   */
  hasPrompt?: boolean;
}

export interface GroupedSessionRows {
  /** Sessions with a live typing indicator; OLDEST FIRST so the newest sits lowest. */
  working: CodeSessionRow[];
  /** Idle, unarchived sessions, newest activity first. */
  active: CodeSessionRow[];
  /** Manually archived sessions, newest activity first. */
  archived: CodeSessionRow[];
}

/** Is this session's turn still running at `nowMs`? */
export function isSessionWorking(runtime: CodeSessionRuntime | undefined, nowMs: number): boolean {
  if(!runtime) return false;

  const workingSince = runtime.workingSince || 0;
  if(!workingSince) return false;
  // The hard cap wins over everything: a dead phantom cannot pin a row.
  if(nowMs - workingSince >= WORKING_HARD_TIMEOUT_MS) return false;
  // A turn that already ended is not working, whatever the timers say.
  if(runtime.endedAt && runtime.endedAt >= workingSince) return false;

  const lastTypingAt = runtime.lastTypingAt || 0;
  if(lastTypingAt && nowMs - lastTypingAt < WORKING_TYPING_WINDOW_MS) return true;
  // Pre-first-tick grace so the row lands in Working the instant you send.
  return nowMs - workingSince < WORKING_SEND_GRACE_MS;
}

/**
 * Badge for an idle row: `done` (green dot, turn finished) or `interrupted`
 * (turned out dead), both cleared once the session is read. Working rows carry
 * no badge — their position in the Working group IS the status.
 */
export function sessionBadge(
  runtime: CodeSessionRuntime | undefined,
  nowMs: number
): CodeTurnEnd | null {
  // The badge lives until the session is READ — `markSessionRead` is the only
  // thing that clears it. `unread` is kept separately because an Interrupted
  // turn is a status worth showing even though it delivered nothing new.
  if(!runtime || isSessionWorking(runtime, nowMs)) return null;
  return runtime.end || null;
}

/**
 * Split the sessions into the three rail groups. Pure: the caller passes the
 * runtime map and the clock, so the grouping is identical everywhere and
 * testable without timers.
 *
 * Ordering rules from Andrew's spec:
 *  - Working: bottom-up, newest lowest → returned OLDEST FIRST.
 *  - Active / Archived: newest activity first.
 *  - A session with no prompt yet sits in Active, labelled `New session`;
 *    the first message turns it into `<first 10 chars>…`.
 */
export function groupSessionRows(
  sessions: CodeSessionInput[],
  runtime: Record<string, CodeSessionRuntime | undefined> = {},
  nowMs: number = Date.now()
): GroupedSessionRows {
  const working: CodeSessionRow[] = [];
  const active: CodeSessionRow[] = [];
  const archived: CodeSessionRow[] = [];

  for(const session of sessions) {
    if(!session || !session.groupId) continue;

    const rt = runtime[session.groupId];
    const row: CodeSessionRow = {
      groupId: session.groupId,
      title: session.title,
      archived: !!session.archived,
      createdAt: session.createdAt,
      lastActiveAt: (rt?.lastActiveAt || 0) || session.createdAt,
      pending: session.hasPrompt === false
    };

    if(session.archived) archived.push(row);
    else if(isSessionWorking(rt, nowMs)) working.push(row);
    else active.push(row);
  }

  const byActivityDesc = (a: CodeSessionRow, b: CodeSessionRow) => {
    if(b.lastActiveAt !== a.lastActiveAt) return b.lastActiveAt - a.lastActiveAt;
    return b.createdAt - a.createdAt;
  };
  const byActivityAsc = (a: CodeSessionRow, b: CodeSessionRow) => -byActivityDesc(a, b);

  active.sort(byActivityDesc);
  archived.sort(byActivityDesc);
  working.sort(byActivityAsc);

  return {working, active, archived};
}

/**
 * Case-insensitive substring match over session titles. Empty query matches
 * everything, so the rail is unchanged until the user types.
 */
export function filterSessionsByQuery<T extends {title: string}>(rows: T[], query: string): T[] {
  const needle = String(query ?? '').trim().toLowerCase();
  if(!needle) return rows;
  return rows.filter((row) => row.title.toLowerCase().includes(needle));
}

/**
 * Start a turn: the session becomes Working immediately and loses any stale
 * done/interrupted badge from the previous turn.
 */
export function startTurn(
  runtime: CodeSessionRuntime | undefined,
  nowMs: number
): CodeSessionRuntime {
  return {
    ...(runtime || {lastActiveAt: nowMs}),
    lastActiveAt: nowMs,
    workingSince: nowMs,
    lastTypingAt: 0,
    endedAt: undefined,
    end: undefined,
    unread: false
  };
}

/**
 * Register a typing tick. A tick can arrive for a session this device never
 * saw a send for (another device sent, or the app reloaded mid-turn), so a
 * tick is also allowed to start the Working window.
 */
export function applyTypingTick(
  runtime: CodeSessionRuntime | undefined,
  nowMs: number
): CodeSessionRuntime {
  const base = runtime || {lastActiveAt: nowMs};
  const workingSince = base.workingSince || nowMs;
  return {
    ...base,
    workingSince,
    lastTypingAt: nowMs,
    endedAt: undefined,
    end: undefined
  };
}

/**
 * End a turn. `done` when the phantom answered (or stopped typing normally),
 * `interrupted` when the hard cap fired. Sets the unread badge — the row is
 * badged Done/Interrupted until the user opens it.
 */
export function endTurn(
  runtime: CodeSessionRuntime | undefined,
  how: CodeTurnEnd,
  nowMs: number,
  opts: {unread?: boolean} = {}
): CodeSessionRuntime {
  const base = runtime || {lastActiveAt: nowMs};
  return {
    ...base,
    workingSince: 0,
    lastTypingAt: 0,
    endedAt: nowMs,
    end: how,
    unread: opts.unread ?? how === 'done',
    lastActiveAt: nowMs
  };
}

/**
 * Reading a session clears its badge (and the unread flag). Andrew's rule:
 * "Remove the Interrupted or Done badge on read."
 */
export function markSessionRead(
  runtime: CodeSessionRuntime | undefined,
  nowMs: number
): CodeSessionRuntime {
  const base = runtime || {lastActiveAt: nowMs};
  return {...base, end: undefined, endedAt: undefined, unread: false};
}

/**
 * A Working row's elapsed label: from the turn's start. The cap keeps a
 * clock-skewed/backdated value from rendering as a negative or absurd number.
 */
export function sessionElapsedLabel(runtime: CodeSessionRuntime | undefined, nowMs: number): string {
  const since = runtime?.workingSince || 0;
  if(!since) return '';
  return formatElapsed(Math.min(nowMs - since, WORKING_HARD_TIMEOUT_MS));
}
