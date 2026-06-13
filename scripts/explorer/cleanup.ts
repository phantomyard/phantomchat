/**
 * `pnpm explorer:cleanup-worktrees` — removes obsolete `explorer/fix-FIND-*` worktrees.
 *
 * A worktree is "obsolete" when:
 *   - its associated branch's PR is closed/merged on GitHub, OR
 *   - the branch has no upstream (push never succeeded), OR
 *   - the user passes --force, removing every worktree under ../phantomchat.chat-explorer/
 *
 * Run from the main repo. Safe by default: prints what it would do, then
 * removes only after confirmation (skip with --yes).
 */

import {execSync} from 'node:child_process';
import {existsSync, readdirSync, statSync} from 'node:fs';
import {resolve, dirname, basename} from 'node:path';

interface WorktreeRow {
  path: string;
  branch: string | null;
}

function listExplorerWorktrees(repoRoot: string): WorktreeRow[] {
  const out = execSync('git worktree list --porcelain', {cwd: repoRoot, encoding: 'utf8'});
  const rows: WorktreeRow[] = [];
  let cur: Partial<WorktreeRow> = {};
  for(const line of out.split('\n')) {
    if(line.startsWith('worktree ')) {
      if(cur.path) rows.push({path: cur.path, branch: cur.branch ?? null});
      cur = {path: line.slice('worktree '.length).trim()};
    } else if(line.startsWith('branch refs/heads/')) {
      cur.branch = line.slice('branch refs/heads/'.length).trim();
    }
  }
  if(cur.path) rows.push({path: cur.path, branch: cur.branch ?? null});
  return rows.filter((r) => r.branch?.startsWith('explorer/fix-') ?? false);
}

function ghAvailable(): boolean {
  try {
    execSync('gh auth status', {stdio: 'pipe'});
    return true;
  } catch {
    return false;
  }
}

function prStateForBranch(branch: string): 'open' | 'closed' | 'merged' | 'none' {
  try {
    const out = execSync(`gh pr list --state all --head ${branch} --json state --jq '.[0].state // "none"'`, {encoding: 'utf8'});
    const state = out.trim().toLowerCase();
    if(state === 'open' || state === 'closed' || state === 'merged') return state;
    return 'none';
  } catch {
    return 'none';
  }
}

function removeWorktree(repoRoot: string, path: string, branch: string | null): void {
  console.log(`[cleanup] removing ${path} (branch=${branch ?? 'detached'})`);
  execSync(`git worktree remove --force "${path}"`, {cwd: repoRoot, stdio: 'inherit'});
  if(branch) {
    try {
      execSync(`git branch -D "${branch}"`, {cwd: repoRoot, stdio: 'pipe'});
    } catch {
      // branch may already be gone; ignore
    }
  }
}

function pickRepoRoot(): string {
  return execSync('git rev-parse --show-toplevel', {encoding: 'utf8'}).trim();
}

function main(): void {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const yes = args.includes('--yes') || args.includes('-y');

  const repoRoot = pickRepoRoot();
  const explorerParent = resolve(dirname(repoRoot), 'phantomchat.chat-explorer');

  const worktrees = listExplorerWorktrees(repoRoot);
  if(worktrees.length === 0) {
    console.log('[cleanup] no explorer/fix-* worktrees found — nothing to do');
    return;
  }

  const gh = ghAvailable();
  if(!gh && !force) {
    console.log('[cleanup] gh not authed — cannot determine PR state. Re-run with --force to remove all explorer worktrees regardless.');
    process.exit(2);
  }

  const candidates: WorktreeRow[] = [];
  for(const w of worktrees) {
    if(force) {
      candidates.push(w);
      continue;
    }
    if(!w.branch) {
      candidates.push(w);
      continue;
    }
    const state = prStateForBranch(w.branch);
    if(state === 'merged' || state === 'closed' || state === 'none') {
      candidates.push(w);
      continue;
    }
    console.log(`[cleanup] keeping ${w.path} — PR state=${state}`);
  }

  if(candidates.length === 0) {
    console.log('[cleanup] no obsolete worktrees — all PRs still open. Done.');
    return;
  }

  console.log(`[cleanup] ${candidates.length} worktree(s) marked for removal:`);
  for(const c of candidates) console.log(`  - ${c.path}  (branch=${c.branch ?? 'detached'})`);

  if(!yes) {
    console.log('\nRe-run with --yes to actually remove. (No changes made.)');
    return;
  }

  for(const c of candidates) removeWorktree(repoRoot, c.path, c.branch);

  // Best-effort: remove the parent dir if empty
  if(existsSync(explorerParent)) {
    try {
      const remaining = readdirSync(explorerParent).filter((n) => statSync(resolve(explorerParent, n)).isDirectory());
      if(remaining.length === 0) {
        execSync(`rmdir "${explorerParent}"`, {stdio: 'pipe'});
        console.log(`[cleanup] removed empty parent ${explorerParent}`);
      }
    } catch {
      // ignore
    }
  }

  console.log('[cleanup] done');
}

function isMain(): boolean {
  if(typeof process === 'undefined' || !process.argv[1]) return false;
  return basename(process.argv[1]).startsWith('cleanup');
}

if(isMain()) main();
