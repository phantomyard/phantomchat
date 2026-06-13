import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {bootHarness} from '../../src/tests/fuzz/harness';
import {registry} from './intents/registry';
import type {TraceStep} from './reporter';

export function parseTraceFile(path: string): TraceStep[] {
  const raw = readFileSync(path, 'utf8');
  return raw
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l) as TraceStep);
}

async function main() {
  const target = process.argv[2];
  if(!target) {
    console.error('Usage: pnpm explorer:replay <FIND-id-or-run-id-or-trace-path>');
    process.exit(2);
  }

  let tracePath: string;
  if(existsSync(target)) {
    tracePath = target;
  } else {
    const findDir = join('docs/explorer-reports', target);
    const runDir = join('docs/explorer-reports/runs', target);
    if(existsSync(join(findDir, 'trace.jsonl'))) tracePath = join(findDir, 'trace.jsonl');
    else if(existsSync(join(runDir, 'trace.jsonl'))) tracePath = join(runDir, 'trace.jsonl');
    else {
      console.error(`could not find trace.jsonl at ${findDir} or ${runDir}`);
      process.exit(2);
    }
  }

  const steps = parseTraceFile(tracePath);
  console.log(`[replay] ${steps.length} step(s) from ${tracePath}`);

  const harness = await bootHarness({headed: false});
  try {
    for(const step of steps) {
      console.log(`[replay] step ${step.step}: ${step.intent} ${JSON.stringify(step.params)}`);
      const def = registry[step.intent];
      if(!def) {
        // LLM-driven traces emit observation/probe intents (capture, run_invariant,
        // verify_expectation_oracle_b, diagnostic, act_*) that aren't catalog
        // intents. Skip them — they don't drive state, only observe it.
        console.warn(`[replay] skipping unknown intent ${step.intent} (observation-only)`);
        continue;
      }
      const parsed = def.paramsSchema.safeParse(step.params);
      if(!parsed.success) {
        // LLM-driven traces sometimes reuse a registered intent name as the
        // wrapper for an observation/probe step (e.g. `edit_profile_field`
        // with `{goal_check: ..., text_contains: ...}` instead of the real
        // `{user, field, value}` schema). Detect those by their hallmark
        // observation keys and skip — they don't drive state.
        const paramKeys = Object.keys(step.params ?? {});
        const isPseudoStep = paramKeys.some((k) => /^(goal_check|text_contains|probe|verify_|observe|inspect|expect_)/i.test(k));
        if(isPseudoStep) {
          console.warn(`[replay] skipping pseudo-step ${step.intent} (observation keys: ${paramKeys.join(',')})`);
          continue;
        }
        console.error(`[replay] invalid params for ${step.intent}: ${parsed.error.message}`);
        process.exit(3);
      }
      const result = await def.exec(parsed.data, harness.ctx);
      if(!result.ok) {
        console.error(`[replay] step ${step.step} failed: ${result.error ?? 'no error message'}`);
        process.exit(4);
      }
    }
    console.log('[replay] all steps replayed successfully');
  } finally {
    await harness.teardown();
  }
}

if(process.argv[1] && process.argv[1].endsWith('replay.ts')) {
  main().catch((err) => {console.error('[replay] fatal:', err); process.exit(1);});
}
