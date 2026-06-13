import {existsSync, readFileSync, writeFileSync} from 'node:fs';

export interface CoverageEntry {
  runs: number;
  last_run: string;
  findings: number;
}

export type CoverageStore = Record<string, CoverageEntry>;

export async function loadCoverage(storePath: string): Promise<CoverageStore> {
  if(!existsSync(storePath)) return {};
  const raw = readFileSync(storePath, 'utf8');
  if(!raw.trim()) return {};
  return JSON.parse(raw) as CoverageStore;
}

export async function recordRun(
  storePath: string,
  area: string,
  timestamp: string,
  finding: boolean = false
): Promise<void> {
  const store = await loadCoverage(storePath);
  const entry = store[area] ?? {runs: 0, last_run: '', findings: 0};
  entry.runs += 1;
  entry.last_run = timestamp;
  if(finding) entry.findings += 1;
  store[area] = entry;
  writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

/**
 * Pick the cold-zone area: returns an area from `candidates` that has the
 * lowest run count (zero if it's never been recorded). Ties broken alphabetically.
 */
export async function pickColdZone(storePath: string, candidates: string[]): Promise<string> {
  if(candidates.length === 0) throw new Error('pickColdZone: candidates list is empty');
  const store = await loadCoverage(storePath);
  let best = candidates[0];
  let bestRuns = store[best]?.runs ?? 0;
  for(const c of candidates.slice(1)) {
    const runs = store[c]?.runs ?? 0;
    if(runs < bestRuns || (runs === bestRuns && c < best)) {
      best = c;
      bestRuns = runs;
    }
  }
  return best;
}
