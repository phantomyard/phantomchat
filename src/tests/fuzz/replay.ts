// @ts-nocheck
import {readFileSync, existsSync} from 'fs';
import {join} from 'path';
import {FUZZER_VERSION} from './version';
import type {Action} from './types';

const ARTIFACTS_ROOT = 'docs/fuzz-reports';

export async function replayFinding(findId: string): Promise<Action[]> {
  const cleaned = findId.startsWith('FIND-') ? findId : `FIND-${findId}`;
  const path = join(ARTIFACTS_ROOT, cleaned, 'trace.json');
  if(!existsSync(path)) {
    throw new Error(`No trace.json for ${cleaned} at ${path}`);
  }
  return replayFile(path);
}

export async function replayFile(path: string): Promise<Action[]> {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  const commands = Array.isArray(parsed) ? parsed : parsed.commands;
  if(!Array.isArray(commands)) throw new Error(`Trace file does not contain a commands array: ${path}`);
  return commands;
}

export async function replayBaseline(): Promise<Action[]> {
  const {readdirSync} = await import('fs');
  const dir = 'docs/fuzz-baseline';
  if(!existsSync(dir)) {
    throw new Error(`No baseline directory at ${dir}. Run with --emit-baseline first.`);
  }
  const candidates = readdirSync(dir).filter((f) => /^baseline-seed\d+(-v2b\d+)?\.json$/.test(f));
  if(!candidates.length) throw new Error(`No baseline found in ${dir}. Run with --emit-baseline first.`);
  // Prefer v2bN over unversioned; within v2bN prefer higher N.
  const score = (name: string): number => {
    const m = name.match(/-v2b(\d+)\.json$/);
    return m ? 1000 + Number(m[1]) : 0;
  };
  candidates.sort((a, b) => score(b) - score(a));
  const path = join(dir, candidates[0]);
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  if(raw.fuzzerVersion && raw.fuzzerVersion !== FUZZER_VERSION) {
    console.warn(`[replay] baseline fuzzerVersion=${raw.fuzzerVersion} != ${FUZZER_VERSION} — action registry may drift; consider re-emit`);
  }
  const commands = Array.isArray(raw) ? raw : raw.commands;
  if(!Array.isArray(commands)) throw new Error(`Baseline file does not contain a commands array: ${path}`);
  return commands as Action[];
}
