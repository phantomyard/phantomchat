/*
 * `jsdom` ships no types and is only used by the tests that need a real
 * cascade (see phantomchat/ui-batch8-cascade.test.ts). Declared here rather
 * than pulling in `@types/jsdom`: a devDependency change would alter
 * pnpm-lock.yaml and re-open the channel compatibility review for a test-only
 * import. Files under src/tests are excluded from that review.
 */
declare module 'jsdom';
