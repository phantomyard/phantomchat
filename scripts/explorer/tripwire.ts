/**
 * Stage-4 regex tripwire for the F3 fixer pipeline.
 *
 * Reads a unified diff (e.g. `git diff --staged`) from stdin and exits 1 if
 * any banned pattern appears on an ADDED line in PRODUCTION code (anything
 * under `src/` except `src/tests/**`). Test files are permissive.
 *
 * Banned patterns (spec §5 stage 4):
 *   MessagePort | postMessage | new Promise | .then( | async function
 *   setTimeout | setInterval | requestAnimationFrame | clearTimeout
 *   IndexedDB | StorageKey | getStorage | storage.delete
 *   Worker | SharedWorker | ServiceWorker
 *   relay | subscription | phantomchat-sync | virtual-mtproto
 *
 * Exception: `category=timeout-bump` may modify numeric constants in
 * `src/tests/fuzz/postconditions/` (handled implicitly — that path is already
 * under src/tests/, so it's exempt).
 */

export type FixerCategory = 'ui-cosmetic' | 'i18n' | 'timeout-bump' | 'logic-pure' | 'css-style';

export interface TripwireMatch {
  file: string;
  line: number;
  pattern: string;
  content: string;
}

export interface TripwireResult {
  matches: TripwireMatch[];
}

const BANNED: Array<{name: string; re: RegExp}> = [
  {name: 'MessagePort', re: /\bMessagePort\b/},
  {name: 'postMessage', re: /\bpostMessage\b/},
  {name: 'new Promise', re: /\bnew\s+Promise\b/},
  {name: '.then(', re: /\.then\s*\(/},
  {name: 'async function', re: /\basync\s+function\b/},
  {name: 'setTimeout', re: /\bsetTimeout\b/},
  {name: 'setInterval', re: /\bsetInterval\b/},
  {name: 'requestAnimationFrame', re: /\brequestAnimationFrame\b/},
  {name: 'clearTimeout', re: /\bclearTimeout\b/},
  {name: 'IndexedDB', re: /\bIndexedDB\b/},
  {name: 'StorageKey', re: /\bStorageKey\b/},
  {name: 'getStorage', re: /\bgetStorage\b/},
  {name: 'storage.delete', re: /\bstorage\.delete\b/},
  {name: 'Worker', re: /\bWorker\b/},
  {name: 'SharedWorker', re: /\bSharedWorker\b/},
  {name: 'ServiceWorker', re: /\bServiceWorker\b/},
  {name: 'relay', re: /\brelay\b/},
  {name: 'subscription', re: /\bsubscription\b/},
  {name: 'phantomchat-sync', re: /\bphantomchat-sync\b/},
  {name: 'virtual-mtproto', re: /\bvirtual-mtproto\b/}
];

function isProductionFile(path: string): boolean {
  if(!path.startsWith('src/')) return false;
  if(path.startsWith('src/tests/')) return false;
  return true;
}

export function checkDiff(diff: string): TripwireResult {
  const matches: TripwireMatch[] = [];
  let currentFile = '';
  let lineNo = 0;

  const lines = diff.split('\n');
  for(const line of lines) {
    if(line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length).trim();
      lineNo = 0;
      continue;
    }
    if(line.startsWith('+++ /dev/null') || line.startsWith('--- ')) continue;
    if(line.startsWith('@@')) {
      const m = line.match(/\+([0-9]+)/);
      if(m) lineNo = parseInt(m[1], 10) - 1;
      continue;
    }
    if(line.startsWith('+++')) continue;
    if(line.startsWith('+') && !line.startsWith('+++')) {
      lineNo += 1;
      if(!currentFile || !isProductionFile(currentFile)) continue;
      const content = line.slice(1);
      for(const {name, re} of BANNED) {
        if(re.test(content)) {
          matches.push({file: currentFile, line: lineNo, pattern: name, content: content.trim()});
        }
      }
      continue;
    }
    if(line.startsWith(' ')) {
      lineNo += 1;
      continue;
    }
    // '-' line, '\' (no newline marker), or diff header — no line increment
  }

  return {matches};
}

async function readStdin(): Promise<string> {
  const parts: string[] = [];
  process.stdin.setEncoding('utf8');
  for await(const chunk of process.stdin) {
    parts.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));
  }
  return parts.join('');
}

function isMain(): boolean {
  if(typeof process === 'undefined' || !process.argv[1]) return false;
  const arg1 = process.argv[1];
  return arg1.endsWith('tripwire.ts') || arg1.endsWith('tripwire.js') || arg1.endsWith('/tripwire');
}

if(isMain()) {
  void (async() => {
    const diff = await readStdin();
    const result = checkDiff(diff);
    if(result.matches.length === 0) {
      process.stderr.write('[tripwire] clean\n');
      process.exit(0);
    }
    process.stderr.write(`[tripwire] ${result.matches.length} banned pattern(s) matched:\n`);
    for(const m of result.matches) {
      process.stderr.write(`  ${m.file}:${m.line}  pattern=${m.pattern}  +${m.content}\n`);
    }
    process.exit(1);
  })();
}
