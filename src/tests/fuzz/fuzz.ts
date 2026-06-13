// @ts-nocheck
import * as fc from 'fast-check';
import {parseCli, HELP_TEXT} from './cli';
import {bootHarness, type HarnessOptions} from './harness';
import {actionArb, findAction} from './actions';
import {runTier, runEndOfSequence, runEndOfRun} from './invariants';
import {runPostconditions} from './postconditions';
import {recordFinding} from './reporter';
import {replayFinding, replayFile, replayBaseline} from './replay';
import {FUZZER_VERSION} from './version';
import type {Action, FuzzContext, FailureDetails} from './types';

/**
 * Cross-iteration channel: runSequence sets these when an invariant fires so
 * the outer loop can record the finding + capture artifacts from the still-live
 * browser pair. Scoped per iteration (reset at top of the while body). Phase 3
 * parallel pairs will replace module-level refs with per-worker channels.
 */
let lastFailure: FailureDetails | null = null;
let lastContext: FuzzContext | null = null;
let lastTeardown: (() => Promise<void>) | null = null;
let lastFailedActionIndex = -1;

async function main() {
  const opts = parseCli(process.argv);
  if(opts.help) {console.log(HELP_TEXT); return;}

  if(opts.backend === 'real' || opts.tor || opts.pairs > 1 || opts.smokeOnly) {
    console.error('[fuzz] Phase 3 flags (--backend=real, --tor, --pairs>1, --smoke-only) are not supported in MVP.');
    process.exit(2);
  }

  const harnessOpts: HarnessOptions = {headed: opts.headed, slowMo: opts.slowMo};

  if(opts.replay || opts.replayFile) {
    const trace = opts.replay
      ? await replayFinding(opts.replay)
      : await replayFile(opts.replayFile!);
    await runReplay(trace, harnessOpts);
    return;
  }

  if(opts.replayBaseline) {
    const trace = await replayBaseline();
    await runReplay(trace, harnessOpts);
    return;
  }

  console.log(`[fuzz] seed=${opts.seed} duration=${opts.durationMs}ms maxCommands=${opts.maxCommands}`);
  const deadline = Date.now() + opts.durationMs;
  let iterations = 0;
  let findings = 0;
  let lastCleanActions: Action[] = [];

  while(Date.now() < deadline) {
    iterations++;
    const iterSeed = opts.seed + iterations;
    console.log(`[fuzz] iteration ${iterations} seed=${iterSeed}`);
    lastFailure = null;
    lastContext = null;
    lastTeardown = null;
    lastFailedActionIndex = -1;

    // Sample a deterministic action sequence from the seed. No shrinking: a
    // failing sequence is reported as-is, truncated to the step that failed.
    // Phase 3 may add a dedicated --shrink mode that re-runs with fast-check's
    // Property API to minimise a trace across multiple runs.
    const actions = fc.sample(
      fc.array(actionArb, {minLength: 1, maxLength: opts.maxCommands}),
      {seed: iterSeed, numRuns: 1}
    )[0] as Action[];

    try{
      await runSequence(actions, harnessOpts);
    } catch(err: any) {
      if(!lastFailure) {
        console.error('[fuzz] iteration errored without invariant failure:', err?.message || err);
        if(lastTeardown) await lastTeardown().catch(() => {});
        continue;
      }
    }

    if(lastFailure) {
      findings++;
      const minimalTrace = lastFailedActionIndex >= 0
        ? actions.slice(0, lastFailedActionIndex + 1)
        : actions;
      const {signature, isNew} = await recordFinding(lastFailure, minimalTrace, iterSeed, lastContext || undefined);
      console.log(`[fuzz] FIND-${signature} (${lastFailure.invariantId}) ${isNew ? 'NEW' : 'dup'}`);
      // Artifact capture done — now release the context we kept alive for it.
      if(lastTeardown) await lastTeardown().catch(() => {});
    } else {
      // Track the LONGEST clean iteration so --emit-baseline captures a
      // representative trace, not whichever short sequence happened to run
      // last. Count non-skipped actions — skipped ones are no-ops and
      // shouldn't bias selection.
      const effective = actions.filter((a) => !a.skipped).length;
      const prev = lastCleanActions.filter((a) => !a.skipped).length;
      if(effective > prev) lastCleanActions = actions;
    }
  }

  // End-of-run regression tier — one last sweep over relay/IDB state.
  if(lastContext) {
    const regr = await runEndOfRun(lastContext);
    if(regr) {
      findings++;
      await recordFinding(regr, [], opts.seed, lastContext);
      console.log(`[fuzz] END-OF-RUN REGR FIND: ${regr.invariantId}`);
    }
  }

  if(opts.emitBaseline && findings === 0 && lastCleanActions.length) {
    const {writeFileSync, mkdirSync, existsSync} = await import('fs');
    const baseline = {
      seed: opts.seed,
      backend: 'local',
      maxCommands: opts.maxCommands,
      commands: lastCleanActions,
      emittedAt: new Date().toISOString(),
      fuzzerVersion: FUZZER_VERSION
    };
    if(!existsSync('docs/fuzz-baseline')) mkdirSync('docs/fuzz-baseline', {recursive: true});
    const path = `docs/fuzz-baseline/baseline-seed${opts.seed}-${FUZZER_VERSION.replace(/^phase/, 'v')}.json`;
    writeFileSync(path, JSON.stringify(baseline, null, 2));
    console.log(`[fuzz] baseline emitted → ${path} (${lastCleanActions.length} actions)`);
  } else if(opts.emitBaseline) {
    console.warn(`[fuzz] --emit-baseline skipped: findings=${findings} cleanActions=${lastCleanActions.length}`);
  }

  console.log(`[fuzz] done. iterations=${iterations} findings=${findings}`);
}

