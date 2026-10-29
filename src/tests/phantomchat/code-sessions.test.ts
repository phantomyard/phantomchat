/**
 * Code Mode sessions — the pure half (#279).
 *
 * Andrew's spec, pinned here:
 *  - the title is the first 10 characters of the first prompt + "…";
 *  - a session created from the ✏️ menu but not yet used is listed in Active as
 *    `New session` until its first message names it;
 *  - Active and Archived are newest-activity first;
 *  - Working is the live typing indicator, stacked BOTTOM-UP (newest lowest)
 *    and marked Interrupted after the hard cap;
 *  - Done / Interrupted badges clear on read;
 *  - search matches titles, case-insensitively.
 *
 * The whole point of keeping these pure is that none of it needs a browser,
 * IndexedDB or a relay to be trustworthy.
 */
import {describe, it, expect} from 'vitest';
import {
  SESSION_TITLE_CHARS,
  WORKING_HARD_TIMEOUT_MS,
  WORKING_SEND_GRACE_MS,
  WORKING_TYPING_WINDOW_MS,
  applyTypingTick,
  autoSessionTitle,
  endTurn,
  filterSessionsByQuery,
  formatElapsed,
  formatSessionAge,
  groupSessionRows,
  isSessionWorking,
  markSessionRead,
  sessionBadge,
  sessionElapsedLabel,
  startTurn,
  type CodeSessionInput,
  type CodeSessionRuntime
} from '@lib/code-mode';

const NOW = 1_700_000_000_000;

function session(over: Partial<CodeSessionInput> & {groupId: string}): CodeSessionInput {
  return {title: over.groupId, archived: false, createdAt: NOW, hasPrompt: true, ...over};
}

describe('autoSessionTitle', () => {
  it('uses the whole prompt when it is 10 characters or shorter', () => {
    expect(SESSION_TITLE_CHARS).toBe(10);
    expect(autoSessionTitle('fix bug')).toBe('fix bug');
    expect(autoSessionTitle('1234567890')).toBe('1234567890');
  });

  it('truncates to 10 characters and appends an ellipsis', () => {
    expect(autoSessionTitle('12345678901')).toBe('1234567890…');
    expect(autoSessionTitle('Refactor the relay pool please')).toBe('Refactor t…');
  });

  it('collapses whitespace and trims, so a leading newline does not become the title', () => {
    expect(autoSessionTitle('\n\n  hello   world  ')).toBe('hello worl…');
    expect(autoSessionTitle('  short ')).toBe('short');
  });

  it('returns an empty title for an empty prompt', () => {
    expect(autoSessionTitle('')).toBe('');
    expect(autoSessionTitle('   \n ')).toBe('');
    expect(autoSessionTitle(undefined as unknown as string)).toBe('');
  });
});

describe('formatElapsed', () => {
  it('ticks in seconds under a minute, so a short turn visibly moves', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(4_000)).toBe('4s');
    expect(formatElapsed(59_999)).toBe('59s');
  });

  it('keeps seconds alongside minutes and pads to a stable width', () => {
    expect(formatElapsed(60_000)).toBe('1m 00s');
    expect(formatElapsed(72_000)).toBe('1m 12s');
    expect(formatElapsed(604_000)).toBe('10m 04s');
  });

  it('collapses to hours + minutes past an hour', () => {
    expect(formatElapsed(3_600_000)).toBe('1h 00m');
    expect(formatElapsed(3_780_000)).toBe('1h 03m');
  });

  it('never renders a negative or NaN clock', () => {
    expect(formatElapsed(-5_000)).toBe('0s');
    expect(formatElapsed(Number.NaN)).toBe('0s');
  });
});

describe('formatSessionAge', () => {
  it('renders compact relative ages', () => {
    expect(formatSessionAge(0, NOW)).toBe('');
    expect(formatSessionAge(NOW - 10_000, NOW)).toBe('now');
    expect(formatSessionAge(NOW - 5 * 60_000, NOW)).toBe('5m');
    expect(formatSessionAge(NOW - 3 * 3_600_000, NOW)).toBe('3h');
    expect(formatSessionAge(NOW - 2 * 86_400_000, NOW)).toBe('2d');
  });
});

