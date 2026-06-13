import {existsSync, readFileSync, writeFileSync} from 'node:fs';

export interface SignatureKey {
  area: string;
  intent: string;
  oracle: string;
  hash: string;
}

export type SeenStatus = 'open' | 'fix-pr-open' | 'fixed' | 'report-only' | 'allowlisted';

export interface SeenEntry {
  find_id: string;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  status: SeenStatus;
  fix_pr?: string;
  fix_branch?: string;
  /** When status === 'report-only', reason set by the fixer (e.g. 'category-disallowed:messageport'). */
  report_only_reason?: string;
}

export type SeenStore = Record<string, SeenEntry>;

export interface Sighting {
  signature: string;
  findId: string;
  timestamp: string;
}

export interface RecordResult {
  isNew: boolean;
  regression: boolean;
  entry: SeenEntry;
}

export function computeSignature(key: SignatureKey): string {
  return `${key.area}:${key.intent}:${key.oracle}:${key.hash}`;
}

export async function loadStore(storePath: string): Promise<SeenStore> {
  if(!existsSync(storePath)) return {};
  const raw = readFileSync(storePath, 'utf8');
  if(!raw.trim()) return {};
  return JSON.parse(raw) as SeenStore;
}

export async function recordSighting(storePath: string, s: Sighting): Promise<RecordResult> {
  const store = await loadStore(storePath);
  const existing = store[s.signature];
  if(!existing) {
    const entry: SeenEntry = {
      find_id: s.findId,
      occurrences: 1,
      first_seen: s.timestamp,
      last_seen: s.timestamp,
      status: 'open'
    };
    store[s.signature] = entry;
    writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
    return {isNew: true, regression: false, entry};
  }
  const regression = existing.status === 'fixed';
  existing.occurrences += 1;
  existing.last_seen = s.timestamp;
  writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return {isNew: false, regression, entry: existing};
}

async function patchEntry(storePath: string, signature: string, patch: Partial<SeenEntry>): Promise<SeenEntry> {
  const store = await loadStore(storePath);
  const existing = store[signature];
  if(!existing) throw new Error(`patchEntry: signature not found: ${signature}`);
  const next: SeenEntry = {...existing, ...patch};
  store[signature] = next;
  writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return next;
}

export async function markFixPrOpen(storePath: string, signature: string, opts: {fixPr: string; fixBranch: string}): Promise<SeenEntry> {
  return patchEntry(storePath, signature, {status: 'fix-pr-open', fix_pr: opts.fixPr, fix_branch: opts.fixBranch});
}

export async function markFixed(storePath: string, signature: string): Promise<SeenEntry> {
  return patchEntry(storePath, signature, {status: 'fixed'});
}

export async function markReportOnly(storePath: string, signature: string, reason: string): Promise<SeenEntry> {
  return patchEntry(storePath, signature, {status: 'report-only', report_only_reason: reason});
}
