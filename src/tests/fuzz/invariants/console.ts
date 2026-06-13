// @ts-nocheck
import type {Invariant, FuzzContext, UserHandle, InvariantResult} from '../types';
import {isAllowlisted} from '../allowlist';

const WARMUP_MS = 5000;

function isWithinWarmup(user: UserHandle): boolean {
  const lastReload = user.reloadTimes[user.reloadTimes.length - 1] ?? 0;
  return Date.now() - lastReload < WARMUP_MS;
}

function findBadLine(user: UserHandle): string | null {
  if(isWithinWarmup(user)) return null;
  for(const line of user.consoleLog) {
    const isError = line.startsWith('[error]') || line.startsWith('[pageerror]') || line.startsWith('[warning]');
    if(!isError) continue;
    if(isAllowlisted(line)) continue;
    return line;
  }
  return null;
}

export const consoleClean: Invariant = {
  id: 'INV-console-clean',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    const bad = findBadLine(ctx.users.userA) || findBadLine(ctx.users.userB);
    if(!bad) return {ok: true};
    return {
      ok: false,
      message: `Unallowlisted console error: ${bad.slice(0, 300)}`,
      evidence: {badLine: bad}
    };
  }
};