describe('working state', () => {
  it('is not working without a started turn', () => {
    expect(isSessionWorking(undefined, NOW)).toBe(false);
    expect(isSessionWorking({lastActiveAt: NOW}, NOW)).toBe(false);
  });

  it('shows as working immediately after a send (pre-first-tick grace)', () => {
    const rt = startTurn(undefined, NOW);
    expect(isSessionWorking(rt, NOW)).toBe(true);
    expect(isSessionWorking(rt, NOW + WORKING_SEND_GRACE_MS - 1)).toBe(true);
    // No tick arrived → the grace lapses and the row leaves Working.
    expect(isSessionWorking(rt, NOW + WORKING_SEND_GRACE_MS + 1)).toBe(false);
  });

  it('stays working while typing ticks keep arriving', () => {
    let rt = startTurn(undefined, NOW);
    rt = applyTypingTick(rt, NOW + 2_000);
    expect(isSessionWorking(rt, NOW + 2_000 + WORKING_TYPING_WINDOW_MS - 1)).toBe(true);
    expect(isSessionWorking(rt, NOW + 2_000 + WORKING_TYPING_WINDOW_MS + 1)).toBe(false);
  });

  it('a typing tick can start a turn this device never saw a send for', () => {
    // Another device sent, or the app reloaded mid-turn.
    const rt = applyTypingTick(undefined, NOW);
    expect(rt.workingSince).toBe(NOW);
    expect(isSessionWorking(rt, NOW)).toBe(true);
  });

  it('stops working when the turn ends', () => {
    let rt = startTurn(undefined, NOW);
    rt = applyTypingTick(rt, NOW + 1_000);
    rt = endTurn(rt, 'done', NOW + 3_000);
    expect(isSessionWorking(rt, NOW + 3_000)).toBe(false);
    expect(rt.workingSince).toBe(0);
  });

  it('honours the hard cap so a dead phantom cannot pin a row in Working', () => {
    // Ticks are STILL arriving right up to the cap (a phantom stuck looping),
    // and the cap still wins: the row must not sit in Working forever.
    const rt = applyTypingTick(startTurn(undefined, NOW), NOW + WORKING_HARD_TIMEOUT_MS - 1_000);
    expect(isSessionWorking(rt, NOW + WORKING_HARD_TIMEOUT_MS - 1)).toBe(true);
    expect(isSessionWorking(rt, NOW + WORKING_HARD_TIMEOUT_MS + 1)).toBe(false);
  });

  it('formats the elapsed counter from the turn start, capped at the hard timeout', () => {
    const rt = startTurn(undefined, NOW);
    expect(sessionElapsedLabel(rt, NOW + 4_000)).toBe('4s');
    expect(sessionElapsedLabel(rt, NOW + 72_000)).toBe('1m 12s');
    expect(sessionElapsedLabel(rt, NOW + WORKING_HARD_TIMEOUT_MS * 5)).toBe('10m 00s');
    expect(sessionElapsedLabel(undefined, NOW)).toBe('');
  });
});

describe('badges', () => {
  it('shows Done while unread and clears it on read', () => {
    let rt = startTurn(undefined, NOW);
    rt = endTurn(rt, 'done', NOW + 5_000);
    expect(sessionBadge(rt, NOW + 6_000)).toBe('done');

    rt = markSessionRead(rt, NOW + 7_000);
    expect(sessionBadge(rt, NOW + 7_000)).toBeNull();
    expect(rt.unread).toBe(false);
  });

  it('shows Interrupted after the hard cap and clears it on read', () => {
    let rt = startTurn(undefined, NOW);
    rt = endTurn(rt, 'interrupted', NOW + WORKING_HARD_TIMEOUT_MS);
    expect(sessionBadge(rt, NOW + WORKING_HARD_TIMEOUT_MS + 1)).toBe('interrupted');
    expect(sessionBadge(markSessionRead(rt, NOW + WORKING_HARD_TIMEOUT_MS + 2), NOW + WORKING_HARD_TIMEOUT_MS + 2)).toBeNull();
  });

  it('carries no badge while the turn is running', () => {
    const rt = startTurn(undefined, NOW);
    expect(sessionBadge(rt, NOW)).toBeNull();
  });

  it('does not badge an interrupted turn as unread', () => {
    const rt = endTurn(startTurn(undefined, NOW), 'interrupted', NOW + 1_000, {unread: false});
    expect(rt.unread).toBe(false);
  });
});

