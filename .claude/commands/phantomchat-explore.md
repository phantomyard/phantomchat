---
description: Run the autonomous agentic explorer for phantomchat.chat (F2c + F3 fixer)
---

You're the orchestrator for `/phantomchat-explore`. The user invoked it with `$ARGUMENTS`.

# Argument parsing

`$ARGUMENTS` may contain a free-form goal AND/OR the flag `--no-fix`. Strip the flag from the goal:

- If `$ARGUMENTS` contains `--no-fix` (case-insensitive, surrounded by spaces or at start/end): set `$NO_FIX=true` and remove the token from the goal.
- Otherwise: `$NO_FIX=false`.

Then compute `$GOAL`:
- If the cleaned argument string is non-empty: `$GOAL = <cleaned arg>` (explicit goal A mode)
- Else: `$GOAL = "<autonomous>"` (autonomous goal D mode)

# Steps

## 1. Verify dev server

Run `curl -sI http://localhost:8080 | head -1`. If not `200`, instruct user to run `pnpm start`. Do NOT suggest `pnpm preview` — preview's SPA fallback breaks the harness's dynamic TS imports.

## 2. Dispatch the explorer

Dispatch the `phantomchat-explorer` subagent (custom subagent at `.claude/agents/phantomchat-explorer.md`) via the Agent tool with prompt:

```
$GOAL=<computed goal>
$BUDGET_MS=1800000
$BUDGET_STEPS=120
```

The subagent's frontmatter + body contain all instructions; just pass these inputs. Wait for its `RESULT:` block.

## 3. Relay the explorer's RESULT

Relay the explorer's `RESULT:` summary to the user verbatim. Then route on its verdict.

## 4a. Verdict: CLEAN — done

Just relay. No fixer. End.

## 4b. Verdict: ERROR — done

Relay. No fixer. End.

## 4c. Verdict: REGRESSION — alert, NO fixer

The signature has `status=fixed` from a prior run, so the previous fix didn't hold. NEVER auto-fix a regression — a human must decide why the fix broke. Output a prominent banner:

```
⚠️  REGRESSION DETECTED — signature already fixed in PR <fix_pr> has re-emerged.
   FIND: <find-id>. Replay: pnpm explorer:replay <find-id>
   Auto-fix is intentionally disabled for regressions. Investigate manually.
```

End. Do NOT dispatch the fixer.

## 4d. Verdict: FINDING — maybe dispatch the fixer

If `$NO_FIX=true`: just relay the FINDING summary, suggest `pnpm explorer:replay <FIND-id>`, and end. Do NOT dispatch the fixer.

If `$NO_FIX=false` (default), dispatch the fixer:

### 4d.i — Acquire the mutex

```bash
LOCK=/tmp/phantomchat-explorer-fixer.lock
if [ -f "$LOCK" ]; then
  PID=$(cat "$LOCK")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Another fixer is already running (pid $PID). Skipping auto-fix."
    # Skip 4d.ii — just relay the FINDING + suggest replay, end.
  else
    rm -f "$LOCK"
  fi
fi
echo $$ > "$LOCK"
```

Free the lock with `rm -f /tmp/phantomchat-explorer-fixer.lock` after the fixer agent returns (4d.iv) — or earlier on any error path.

### 4d.ii — Dispatch phantomchat-fixer

Read the explorer's RESULT to extract `<FIND-id>`. Read `docs/explorer-reports/<FIND-id>/signature.txt` for the signature string.

Dispatch the `phantomchat-fixer` subagent (custom subagent at `.claude/agents/phantomchat-fixer.md`) via the Agent tool with prompt:

```
$FIND_ID=<FIND-id>
$FIND_DIR=<absolute path to docs/explorer-reports/FIND-id>
$SIGNATURE=<signature string>
$REPO_ROOT=<absolute path to git rev-parse --show-toplevel>
```

The fixer subagent's frontmatter + body encode the 7-stage pipeline (classification → worktree → edit → tripwire → 4 test gates → commit → draft PR). Wait for its RESULT.

### 4d.iii — Relay fixer RESULT

Relay the fixer's RESULT verbatim. Two outcomes:

- `Verdict: PR-OPEN` → tell the user the draft PR URL and remind them: review manually, NEVER auto-merge.
- `Verdict: REPORT-ONLY` → tell the user the reason. Suggest `pnpm explorer:replay <FIND-id>` for manual investigation. Note that `seen-signatures.json` has `status=report-only` so future runs that hit the same signature will dedup as known.

### 4d.iv — Release mutex

```bash
rm -f /tmp/phantomchat-explorer-fixer.lock
```

# F2c + F3 capabilities

- Single-intent flow → autonomous reason→act→verify loop
- Hardcoded goal mapping → free-form goal interpretation + autonomous mode
- Oracle A only → A + B (typed expectations) + D (LLM invariants in vm sandbox)
- No triage → second-pass triage on candidate Oracle B findings
- No cross-run dedup → seen-signatures.json + REGRESSION detection
- No coverage tracking → areas-coverage.json drives autonomous goal selection
- No auto-fix → 7-stage F3 fixer pipeline with classification + regex tripwire + 4 test gates + draft PR

# Out of scope (F4+)

- Background loop / cron / CI integration
- Cloud always-on
- Multi-pair parallel
- Network/Tor scenarios beyond Playwright `setOffline`

See `docs/superpowers/specs/2026-04-29-agentic-explorer-design.md` for the full design.
