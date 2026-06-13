// @ts-nocheck
import {createHash} from 'crypto';
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'fs';
import {join, dirname} from 'path';
import lockfile from 'proper-lockfile';
import type {ReportEntry, FailureDetails, Action, FuzzContext} from './types';

const FINDINGS_PATH = 'docs/FUZZ-FINDINGS.md';
const ARTIFACTS_ROOT = 'docs/fuzz-reports';

/**
 * Normalise a failure message before hashing so the same logical bug collapses
 * to the same signature across runs. Strips known volatile tokens:
 *   - timing prefixes "[0.044]" / "[12.7]" from Nostra's logger
 *   - numeric suffixes like " in 67.2s" or ": 5 attempts"
 *   - hex ids matching common shapes (npub1…, event ids, mids)
 * This is deliberately conservative — over-normalising different bugs into the
 * same signature is worse than splitting one bug across two. Extend only when
 * a noise pattern is observed to produce divergent signatures in practice.
 */
function normaliseForSignature(message: string): string {
  // Order matters: mid= and npub1 first so their digits/chars are collapsed
  // before the broader HEX sweep. HEX last so it doesn't swallow already-
  // labeled tokens.
  return message
    .replace(/\[\d+(?:\.\d+)?\]/g, '[T]')            // "[0.044]", "[12]" → "[T]"
    .replace(/\bmid=[\d.]+/g, 'mid=N')               // mid=1712345678 or mid=0.0002 → mid=N
    .replace(/\bnpub1[0-9a-z]{10,}/g, 'npub1X')     // full npub → "npub1X"
    .replace(/\b\d+\.\d+s\b/g, 'Ns')                 // "67.2s" → "Ns"
    .replace(/\b[0-9a-f]{16,}\b/gi, 'HEX')           // 16+ hex char run (eventId, rumor id)
    // Collapse any non-ASCII char (emojis, CJK, etc.) to a single marker so
    // e.g. `reaction 🔥` and `reaction 👍` dedup to the same bug when the
    // rest of the message is identical.
    .replace(/[^\x00-\x7F]+/g, 'U');
}

export function computeSignature(input: {invariantId: string; message: string; stackTopFrame?: string}): string {
  // stackTopFrame is accepted for forward compatibility with Phase 3 (where
  // stack capture becomes cross-worker) but is NOT included in the Phase 1
  // hash — it's never populated by the current throw sites, so including it
  // would add zero entropy while making signatures depend on whether the
  // caller bothered to pass the field.
  const h = createHash('sha256');
  h.update(input.invariantId);
  h.update('\0');
  h.update(normaliseForSignature(input.message).slice(0, 200));
  return h.digest('hex').slice(0, 8);
}

export function renderFindingsMarkdown(entries: ReportEntry[]): string {
  const open = entries.filter((e) => e.status === 'open').sort((a, b) => b.occurrences - a.occurrences);
  const fixed = entries.filter((e) => e.status === 'fixed');
  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines: string[] = [];
  lines.push('# Fuzz Findings');
  lines.push('');
  lines.push(`Last updated: ${nowIso}`);
  lines.push(`Open bugs: ${open.length} · Fixed: ${fixed.length}`);
  lines.push('');
  lines.push('## Open (sorted by occurrences desc)');
  lines.push('');
  for(const e of open) lines.push(...renderEntry(e));
  if(fixed.length > 0) {
    lines.push('## Fixed');
    lines.push('');
    for(const e of fixed) lines.push(...renderEntry(e));
  }
  return lines.join('\n') + '\n';
}

function renderEntry(e: ReportEntry): string[] {
  const lines: string[] = [];
  lines.push(`### FIND-${e.signature} — ${e.invariantId}`);
  lines.push(`- **Status**: ${e.status}${e.fixedCommit ? ` (commit ${e.fixedCommit})` : ''}`);
  lines.push(`- **Tier**: ${e.tier}`);
  lines.push(`- **Occurrences**: ${e.occurrences}`);
  lines.push(`- **First seen**: ${e.firstSeen}`);
  lines.push(`- **Last seen**: ${e.lastSeen}`);
  lines.push(`- **Seed**: ${e.seed}`);
  lines.push(`- **Assertion**: ${JSON.stringify(e.assertion)}`);
  lines.push(`- **Replay**: \`pnpm fuzz --replay=FIND-${e.signature}\``);
  lines.push(`- **Minimal trace** (${e.minimalTrace.length} actions):`);
  e.minimalTrace.forEach((a, i) => lines.push(`  ${i + 1}. \`${a.name}(${JSON.stringify(a.args)})\``));
  lines.push(`- **Artifacts**: [\`docs/fuzz-reports/FIND-${e.signature}/\`](../fuzz-reports/FIND-${e.signature}/)`);
  lines.push('');
  return lines;
}

