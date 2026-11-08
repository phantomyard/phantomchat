import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {vi} from 'vitest';
import {stopElectron} from '../../scripts/channels/smoke-cleanup.mjs';

// Playwright's ElectronApplication.close() only tears down the browser context.
// The Electron child lives on, and it holds the single-instance lock in
// userData (electron/main.ts) until it really exits — so a relaunch on the same
// profile is refused the lock, quits before creating a window, and firstWindow()
// burns its whole timeout on a healthy app. That is how run 42475769969 failed
// the offline relaunch. Every smoke script closes through stopElectron, and
// this guard keeps it that way.
const DIR = join(process.cwd(), 'scripts', 'channels');

type Fake = {desktop: any; proc: any; events: string[]};

const fakeDesktop = ({emitExit = true, exitDelayMs = 0, closeDelayMs = 0} = {}): Fake => {
  const events: string[] = [];
  const proc: any = new EventEmitter();
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
  return {desktop, proc, events};
};

describe('electron smoke process teardown', () => {
  test('resolves only once the process is gone, not when close() returns', async() => {
    const {desktop, events} = fakeDesktop({exitDelayMs: 30});
    await stopElectron(desktop);
    events.push('resolved');
    expect(events).toEqual(['closed', 'exit', 'resolved']);
  });

  test('is still waiting while the app shuts down', async() => {
    const {desktop, events} = fakeDesktop({exitDelayMs: 50});
    let done = false;
    const pending = stopElectron(desktop).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    expect(events).toEqual(['closed']);
    await pending;
    expect(done).toBe(true);
  });

  test('kills a child that ignores the graceful close, so the lock is released', async() => {
    const {desktop, proc, events} = fakeDesktop({emitExit: false});
    await stopElectron(desktop, {timeoutMs: 20});
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    expect(events).toContain('kill:SIGKILL');
  });

  test('does not wait on a process that already exited', async() => {
    const {desktop, proc} = fakeDesktop({emitExit: false});
    proc.exitCode = 0;
    const started = Date.now();
    await stopElectron(desktop, {timeoutMs: 5000});
    expect(Date.now() - started).toBeLessThan(2000);
    expect(proc.kill).not.toHaveBeenCalled();
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
