// @ts-nocheck
/**
 * Minimal CLI flag parser for the fuzzer — no external dep.
 *
 * Supported flags (per spec §10):
 *   --duration=<time>      e.g. 30m, 2h, 90s (default 1h)
 *   --seed=<n>             fixed PRNG seed (default Date.now())
 *   --max-commands=<n>     max actions per iteration (default 120)
 *   --backend=<local|real> relay backend (default local) — Phase 3 flag, parsed but warn if 'real'
 *   --tor                  enable Tor (Phase 3, parsed but warn)
 *   --headed               launch visible browsers
 *   --pairs=<n>            parallel pairs (Phase 3, parsed but warn if > 1)
 *   --replay=<FIND-id>     deterministic replay of a finding
 *   --replay-file=<path>   replay arbitrary trace.json
 *   --smoke-only           run UI contract smoke pass only (Phase 3 — exit early with warn)
 *   --help, -h             print usage and exit
 */

export interface CliOptions {
  durationMs: number;
  seed: number;
  maxCommands: number;
  backend: 'local' | 'real';
  tor: boolean;
  headed: boolean;
  slowMo: number;
  pairs: number;
  replay?: string;
  replayFile?: string;
  smokeOnly: boolean;
  help: boolean;
  emitBaseline: boolean;
  replayBaseline: boolean;
}

const DEFAULTS: CliOptions = {
  durationMs: 3600 * 1000,
  seed: Date.now(),
  maxCommands: 120,
  backend: 'local',
  tor: false,
  headed: false,
  slowMo: 0,
  pairs: 1,
  smokeOnly: false,
  help: false,
  emitBaseline: false,
  replayBaseline: false
};

export function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {...DEFAULTS};
  for(const arg of argv.slice(2)) {
    if(arg === '--help' || arg === '-h') opts.help = true;
    else if(arg === '--tor') opts.tor = true;
    else if(arg === '--headed') opts.headed = true;
    else if(arg === '--smoke-only') opts.smokeOnly = true;
    else if(arg.startsWith('--duration=')) opts.durationMs = parseDuration(arg.slice(11));
    else if(arg.startsWith('--seed=')) opts.seed = Number(arg.slice(7));
    else if(arg.startsWith('--max-commands=')) opts.maxCommands = Number(arg.slice(15));
    else if(arg.startsWith('--backend=')) opts.backend = arg.slice(10) as 'local' | 'real';
    else if(arg.startsWith('--pairs=')) opts.pairs = Number(arg.slice(8));
    else if(arg.startsWith('--slowmo=')) opts.slowMo = Number(arg.slice(9));
    else if(arg === '--emit-baseline') opts.emitBaseline = true;
    else if(arg === '--replay-baseline') opts.replayBaseline = true;
    else if(arg.startsWith('--replay=')) opts.replay = arg.slice(9);
    else if(arg.startsWith('--replay-file=')) opts.replayFile = arg.slice(14);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return opts;
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(ms|s|m|h)?$/);
  if(!m) throw new Error(`Bad duration: ${s}`);
  const n = Number(m[1]);
  const unit = m[2] || 'ms';
  switch(unit) {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 3600 * 1000;
    default: throw new Error(`Unknown unit: ${unit}`);
  }
}

export const HELP_TEXT = `
pnpm fuzz [options]

  --duration=<time>      Run budget (ms, s, m, h). Default 1h.
  --seed=<n>             PRNG seed. Default Date.now().
  --max-commands=<n>     Max actions per iteration. Default 120.
  --backend=<local|real> Relay backend. Default local. (real = Phase 3)
  --tor                  Enable Tor (Phase 3).
  --headed               Visible browsers.
  --slowmo=<ms>          Slow down Playwright actions by N ms (headed debug).
  --pairs=<n>            Parallel pairs (Phase 3). Default 1.
  --replay=<FIND-id>     Deterministic replay of a finding.
  --replay-file=<path>   Replay from a trace.json.
  --emit-baseline        After a clean run, write docs/fuzz-baseline/baseline-seed<seed>.json.
  --replay-baseline      Replay docs/fuzz-baseline/baseline-seed42.json (30s regression check).
  --smoke-only           UI contract smoke only (Phase 3).
  --help, -h             Print this help.

Examples:
  pnpm fuzz
  pnpm fuzz --duration=2h --seed=42
  pnpm fuzz --replay=FIND-a7b3c9d2 --headed
`.trim();