const ENTRY_HEADER_RE = /^### FIND-([0-9a-f]{8}) — (.+)$/;

export function parseFindingsMarkdown(md: string): ReportEntry[] {
  const entries: ReportEntry[] = [];
  const lines = md.split('\n');
  let current: Partial<ReportEntry> | null = null;
  const traces: string[] = [];
  for(const line of lines) {
    const m = ENTRY_HEADER_RE.exec(line);
    if(m) {
      if(current && current.signature) {
        current.minimalTrace = parseTrace(traces);
        entries.push(current as ReportEntry);
      }
      current = {signature: m[1], invariantId: m[2], minimalTrace: [], status: 'open', occurrences: 0};
      traces.length = 0;
      continue;
    }
    if(!current) continue;
    if(line.startsWith('- **Status**:')) {
      current.status = line.includes('fixed') ? 'fixed' : 'open';
    } else if(line.startsWith('- **Tier**:')) {
      current.tier = line.split(':')[1].trim() as any;
    } else if(line.startsWith('- **Occurrences**:')) {
      current.occurrences = Number(line.split(':')[1].trim());
    } else if(line.startsWith('- **First seen**:')) {
      current.firstSeen = line.replace('- **First seen**:', '').trim();
    } else if(line.startsWith('- **Last seen**:')) {
      current.lastSeen = line.replace('- **Last seen**:', '').trim();
    } else if(line.startsWith('- **Seed**:')) {
      current.seed = Number(line.split(':')[1].trim());
    } else if(line.startsWith('- **Assertion**:')) {
      // Assertions are rendered by `renderEntry` as JSON.stringify(...), i.e.
      // `- **Assertion**: "..."`. Human curation sometimes wraps the JSON
      // string in MD code-span backticks (`"..."`), which is benign in
      // rendered markdown but breaks JSON.parse. Strip optional surrounding
      // backticks first; if the resulting token is still not JSON (e.g. a
      // hand-written plain sentence), fall back to the raw string so the
      // outer parse can progress and preserve the entry for merge.
      const rawAssertion = line.replace('- **Assertion**:', '').trim().replace(/^`|`$/g, '');
      try{ current.assertion = JSON.parse(rawAssertion); } catch{ current.assertion = rawAssertion; }
    } else if(/^\s+\d+\. /.test(line)) {
      traces.push(line);
    }
  }
  if(current && current.signature) {
    current.minimalTrace = parseTrace(traces);
    entries.push(current as ReportEntry);
  }
  return entries;
}

function parseTrace(lines: string[]): Action[] {
  const out: Action[] = [];
  for(const l of lines) {
    const m = /^\s+\d+\. `([^(]+)\((.+)\)`\s*$/.exec(l);
    if(!m) continue;
    try{ out.push({name: m[1], args: JSON.parse(m[2])}); } catch{}
  }
  return out;
}

const DEFAULT_PRELUDE = [
  '# Fuzz Findings',
  '',
  '## Open (sorted by occurrences desc)',
  '',
  ''
].join('\n');

export interface FindingsZones {
  prelude: string;
  openEntries: ReportEntry[];
  postlude: string;
}

export function splitFindingsZones(md: string): FindingsZones {
  if(md.trim().length === 0) {
    return {prelude: DEFAULT_PRELUDE, openEntries: [], postlude: ''};
  }
  const openHeadingRe = /^##\s+Open\b.*$/m;
  const openMatch = openHeadingRe.exec(md);
  if(!openMatch) {
    return {prelude: md, openEntries: [], postlude: ''};
  }
  const openStartIdx = openMatch.index + openMatch[0].length;
  const fixedHeadingRe = /^##\s+Fixed\b.*$/m;
  const openBodyAndMore = md.slice(openStartIdx);
  const fixedMatch = fixedHeadingRe.exec(openBodyAndMore);
  let openBody: string;
  let postlude: string;
  if(fixedMatch) {
    openBody = openBodyAndMore.slice(0, fixedMatch.index);
    postlude = openBodyAndMore.slice(fixedMatch.index);
  } else {
    openBody = openBodyAndMore;
    postlude = '';
  }
  // Ensure prelude ends with a newline so rendered Open entries don't collide
  // with the `## Open …` heading text.
  const prelude = md.slice(0, openStartIdx) + '\n';
  const openEntries = parseFindingsMarkdown(openBody);
  return {prelude, openEntries, postlude};
}

export interface IncomingFinding {
  signature: string;
  invariantId: string;
  tier: ReportEntry['tier'];
  assertion: string;
  seed: number;
  minimalTrace: Action[];
}

