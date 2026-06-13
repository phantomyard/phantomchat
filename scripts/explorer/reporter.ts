import {mkdirSync, writeFileSync, copyFileSync, existsSync} from 'node:fs';
import {join, basename} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import type {AtomicAction} from './types';
import type {HardFinding} from './oracles/hard';
import {computeSignature, recordSighting, type Sighting} from './signature';

export interface TraceStep {
  step: number;
  intent: string;
  params: Record<string, unknown>;
  atomic_trace: AtomicAction[];
}

export interface ReportInput {
  reportRoot: string;
  kind: 'finding' | 'run' | 'error';
  goal: string;
  trace: TraceStep[];
  finding: HardFinding | null;
  screenshots: {pathOnDisk: string; label: string}[];
  /** Required when kind === 'error' — short summary of why the run failed before producing a finding/run. */
  errorReason?: string;
  /** Required when kind === 'error' — captured stderr / stdout of the driver. */
  errorStderr?: string;
}

export async function writeReport(input: ReportInput): Promise<string> {
  let dir: string;
  if(input.kind === 'finding') {
    if(!input.finding) throw new Error('writeReport: kind=finding requires finding');
    const sigInput = `${input.finding.oracle}:${input.finding.page}:${input.finding.hash}`;
    const findId = createHash('sha1').update(sigInput).digest('hex').slice(0, 8);
    dir = join(input.reportRoot, `FIND-${findId}`);
  } else if(input.kind === 'run') {
    const runId = randomUUID();
    dir = join(input.reportRoot, 'runs', runId);
  } else if(input.kind === 'error') {
    if(!input.errorReason) throw new Error('writeReport: kind=error requires errorReason');
    const errId = randomUUID();
    dir = join(input.reportRoot, 'errors', errId);
  } else {
    throw new Error(`writeReport: unknown kind ${(input as {kind: string}).kind}`);
  }

  mkdirSync(dir, {recursive: true});
  mkdirSync(join(dir, 'screenshots'), {recursive: true});

  // trace.jsonl (always written, may be empty for error)
  writeFileSync(
    join(dir, 'trace.jsonl'),
    input.trace.map((s) => JSON.stringify(s)).join('\n') + (input.trace.length > 0 ? '\n' : ''),
    'utf8'
  );

  // signature.txt + cross-run dedup (only for findings)
  if(input.kind === 'finding' && input.finding) {
    const intentName = pickTriggerIntent(input.trace);
    const area = inferArea(intentName);
    const signature = computeSignature({
      area,
      intent: intentName,
      oracle: `A:${input.finding.oracle}`,
      hash: input.finding.hash
    });
    writeFileSync(join(dir, 'signature.txt'), signature + '\n', 'utf8');
    const findId = basename(dir).replace('FIND-', '');
    const sighting: Sighting = {
      signature,
      findId: `FIND-${findId}`,
      timestamp: new Date().toISOString()
    };
    await recordSighting(join(input.reportRoot, 'seen-signatures.json'), sighting);
  }

  // stderr.log (only for errors)
  if(input.kind === 'error' && input.errorStderr) {
    writeFileSync(join(dir, 'stderr.log'), input.errorStderr, 'utf8');
  }

  // report.md (always)
  writeFileSync(join(dir, 'report.md'), renderMarkdown(input), 'utf8');

  // screenshots
  for(const s of input.screenshots) {
    if(!existsSync(s.pathOnDisk)) continue;
    copyFileSync(s.pathOnDisk, join(dir, 'screenshots', `${s.label}-${basename(s.pathOnDisk)}`));
  }

  return dir;
}

// Walk back through the trace to find the most recent intent that drives state
// (not an observation/probe). LLM-driven traces often append `capture`,
// `run_invariant`, `verify_*` steps after the trigger; using the last entry
// blindly mis-attributes the area (e.g. `open_settings` Oracle-A probe gets
// classified as `navigation` even though the bug fired during a `send_*`).
function pickTriggerIntent(trace: TraceStep[]): string {
  for(let i = trace.length - 1; i >= 0; i--) {
    const intent = trace[i].intent;
    if(!isObservationIntent(intent)) return intent;
  }
  return trace.length > 0 ? trace[trace.length - 1].intent : 'atomic';
}

function isObservationIntent(intent: string): boolean {
  return /^(capture|run_invariant|verify_|act_|diagnostic|probe|observe|inspect|expect_)/i.test(intent);
}

function inferArea(intentName: string): string {
  if(intentName.startsWith('send_') || intentName.startsWith('react_') ||
     intentName.startsWith('edit_own_') || intentName.includes('_random_own_bubble') ||
     intentName === 'reply_to_bubble' || intentName === 'remove_reaction') return 'messaging';
  if(intentName.startsWith('open_') || intentName.startsWith('scroll_') ||
     intentName.startsWith('navigate_')) return 'navigation';
  if(intentName.startsWith('edit_profile') || intentName.includes('avatar') ||
     intentName.includes('lightning') || intentName.includes('relays_nip65')) return 'profile';
  if(intentName.includes('group') || intentName === 'forward_message' || intentName === 'pin_message' ||
     intentName === 'delete_for_everyone' || intentName === 'search_in_chat' || intentName === 'deep_scroll') return 'edge';
  if(intentName.includes('paste') || intentName.includes('drag') || intentName.includes('voice')) return 'media';
  if(intentName.includes('offline') || intentName.includes('relay') || intentName.includes('network')) return 'network';
  if(intentName.includes('theme') || intentName.includes('language')) return 'settings';
  return 'unknown';
}

function renderMarkdown(input: ReportInput): string {
  if(input.kind === 'finding') {
    const head = `# Finding\n\n**Goal**: ${input.goal}\n**Oracle**: ${input.finding!.oracle}\n**Page**: ${input.finding!.page}\n**Message**: \`${input.finding!.message.slice(0, 200)}\`\n`;
    const traceMd = input.trace.map((s) => `${s.step}. \`${s.intent}\` ${JSON.stringify(s.params)}`).join('\n');
    return `${head}\n## Trace\n\n${traceMd}\n`;
  }
  if(input.kind === 'run') {
    const traceMd = input.trace.map((s) => `${s.step}. \`${s.intent}\` ${JSON.stringify(s.params)}`).join('\n');
    return `# Run\n\n**Goal**: ${input.goal}\n**Status**: completed without findings\n\n## Trace\n\n${traceMd}\n`;
  }
  // kind === 'error'
  return `# Error\n\n**Goal**: ${input.goal}\n**Reason**: ${input.errorReason}\n\nSee \`stderr.log\` for the captured driver output.\n`;
}
