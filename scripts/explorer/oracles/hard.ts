import {CONSOLE_ALLOWLIST} from '../../../src/tests/fuzz/allowlist';
import {EXPLORER_STABLE_CONSOLE_ALLOWLIST} from '../explorer-allowlist';
import type {PageId} from '../types';

// `docs/explorer-reports/allowlist.ts` is a gitignored per-developer scratch slot
// (a throwaway extension of EXPLORER_STABLE_CONSOLE_ALLOWLIST), so it is ABSENT on
// clean checkouts / CI. A *static* import of it breaks `tsc --noEmit` on a fresh tree
// — that was the v0.25.0 deploy-build failure (TS2307 + TS7006). Load it best-effort
// via a non-literal specifier so tsc skips module resolution; when the file is missing
// the list stays empty, identical to a clean checkout.
let EXPLORER_CONSOLE_ALLOWLIST: readonly RegExp[] = [];
const optionalAllowlistSlot: string = '../../../docs/explorer-reports/allowlist';
void (async() => {
  try {
    const mod = await import(optionalAllowlistSlot) as {EXPLORER_CONSOLE_ALLOWLIST?: readonly RegExp[]};
    if(Array.isArray(mod.EXPLORER_CONSOLE_ALLOWLIST)) {
      EXPLORER_CONSOLE_ALLOWLIST = mod.EXPLORER_CONSOLE_ALLOWLIST;
    }
  } catch{
    // No per-developer extension present — expected on clean checkouts / CI.
  }
})();

export type HardOracleKind = 'console_error' | 'unhandled_rejection' | 'network_5xx' | 'white_screen';

export interface HardFinding {
  oracle: HardOracleKind;
  page: PageId;
  message: string;
  hash: string;
}

export interface HardOracleInput {
  pageA: {consoleSinceStart: string[]};
  pageB: {consoleSinceStart: string[]};
}

export function checkHard(input: HardOracleInput): HardFinding[] {
  const findings: HardFinding[] = [];
  for(const [pageId, capture] of [['A', input.pageA], ['B', input.pageB]] as const) {
    for(const line of capture.consoleSinceStart) {
      if(isAllowlisted(line)) continue;
      if(/\[error\]/i.test(line) || /\bUncaught\b/.test(line)) {
        findings.push({oracle: 'console_error', page: pageId, message: line, hash: shortHash(line)});
      }
      if(/\[pageerror\]/i.test(line) || /Unhandled promise rejection/i.test(line)) {
        findings.push({oracle: 'unhandled_rejection', page: pageId, message: line, hash: shortHash(line)});
      }
    }
  }
  return findings;
}

function isAllowlisted(line: string): boolean {
  return CONSOLE_ALLOWLIST.some((re) => re.test(line)) ||
    EXPLORER_STABLE_CONSOLE_ALLOWLIST.some((re) => re.test(line)) ||
    EXPLORER_CONSOLE_ALLOWLIST.some((re) => re.test(line));
}

function shortHash(s: string): string {
  let h = 0;
  for(let i = 0; i < Math.min(s.length, 200); i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}
