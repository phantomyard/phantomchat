import {readFileSync} from 'node:fs';
import {join} from 'node:path';

// The shell smoke only runs in the release workflow. Its offline relaunch hung
// on windows-11-arm for 120s while it reused the online instance's profile
// (runs 42471929672, 42475757699, 42480529526), so it now boots a profile of
// its own seeded with frontend-cache, and a failure dumps Electron's output and
// the process list. This guard runs on every PR so neither can quietly regress.
const FILE = join(process.cwd(), 'scripts', 'channels', 'electron-shell-smoke.mjs');
const source = () => readFileSync(FILE, 'utf8');

describe('electron shell smoke offline relaunch', () => {
  test('launches offline.cjs on a profile of its own', () => {
    const call = source().match(/launch\(\s*writeEntry\(\s*'offline\.cjs'\s*,([^)]*)\)\s*\)/);
    expect(call, 'offline.cjs launch not found').not.toBeNull();
    const args = call[1].split(',').map(arg => arg.trim()).filter(Boolean);
    expect(args.length, 'offline.cjs must pass its own userData as a third argument').toBe(2);
    expect(args[1]).not.toBe('profile');
  });

  test('seeds that profile with the cached web files', () => {
    const src = source();
    const call = src.match(/writeEntry\(\s*'offline\.cjs'\s*,\s*true\s*,\s*(\w+)\s*\)/);
    expect(call).not.toBeNull();
    const seed = new RegExp(`cpSync\\([^;]*'frontend-cache'[^;]*join\\(\\s*${call[1]}\\s*,\\s*'frontend-cache'\\s*\\)`);
    expect(src).toMatch(seed);
  });

  test('dumps diagnostics when the smoke fails', () => {
    const handler = source().match(/\}\s*catch\s*\(\s*\w+\s*\)\s*\{([\s\S]*?)\}\s*finally/);
    expect(handler, 'top-level catch not found').not.toBeNull();
    expect(handler[1]).toMatch(/\bdumpDiagnostics\(\s*\)/);
  });
});
