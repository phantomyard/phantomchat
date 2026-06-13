/**
 * Fuzzer version tag. Stored in emitted baselines (fuzzerVersion field) and
 * checked on replay to surface action-registry drift between phases.
 *
 * Bump when the action set changes or an invariant's semantics shift in a
 * way that may invalidate prior baselines. Keep file-name suffix in sync:
 * `baseline-seed<seed>-v2bN.json` ← derived from this constant.
 */
export const FUZZER_VERSION = 'phase2b5';
