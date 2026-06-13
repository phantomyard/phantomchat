/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

// [Nostra.chat] FIND-chrono-v2: P2P bubble sort needs a (timestamp, mid) tiebreaker.
// Same-second tempMid race produces bubbles with identical `timestamp`; the single-key
// `insertSomething` collapses to insertion order (non-deterministic), exposing an
// `INV-bubble-chronological` flake on ~60% of replays. Sort primary desc, then
// secondary desc, stable per-call regardless of insertion order.
//
// Extracted from `@components/chat/bubbleGroups` to keep the helper pure (no DOM
// imports) so regression tests in `src/tests/fuzz/invariants/bubbles.test.ts` can
// drive the real production function under Node/Vitest.

import indexOfAndSplice from './indexOfAndSplice';

export default function insertSomethingWithTiebreak<T>(
  to: Array<T>,
  what: T,
  primaryKey: keyof T,
  secondaryKey: keyof T,
  reverse: boolean
): number {
  indexOfAndSplice(to, what);
  if(reverse) {
    // ASCENDING insertion (reverse=true): primary asc, then secondary asc
    let i = 0;
    while(i < to.length && (
      (to[i] as any)[primaryKey] < (what as any)[primaryKey] ||
      ((to[i] as any)[primaryKey] === (what as any)[primaryKey] && (to[i] as any)[secondaryKey] < (what as any)[secondaryKey])
    )) i++;
    to.splice(i, 0, what);
    return i;
  }
  // DESCENDING insertion: primary desc, then secondary desc
  let i = 0;
  while(i < to.length && (
    (to[i] as any)[primaryKey] > (what as any)[primaryKey] ||
    ((to[i] as any)[primaryKey] === (what as any)[primaryKey] && (to[i] as any)[secondaryKey] > (what as any)[secondaryKey])
  )) i++;
  to.splice(i, 0, what);
  return i;
}
