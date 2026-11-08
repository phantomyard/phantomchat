import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {vi} from 'vitest';
import {killProcessTree, stopElectron} from '../../scripts/channels/smoke-cleanup.mjs';

// ElectronApplication.close() quits the app over CDP and then awaits the child —
// which is exactly why a wedged app hangs there forever and the relaunch on the
// same userData profile loses the single-instance lock (electron/main.ts), quits
// before creating a window, and burns firstWindow()'s whole timeout. Run
// 42475769969 failed its offline relaunch that way. Every smoke script closes
// through stopElectron, and this guard keeps it that way.
const DIR = join(process.cwd(), 'scripts', 'channels');

type Fake = {desktop: any; proc: any; events: string[]; killTree: any};

const fakeDesktop = ({
  emitExit = true,
  exitDelayMs = 0,
  closeDelayMs = 0,
  closeHangs = false,
  pid = 4242,
}: {
  emitExit?: boolean;
  exitDelayMs?: number;
  closeDelayMs?: number;
  closeHangs?: boolean;
  pid?: number | undefined;
} = {}): Fake => {
  const events: string[] = [];
  const proc: any = new EventEmitter();
  proc.pid = pid;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = vi.fn((signal: string) => {
    events.push(`kill:${signal}`);
    proc.signalCode = signal;
    proc.emit('exit', null, signal);
  });
  const desktop = {
    process: () => proc,
    close: async() => {
      if(closeHangs) return new Promise(() => {});
      await new Promise((resolve) => setTimeout(resolve, closeDelayMs));
      events.push('closed');
      if(!emitExit) return;
      setTimeout(() => {
        proc.exitCode = 0;
        events.push('exit');
        proc.emit('exit', 0);
      }, exitDelayMs);
    },
  };
  // Stands in for killProcessTree: killing the tree ends the app.
  const killTree = vi.fn(() => {
    events.push('killTree');
    proc.signalCode = 'SIGKILL';
    proc.emit('exit', null, 'SIGKILL');
  });
  return {desktop, proc, events, killTree};
};

describe('electron smoke process teardown', () => {
  test('resolves only once the process is gone, not when close() returns', async() => {
    const {desktop, events, killTree} = fakeDesktop({exitDelayMs: 30});
    await stopElectron(desktop, {killTree});
    events.push('resolved');
    expect(events).toEqual(['closed', 'exit', 'resolved']);
  });

  test('is still waiting while the app shuts down', async() => {
    const {desktop, events, killTree} = fakeDesktop({exitDelayMs: 50});
    let done = false;
    const pending = stopElectron(desktop, {killTree}).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    expect(events).toEqual(['closed']);
    await pending;
    expect(done).toBe(true);
  });

  test('bounds a close() that never settles, and kills the tree', async() => {
    // The case the guard exists for: close() awaits the child, so an app that
    // ignores the quit leaves it pending forever. The timeout must run alongside
    // close(), not after it.
    const {desktop, proc, events, killTree} = fakeDesktop({closeHangs: true});
    const started = Date.now();
    await stopElectron(desktop, {timeoutMs: 20, killTree});
    expect(Date.now() - started).toBeLessThan(2000);
    expect(killTree).toHaveBeenCalledWith(proc);
    expect(events).toEqual(['killTree']);
  });

  test('kills a child that ignores the graceful close, so the lock is released', async() => {
    const {desktop, proc, events, killTree} = fakeDesktop({emitExit: false});
    await stopElectron(desktop, {timeoutMs: 20, killTree});
    expect(killTree).toHaveBeenCalledWith(proc);
    expect(events).toContain('killTree');
  });

  test('gives up on a process that survives the kill instead of wedging', async() => {
    const {desktop} = fakeDesktop({emitExit: false});
    const killTree = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const started = Date.now();
    await stopElectron(desktop, {timeoutMs: 20, killTree});
    expect(Date.now() - started).toBeLessThan(2000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still running'));
    warn.mockRestore();
  });

  test('does not wait on a process that already exited', async() => {
    const {desktop, proc, killTree} = fakeDesktop({emitExit: false});
    proc.exitCode = 0;
    const started = Date.now();
    await stopElectron(desktop, {timeoutMs: 5000, killTree});
    expect(Date.now() - started).toBeLessThan(2000);
    expect(killTree).not.toHaveBeenCalled();
  });

  test('tolerates a launch that never happened', async() => {
    await expect(stopElectron(undefined)).resolves.toBeUndefined();
  });

  test('is what every Electron smoke script closes through', () => {
    const scripts = readdirSync(DIR)
      .filter((name) => name.endsWith('.mjs'))
      .filter((name) => readFileSync(join(DIR, name), 'utf8').includes('_electron.launch'));
    expect(scripts.length).toBeGreaterThanOrEqual(3);
    for(const name of scripts) {
      const source = readFileSync(join(DIR, name), 'utf8');
      expect(source, name).toContain('stopElectron');
      // db.close() and browser.close() are other things entirely.
      expect(source, name).not.toMatch(/(?:running\.)?desktop\.close\(/);
    }
  });
});

describe('smoke process tree kill', () => {
  test('uses taskkill /T on win32, where the direct child is a shell', () => {
    const spawnFn = vi.fn();
    const proc: any = {pid: 4242, kill: vi.fn()};
    expect(killProcessTree(proc, {platform: 'win32', spawnFn})).toBe(true);
    expect(spawnFn).toHaveBeenCalledWith('taskkill /pid 4242 /T /F', {shell: true, stdio: 'ignore'});
    expect(proc.kill).not.toHaveBeenCalled();
  });

  test('kills the process group elsewhere, not just the main process', () => {
    const killProcess = vi.fn();
    const proc: any = {pid: 4242, kill: vi.fn()};
    expect(killProcessTree(proc, {platform: 'darwin', killProcess})).toBe(true);
    expect(killProcess).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  test('falls back to the direct child when it leads no process group', () => {
    const killProcess = vi.fn(() => {
      throw Object.assign(new Error('kill ESRCH'), {code: 'ESRCH'});
    });
    const proc: any = {pid: 4242, kill: vi.fn()};
    expect(killProcessTree(proc, {platform: 'linux', killProcess})).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('does nothing without a pid', () => {
    const killProcess = vi.fn();
    expect(killProcessTree({pid: undefined} as any, {platform: 'linux', killProcess})).toBe(false);
    expect(killProcess).not.toHaveBeenCalled();
  });
});
