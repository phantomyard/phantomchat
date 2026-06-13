/**
 * `pnpm exec tsx mark-status.ts <action> <storePath> <signature> [args...]`
 *
 * Thin CLI over signature.ts status helpers — used by the F3 nostra-fixer
 * subagent. We can't reliably call the helpers via `tsx -e "import().then()"`
 * because tsx eval-mode wraps modules in CJS and named exports don't splat
 * onto the imported namespace. Wrapping in a script is simpler and matches
 * the rest of the explorer scripts (replay.ts, cleanup.ts).
 *
 * Actions:
 *   report-only   <store> <signature> <reason>
 *   fix-pr-open   <store> <signature> <fix_pr_url> <fix_branch>
 *   fixed         <store> <signature>
 */

import {markReportOnly, markFixPrOpen, markFixed} from './signature';

async function main(): Promise<void> {
  const [, , action, storePath, signature, ...rest] = process.argv;
  if(!action || !storePath || !signature) {
    process.stderr.write('usage: mark-status.ts <action> <storePath> <signature> [...args]\n');
    process.exit(2);
  }

  if(action === 'report-only') {
    const reason = rest[0];
    if(!reason) throw new Error('report-only: missing reason');
    const r = await markReportOnly(storePath, signature, reason);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }

  if(action === 'fix-pr-open') {
    const [fixPr, fixBranch] = rest;
    if(!fixPr || !fixBranch) throw new Error('fix-pr-open: missing fixPr or fixBranch');
    const r = await markFixPrOpen(storePath, signature, {fixPr, fixBranch});
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }

  if(action === 'fixed') {
    const r = await markFixed(storePath, signature);
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }

  process.stderr.write(`unknown action: ${action}\n`);
  process.exit(2);
}

void main();