describe('groupSessionRows', () => {
  const sessions: CodeSessionInput[] = [
    session({groupId: 'a', title: 'Alpha', createdAt: NOW - 10_000}),
    session({groupId: 'b', title: 'Bravo', createdAt: NOW - 20_000}),
    session({groupId: 'c', title: 'Charlie', createdAt: NOW - 30_000, archived: true})
  ];

  const runtime: Record<string, CodeSessionRuntime | undefined> = {
    a: {lastActiveAt: NOW - 1_000},
    b: {lastActiveAt: NOW - 5_000},
    c: {lastActiveAt: NOW - 60_000}
  };

  it('splits into active / archived / working', () => {
    const grouped = groupSessionRows(sessions, runtime, NOW);
    expect(grouped.active.map((row) => row.groupId)).toEqual(['a', 'b']);
    expect(grouped.archived.map((row) => row.groupId)).toEqual(['c']);
    expect(grouped.working).toEqual([]);
  });

  it('keeps a pending session in Active, flagged and untitled, until its first message', () => {
    const pending = session({groupId: 'd', title: '', createdAt: NOW - 40_000, hasPrompt: false});
    const grouped = groupSessionRows([...sessions, pending], runtime, NOW);

    // Listed in Active (Andrew: "Use New Session until the first message"),
    // so the user can come back to a session they created but did not use.
    const row = grouped.active.find((entry) => entry.groupId === 'd');
    expect(row).toMatchObject({groupId: 'd', title: '', pending: true});
    // A prompted session is never flagged pending.
    expect(grouped.active.find((entry) => entry.groupId === 'a')?.pending).toBe(false);
  });

  it('orders Active and Archived by newest activity first', () => {
    const withOlder = [
      ...sessions,
      session({groupId: 'e', title: 'Echo', createdAt: NOW - 50_000})
    ];
    const grouped = groupSessionRows(withOlder, {...runtime, e: {lastActiveAt: NOW - 2_000}}, NOW);
    expect(grouped.active.map((row) => row.groupId)).toEqual(['a', 'e', 'b']);
  });

  it('moves a running session into Working and orders it oldest-first (newest lowest)', () => {
    const running: Record<string, CodeSessionRuntime | undefined> = {
      ...runtime,
      a: startTurn(runtime.a, NOW - 2_000),
      b: startTurn(runtime.b, NOW - 1_000)
    };
    const grouped = groupSessionRows(sessions, running, NOW);
    // Oldest first: the rail renders top-down, so the newest ends up lowest.
    expect(grouped.working.map((row) => row.groupId)).toEqual(['a', 'b']);
    expect(grouped.active).toEqual([]);
  });

  it('keeps an archived session archived even while it runs', () => {
    const grouped = groupSessionRows(sessions, {...runtime, c: startTurn(runtime.c, NOW)}, NOW);
    expect(grouped.working.map((row) => row.groupId)).toEqual([]);
    expect(grouped.archived.map((row) => row.groupId)).toEqual(['c']);
  });

  it('degrades to the creation time when a session has no runtime yet', () => {
    const grouped = groupSessionRows([session({groupId: 'z', createdAt: NOW - 123})], {}, NOW);
    expect(grouped.active[0].lastActiveAt).toBe(NOW - 123);
  });
});

describe('filterSessionsByQuery', () => {
  const rows = [
    {title: 'Refactor the relay pool'},
    {title: 'deploy preview'},
    {title: 'Lena fixes logging'}
  ];

  it('matches titles case-insensitively', () => {
    expect(filterSessionsByQuery(rows, 'RELAY')).toEqual([rows[0]]);
    expect(filterSessionsByQuery(rows, 'pre')).toEqual([rows[1]]);
  });

  it('matches everything for an empty query', () => {
    expect(filterSessionsByQuery(rows, '')).toEqual(rows);
    expect(filterSessionsByQuery(rows, '   ')).toEqual(rows);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterSessionsByQuery(rows, 'zzz')).toEqual([]);
  });
});
