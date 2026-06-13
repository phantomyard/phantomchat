# Deferred Items

## Pre-existing ESLint errors (out of scope for 01-03)

Found during `pnpm build` in 01-03. These errors existed before this plan's changes and are NOT caused by any work in plan 01-03.

### Files with errors

- `src/components/calls/index.tsx` — Unexpected space(s) after "if" (keyword-spacing)
- `src/helpers/themeController.ts` — Unexpected await of non-Promise (lines 320, 422)
- `src/lib/appImManager.ts` — Unexpected await of non-Promise (line 855)
- `src/lib/passcode/actions.ts` — Unexpected await of non-Promise (lines 57, 93)
- `src/pages/nostra-onboarding-integration.ts` — Trailing spaces (line 57)

### Impact

These errors prevent `pnpm build` from completing. The build output in `dist/` is from a previously successful build. The `_headers` and `404.html` files were verified in `dist/` from that prior build run.

### Recommended fix

Address in a dedicated lint-fix plan or as part of the phase that touches these files.