/**
 * Runs ONE command sequence on a fresh harness. On invariant failure, stashes
 * details + context in module refs and throws. The finally block tears down
 * IFF no failure was captured for this context (so artifact capture can still
 * happen against the live browser). The outer loop tears down after recording.
 */
async function runSequence(actions: Action[], harnessOpts: HarnessOptions): Promise<void> {
  const {ctx, teardown} = await bootHarness(harnessOpts);
  // Clear each user's console buffer AFTER the boot + onboarding + linkContacts
  // sequence so INV-console-clean only flags messages produced by fuzz actions.
  // Startup noise (WASM preload hints, MP-CRYPTO init, IDB schema upgrade,
  // SolidJS dev warnings about initial reactive roots) is not a regression we
  // want the fuzzer chasing — each boot phase has its own warnings and the
  // fuzzer's job is to find bugs in the ACTION phase, not at startup. Actions
  // that appear reload/login-like (reloadPage, logout, resetLocalData — Phase
  // 3) will need to clear again or extend their own warmup window.
  ctx.users.userA.consoleLog.length = 0;
  ctx.users.userB.consoleLog.length = 0;
  try{
    for(let i = 0; i < actions.length; i++) {
      ctx.actionIndex = i;
      const spec = findAction(actions[i].name);
      console.log(`[runseq] action ${i + 1}/${actions.length}: ${actions[i].name}(${JSON.stringify(actions[i].args).slice(0, 80)})`);
      const executed = await spec.drive(ctx, actions[i]);
      actions[i] = executed;
      if(executed.skipped) console.log(`[runseq] action ${i + 1}: skipped`);

      const postFail = await runPostconditions(ctx, executed);
      if(postFail) {
        console.log(`[runseq] POST FAIL ${postFail.invariantId}: ${postFail.message.slice(0, 200)}`);
        lastFailure = postFail; lastContext = ctx; lastTeardown = teardown; lastFailedActionIndex = i;
        throw new Error(postFail.message);
      }

      const cheap = await runTier('cheap', ctx, executed);
      if(cheap) {
        console.log(`[runseq] INV FAIL ${cheap.invariantId}: ${cheap.message.slice(0, 200)}`);
        lastFailure = cheap; lastContext = ctx; lastTeardown = teardown; lastFailedActionIndex = i;
        throw new Error(cheap.message);
      }

      const med = await runTier('medium', ctx, executed);
      if(med) {
        console.log(`[runseq] MED INV FAIL ${med.invariantId}: ${med.message.slice(0, 200)}`);
        lastFailure = med; lastContext = ctx; lastTeardown = teardown; lastFailedActionIndex = i;
        throw new Error(med.message);
      }
      console.log(`[runseq] action ${i + 1}: OK`);
    }

    // End-of-sequence regression tier
    const regr = await runEndOfSequence(ctx, actions[actions.length - 1]);
    if(regr) {
      console.log(`[runseq] END-OF-SEQ REGR FAIL ${regr.invariantId}: ${regr.message.slice(0, 200)}`);
      lastFailure = regr; lastContext = ctx; lastTeardown = teardown; lastFailedActionIndex = actions.length - 1;
      throw new Error(regr.message);
    }
  } finally {
    // Teardown here ONLY when no failure was captured against this context.
    // When a failure is captured, the outer loop owns teardown so artifacts
    // can be snapshotted against a live browser first.
    if(!lastFailure || lastContext !== ctx) await teardown();
  }
}

async function runReplay(trace: Action[], harnessOpts: HarnessOptions): Promise<void> {
  console.log(`[fuzz] REPLAY ${trace.length} actions`);
  const {ctx, teardown} = await bootHarness(harnessOpts);
  try{
    for(let i = 0; i < trace.length; i++) {
      ctx.actionIndex = i;
      const spec = findAction(trace[i].name);
      const executed = await spec.drive(ctx, trace[i]);
      trace[i] = executed;
      const postFail = await runPostconditions(ctx, executed);
      if(postFail) {console.error('[replay] POSTCONDITION FAIL:', postFail); return;}
      const cheap = await runTier('cheap', ctx, executed);
      if(cheap) {console.error('[replay] INVARIANT FAIL:', cheap); return;}
    }
    console.log('[replay] all steps passed — bug not reproduced');
  } finally {
    await teardown();
  }
}

main().catch((err) => {
  console.error('[fuzz] fatal:', err);
  process.exit(1);
});
