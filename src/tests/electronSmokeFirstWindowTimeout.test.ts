import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

// Playwright's _electron.launch timeout covers the spawn and the CDP handshake
// only. Waiting for the first BrowserWindow is a separate call that keeps its
// own 30s default, and a cold arm64 runner exceeds it while the app is still
// perfectly healthy — that is the assertion that failed windows-11-arm in run
// 42471929672. Every call must therefore set its own timeout, and this guard
// fails the moment one is added without. It runs on every PR, unlike the
// native smoke scripts themselves, which only run in the release workflow.
const DIR = join(process.cwd(), 'scripts', 'channels');

// A call that is long enough to be a real window wait, but still under the
// default that already proved too short.
const MIN_TIMEOUT_MS = 45000;

type Call = {file: string; args: string};

const calls = (): Call[] => readdirSync(DIR)
  .filter(file => file.endsWith('.mjs'))
  .flatMap(file => [...readFileSync(join(DIR, file), 'utf8').matchAll(/\.firstWindow\(\s*([^)]*)\)/g)]
    .map(match => ({file, args: match[1].trim()})));

describe('electron smoke first-window waits', () => {
  test('finds the firstWindow calls it is guarding', () => {
    expect(calls().length).toBeGreaterThan(0);
  });

  test('gives every firstWindow wait an explicit timeout', () => {
    const unbounded = calls().filter(({args}) => !/timeout\s*:/.test(args));
    expect(
      unbounded,
      'firstWindow() without a timeout keeps Playwright\'s 30s default:\n' +
        unbounded.map(c => `  scripts/channels/${c.file}: firstWindow(${c.args})`).join('\n'),
    ).toEqual([]);
  });

  test('never asks for a window wait shorter than the default it replaces', () => {
    const tooShort = calls().flatMap(({file, args}) => {
      const literal = args.match(/timeout\s*:\s*(\d+)/);
      return literal && Number(literal[1]) < MIN_TIMEOUT_MS ? [`scripts/channels/${file}: firstWindow(${args})`] : [];
    });
    expect(tooShort).toEqual([]);
  });
});
