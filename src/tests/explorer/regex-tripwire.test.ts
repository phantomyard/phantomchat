import {describe, expect, it} from 'vitest';
import {checkDiff} from '../../../scripts/explorer/tripwire';

const HEADER = (path: string) => [
  `diff --git a/${path} b/${path}`,
  `index abc..def 100644`,
  `--- a/${path}`,
  `+++ b/${path}`,
  `@@ -1,1 +1,2 @@`
].join('\n');

describe('explorer regex tripwire', () => {
  it('clean diff in production code passes', () => {
    const diff = `${HEADER('src/components/foo.ts')}
 export const FOO = 1;
+export const BAR = 2;
`;
    expect(checkDiff(diff).matches).toEqual([]);
  });

  it('catches MessagePort in production additions', () => {
    const diff = `${HEADER('src/lib/foo.ts')}
 export const FOO = 1;
+const port: MessagePort = ctx.port;
`;
    const r = checkDiff(diff);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].pattern).toBe('MessagePort');
    expect(r.matches[0].file).toBe('src/lib/foo.ts');
  });

  it('catches setTimeout, new Promise, .then(', () => {
    const diff = `${HEADER('src/lib/foo.ts')}
 const x = 1;
+setTimeout(() => x, 100);
+new Promise((r) => r(1)).then((v) => v);
`;
    const patterns = checkDiff(diff).matches.map((m) => m.pattern).sort();
    expect(patterns).toEqual(['.then(', 'new Promise', 'setTimeout'].sort());
  });

  it('catches Worker / SharedWorker / ServiceWorker', () => {
    const diff = `${HEADER('src/lib/foo.ts')}
 const x = 1;
+const w = new Worker('x');
+const sw = new SharedWorker('x');
+navigator.ServiceWorker.register('x');
`;
    const patterns = new Set(checkDiff(diff).matches.map((m) => m.pattern));
    expect(patterns.has('Worker')).toBe(true);
    expect(patterns.has('SharedWorker')).toBe(true);
    expect(patterns.has('ServiceWorker')).toBe(true);
  });

  it('catches relay / subscription / nostra-sync / virtual-mtproto', () => {
    const diff = `${HEADER('src/lib/foo.ts')}
 const x = 1;
+import {relay} from './relay-pool';
+import 'virtual-mtproto';
+import 'nostra-sync';
+const sub: subscription = pool.subscribe();
`;
    const patterns = new Set(checkDiff(diff).matches.map((m) => m.pattern));
    expect(patterns.has('relay')).toBe(true);
    expect(patterns.has('subscription')).toBe(true);
    expect(patterns.has('nostra-sync')).toBe(true);
    expect(patterns.has('virtual-mtproto')).toBe(true);
  });

  it('test files (src/tests/**) are permissive — banned patterns allowed', () => {
    const diff = `${HEADER('src/tests/fuzz/postconditions/group-bridge.ts')}
 const ms = 100;
+const longerWait = 5000; setTimeout(() => {}, longerWait);
+const port = new MessagePort();
`;
    expect(checkDiff(diff).matches).toEqual([]);
  });

  it('files outside src/ are permissive (e.g. scripts/, docs/)', () => {
    const diff = `${HEADER('scripts/explorer/driver.ts')}
 const x = 1;
+setTimeout(() => x, 100);
`;
    expect(checkDiff(diff).matches).toEqual([]);
  });

  it('only checks ADDED lines (- removals are fine even if matching)', () => {
    const diff = `diff --git a/src/lib/foo.ts b/src/lib/foo.ts
--- a/src/lib/foo.ts
+++ b/src/lib/foo.ts
@@ -1,3 +1,2 @@
 const x = 1;
-setTimeout(() => x, 100);
-const w = new Worker('x');
`;
    expect(checkDiff(diff).matches).toEqual([]);
  });

  it('multi-file diff: clean test file + dirty production file', () => {
    const diff = `diff --git a/src/tests/foo.ts b/src/tests/foo.ts
--- a/src/tests/foo.ts
+++ b/src/tests/foo.ts
@@ -1,1 +1,2 @@
 const a = 1;
+setTimeout(() => a, 1);
diff --git a/src/lib/bar.ts b/src/lib/bar.ts
--- a/src/lib/bar.ts
+++ b/src/lib/bar.ts
@@ -1,1 +1,2 @@
 const b = 1;
+setInterval(() => b, 1);
`;
    const r = checkDiff(diff);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].file).toBe('src/lib/bar.ts');
    expect(r.matches[0].pattern).toBe('setInterval');
  });

  it('reports plausible line numbers (not exact — best-effort from hunk header)', () => {
    const diff = `diff --git a/src/lib/foo.ts b/src/lib/foo.ts
--- a/src/lib/foo.ts
+++ b/src/lib/foo.ts
@@ -10,2 +10,3 @@
 const x = 1;
 const y = 2;
+setTimeout(() => x, 100);
`;
    const r = checkDiff(diff);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].line).toBe(12);
  });
});
