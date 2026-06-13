# Explorer Reports

This directory contains artifacts produced by the agentic explorer
(`/phantomchat-explore` slash command). See
`docs/superpowers/specs/2026-04-29-agentic-explorer-design.md` for the design.

## Layout

- `FIND-<8hex>/` — finding artifacts (one per unique signature)
  - `report.md` — human-readable summary
  - `trace.jsonl` — sequence of intents/atomic actions for replay
  - `screenshots/` — pageA + pageB at finding moment
  - `console.log` — captured console output
  - `signature.txt` — finding signature for cross-run dedup
- `runs/<run-id>/` — successful runs without findings (volatile, gitignored)
- `seen-signatures.json` — cross-run signature dedup state (F2)
- `allowlist.ts` — explorer-specific noise patterns (F2, augments fuzz allowlist)

## Replay

Re-run any finding's trace deterministically without LLM:

```bash
pnpm explorer:replay FIND-abc12345
```

Replay only re-executes the saved atomic Playwright actions. It does NOT
re-call the LLM. The trace.jsonl is the source of truth.