export function mergeFindings(
  existingOpen: ReportEntry[],
  incoming: IncomingFinding[],
  fixedSignatures: Set<string>,
  now: string
): ReportEntry[] {
  const byId = new Map<string, ReportEntry>();
  for(const e of existingOpen) byId.set(e.signature, e);
  for(const f of incoming) {
    if(fixedSignatures.has(f.signature)) continue;
    const prev = byId.get(f.signature);
    if(prev) {
      prev.occurrences += 1;
      prev.lastSeen = now;
    } else {
      byId.set(f.signature, {
        signature: f.signature,
        invariantId: f.invariantId,
        tier: f.tier,
        assertion: f.assertion,
        occurrences: 1,
        firstSeen: now,
        lastSeen: now,
        seed: f.seed,
        minimalTrace: f.minimalTrace,
        status: 'open'
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.occurrences - a.occurrences);
}

export function parseFixedSignatures(postlude: string): Set<string> {
  const out = new Set<string>();
  const re = /(?:^|\n)(?:####?)\s+FIND-([0-9a-f]{8})\b/g;
  let m: RegExpExecArray | null;
  while((m = re.exec(postlude)) !== null) out.add(m[1]);
  return out;
}

export function writeFindingsMarkdownPure(
  existing: string,
  incoming: IncomingFinding[],
  now: string
): string {
  const {prelude, openEntries, postlude} = splitFindingsZones(existing);
  const fixedSigs = parseFixedSignatures(postlude);
  const merged = mergeFindings(openEntries, incoming, fixedSigs, now);
  const openRendered = merged.flatMap(renderEntry).join('\n');
  const openBlock = openRendered.length > 0 ? openRendered + '\n' : '';
  return prelude + openBlock + postlude;
}

export async function recordFinding(
  f: FailureDetails,
  minimalTrace: Action[],
  seed: number,
  ctx?: FuzzContext
): Promise<{signature: string; isNew: boolean}> {
  const signature = computeSignature({
    invariantId: f.invariantId,
    message: f.message,
    stackTopFrame: f.stackTopFrame
  });
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  mkdirSync(dirname(FINDINGS_PATH), {recursive: true});
  if(!existsSync(FINDINGS_PATH)) writeFileSync(FINDINGS_PATH, '# Fuzz Findings\n\n## Open\n\n', 'utf8');

  const release = await lockfile.lock(FINDINGS_PATH, {retries: 5, stale: 10_000});
  try{
    const md = existsSync(FINDINGS_PATH) ? readFileSync(FINDINGS_PATH, 'utf8') : '';
    const {openEntries} = splitFindingsZones(md);
    const existing = openEntries.find((e) => e.signature === signature);
    const isNew = !existing;
    const incoming: IncomingFinding = {
      signature,
      invariantId: f.invariantId,
      tier: f.tier,
      assertion: f.message,
      seed,
      minimalTrace
    };
    const nextMd = writeFindingsMarkdownPure(md, [incoming], now);
    writeFileSync(FINDINGS_PATH, nextMd, 'utf8');
    if(isNew && ctx) await writeArtifacts(signature, f, minimalTrace, seed, ctx);
    return {signature, isNew};
  } finally {
    await release();
  }
}

async function writeArtifacts(
  sig: string,
  f: FailureDetails,
  trace: Action[],
  seed: number,
  ctx: FuzzContext
): Promise<void> {
  const dir = join(ARTIFACTS_ROOT, `FIND-${sig}`);
  mkdirSync(dir, {recursive: true});
  try{
    await ctx.users.userA.page.screenshot({path: join(dir, 'screenshot-A.png'), fullPage: true});
    await ctx.users.userB.page.screenshot({path: join(dir, 'screenshot-B.png'), fullPage: true});
  } catch{}
  try{
    const domA = await ctx.users.userA.page.evaluate(() => document.documentElement.outerHTML);
    const domB = await ctx.users.userB.page.evaluate(() => document.documentElement.outerHTML);
    writeFileSync(join(dir, 'dom-A.html'), domA, 'utf8');
    writeFileSync(join(dir, 'dom-B.html'), domB, 'utf8');
  } catch{}
  writeFileSync(join(dir, 'console.log'),
    `## userA\n${ctx.users.userA.consoleLog.join('\n')}\n\n## userB\n${ctx.users.userB.consoleLog.join('\n')}`,
    'utf8'
  );
  writeFileSync(join(dir, 'trace.json'), JSON.stringify({seed, backend: 'local', commands: trace}, null, 2), 'utf8');
  writeFileSync(join(dir, 'failure.json'), JSON.stringify(f, null, 2), 'utf8');
}
