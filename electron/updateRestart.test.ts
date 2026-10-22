/*
 * Clean-quit-first update install on Linux (issue #243): the pure parts —
 * shell quoting, the electron-updater-mirroring install command, the
 * privilege-agent dispatch, the helper script itself, and the install-now
 * decision logic.
 *
 * The helper script is EXECUTED under real bash (skipped on win32): its
 * ordering is the whole point of this code, and string-matching tests cannot
 * tell an installer that waits for the app from one that installs over it
 * (#248 review). The privilege agents run as stubs that enforce each agent's
 * real argument shape — including gksu's getopt_long rejecting a bare `-c`
 * after a positional argument.
 */
import {describe, it, expect} from 'vitest';
import {spawnSync, spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {delimiter, join} from 'node:path';
import {
  shellQuote,
  installShellCommand,
  resolvePrivilegeAgent,
  helperArgs,
  helperScript,
  createInstallNowHandler,
  type InstallNowDeps,
  type PrivilegeAgent
} from './updateRestart';

const withBins = (...names: string[]) => (name: string) => names.includes(name) ? `/usr/bin/${name}` : null;
const noBins = () => null;

describe('shellQuote', () => {
  it('wraps plain arguments in single quotes', () => {
    expect(shellQuote('/tmp/u.deb')).toBe(`'/tmp/u.deb'`);
  });

  it('keeps spaces and metacharacters inert', () => {
    expect(shellQuote('/tmp/My Updates/u; rm -rf ~.deb')).toBe(`'/tmp/My Updates/u; rm -rf ~.deb'`);
  });

  it('escapes embedded single quotes', () => {
    expect(shellQuote(`/tmp/a'b.deb`)).toBe(`'/tmp/a'\\''b.deb'`);
  });

  it('quotes the empty string', () => {
    expect(shellQuote('')).toBe(`''`);
  });
});

describe('installShellCommand', () => {
  it('deb: dpkg first, with electron-updater\'s apt-get dependency fallback', () => {
    const cmd = installShellCommand('deb', '/tmp/u.deb', withBins('dpkg', 'apt'));
    expect(cmd).toBe(`dpkg -i '/tmp/u.deb' || apt-get install -f -y`);
  });

  it('deb: falls back to apt when dpkg is missing, with the unsigned-deb flags', () => {
    const cmd = installShellCommand('deb', '/tmp/u.deb', withBins('apt'));
    expect(cmd).toBe(`apt install -y --allow-unauthenticated --allow-downgrades --allow-change-held-packages '/tmp/u.deb'`);
  });

  it('deb: null when neither dpkg nor apt exists', () => {
    expect(installShellCommand('deb', '/tmp/u.deb', noBins)).toBeNull();
  });

  it('rpm: zypper wins the priority list', () => {
    const cmd = installShellCommand('rpm', '/tmp/u.rpm', withBins('rpm', 'yum', 'dnf', 'zypper'));
    expect(cmd).toBe(`zypper --non-interactive --no-refresh install --allow-unsigned-rpm -f '/tmp/u.rpm'`);
  });

  it('rpm: dnf, then yum, then bare rpm', () => {
    expect(installShellCommand('rpm', '/tmp/u.rpm', withBins('dnf', 'yum', 'rpm')))
      .toBe(`dnf install --nogpgcheck -y '/tmp/u.rpm'`);
    expect(installShellCommand('rpm', '/tmp/u.rpm', withBins('yum', 'rpm')))
      .toBe(`yum install --nogpgcheck -y '/tmp/u.rpm'`);
    expect(installShellCommand('rpm', '/tmp/u.rpm', withBins('rpm')))
      .toBe(`rpm -Uvh --replacepkgs --replacefiles --nodeps '/tmp/u.rpm'`);
  });

  it('rpm: null when no package manager exists', () => {
    expect(installShellCommand('rpm', '/tmp/u.rpm', noBins)).toBeNull();
  });

  it('quotes the installer path so spaces and quotes cannot become syntax', () => {
    const cmd = installShellCommand('deb', `/tmp/My Updates/u'x.deb`, withBins('dpkg'))!;
    expect(cmd).toContain(`'/tmp/My Updates/u'\\''x.deb'`);
    // The quote closes before any metacharacter in the path can be parsed.
    expect(cmd).not.toContain(`'/tmp/My Updates/u'x.deb'`);
  });
});

describe('resolvePrivilegeAgent', () => {
  it('root needs no agent', () => {
    expect(resolvePrivilegeAgent(true, noBins)).toBe('none');
  });

  it('returns the first agent in electron-updater\'s determineSudoCommand order', () => {
    expect(resolvePrivilegeAgent(false, withBins('pkexec', 'beesu'))).toBe('pkexec');
    expect(resolvePrivilegeAgent(false, withBins('beesu', 'pkexec'))).toBe('pkexec');
    expect(resolvePrivilegeAgent(false, withBins('kdesudo', 'pkexec'))).toBe('kdesudo');
    expect(resolvePrivilegeAgent(false, withBins('gksudo', 'kdesudo'))).toBe('gksudo');
  });

  it('null when nothing can prompt for root', () => {
    expect(resolvePrivilegeAgent(false, noBins)).toBeNull();
  });
});

describe('helperArgs', () => {
  it('passes the raw command and a single quoted command string, in order', () => {
    const command = `dpkg -i '/tmp/u.deb'`;
    const args = helperArgs({
      pid: 42,
      agent: 'gksudo',
      exePath: '/opt/PhantomChat App',
      logPath: '/tmp/helper.log',
      installCommand: command
    });
    expect(args.slice(0, 5)).toEqual(['42', 'gksudo', '/opt/PhantomChat App', '/tmp/helper.log', command]);
    expect(args[5]).toBe(`bash -c ${shellQuote(command)}`);
    // One argv word: no bare `-c` for gksudo's getopt to trip over.
    expect(args).toHaveLength(6);
  });

  it('escapes quotes inside the single command string', () => {
    const args = helperArgs({
      pid: 1,
      agent: 'beesu',
      exePath: '/x',
      logPath: '/y',
      installCommand: `echo 'hi'`
    });
    expect(args[5]).toBe(`bash -c 'echo '\\''hi'\\'''`);
  });
});

// --- behavioural tests: the helper script actually runs under bash ---------

const isWindows = process.platform === 'win32';
const describeBash = isWindows ? describe.skip : describe;

interface HelperRun {
  status: number | null;
  marker: string[];
  log: string;
  stdout: string;
  runtimeMs: number;
  pidProcess: ChildProcess;
}

/**
 * Run the generated helper against a stand-in app process. The marker file
 * gets one line per step, in the order things actually happened:
 * `pid-exit` (written by the stand-in app as it exits), `install` (written
 * by the install command), `relaunch` (written by the stand-in exe).
 *
 * Fully async on purpose: the helper signals "the app is gone" with
 * `kill -0`, and that only fails for a REAPED process. A blocking spawnSync
 * would leave the exited stand-in a zombie in this very process (kill -0
 * succeeds on zombies) and the helper would conservatively treat the app as
 * still running — so the event loop must be free to reap while the helper
 * runs. The app's real parent (the session manager) reaps it in production.
 */
async function runHelper(opts: {
  agent: string;
  cmd: (marker: string) => string;
  pidCommand?: (marker: string) => string;
  waitIters?: string;
  logPath?: (dir: string) => string;
  stubs?: Record<string, string>;
  commandString?: string;
}): Promise<HelperRun> {
  const dir = mkdtempSync(join(tmpdir(), 'update-restart-'));
  const marker = join(dir, 'marker');
  const log = opts.logPath ? opts.logPath(dir) : join(dir, 'helper.log');
  const scriptPath = join(dir, 'helper.sh');
  writeFileSync(scriptPath, helperScript());

  // The relaunch target has spaces in its path on purpose.
  const exePath = join(dir, 'PhantomChat App');
  writeFileSync(exePath, `#!/bin/bash\necho relaunch >> '${marker}'\n`, {mode: 0o755});

  const env = {...process.env};
  let stubDir: string | null = null;
  if(opts.stubs) {
    stubDir = join(dir, 'bin');
    mkdirSync(stubDir);
    for(const [name, body] of Object.entries(opts.stubs)) {
      writeFileSync(join(stubDir, name), body, {mode: 0o755});
    }
    env.PATH = `${stubDir}${delimiter}${process.env.PATH ?? ''}`;
  }
  if(opts.waitIters !== undefined) env.HELPER_WAIT_ITERS = opts.waitIters;

  // The stand-in app: records its own exit into the marker, then exits.
  const pidCommand = opts.pidCommand
    ? opts.pidCommand(marker)
    : `sleep 0.3; echo pid-exit >> '${marker}'`;
  const pidProcess = spawn('bash', ['-c', pidCommand], {stdio: 'ignore'});

  const args = helperArgs({
    pid: pidProcess.pid!,
    agent: opts.agent as PrivilegeAgent,
    exePath,
    logPath: log,
    installCommand: opts.cmd(marker)
  });
  if(opts.commandString !== undefined) args[5] = opts.commandString;

  const started = Date.now();
  const result = await new Promise<{status: number | null; stdout: string}>((resolve) => {
    const child = spawn('bash', [scriptPath, ...args], {env});
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({status, stdout});
    });
  });
  const runtimeMs = Date.now() - started;

  // The relaunch is detached (nohup … &), so its marker line lands after the
  // helper itself has exited — poll briefly instead of racing it.
  const deadline = Date.now() + 2500;
  let markerLines = readMarker(marker);
  while(!markerLines.includes('relaunch') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    markerLines = readMarker(marker);
  }
  let logText = '';
  try {
    logText = readFileSync(log, 'utf8');
  } catch { /* unwritable-log test */ }

  return {
    status: result.status,
    marker: markerLines,
    log: logText,
    stdout: result.stdout ?? '',
    runtimeMs,
    pidProcess
  };
}

function readMarker(marker: string): string[] {
  try {
    return readFileSync(marker, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const echoStep = (step: string) => (marker: string) => `echo ${step} >> '${marker}'`;

// Stubs that enforce each privilege agent's real argument shape.
const GKsudo_STUB = `#!/bin/bash
# Emulates gksu 2.0.2's GNU getopt_long parsing: options are permuted after
# positional arguments, and an unknown option aborts before anything runs.
# The command must arrive as ONE positional string (like electron-updater's
# wrapped "/bin/bash -c '…'").
cmd=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --message) shift 2 || exit 1 ;;
    -*) echo "gksudo-stub: invalid option -- '$1'" >&2; exit 1 ;;
    *) if [ -n "$cmd" ]; then echo "gksudo-stub: too many arguments" >&2; exit 1; fi; cmd="$1"; shift ;;
  esac
done
if [ -z "$cmd" ]; then echo "gksudo-stub: no command" >&2; exit 1; fi
exec sh -c "$cmd"
`;

const KDESU_STUB = `#!/bin/bash
# kdesudo: --comment <msg> -c <command-string>
cmd=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --comment) shift 2 || exit 1 ;;
    -c) cmd="$2"; shift 2 || exit 1 ;;
    *) echo "kdesudo-stub: unexpected argument '$1'" >&2; exit 1 ;;
  esac
done
if [ -z "$cmd" ]; then echo "kdesudo-stub: no command" >&2; exit 1; fi
exec sh -c "$cmd"
`;

const PKEXEC_STUB = `#!/bin/bash
# pkexec: its own flags first, then the command with direct argv.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --disable-internal-agent) shift ;;
    *) break ;;
  esac
done
exec "$@"
`;

const BEESU_STUB = `#!/bin/bash
# beesu: exactly one command string.
if [ "$#" -ne 1 ]; then echo "beesu-stub: expected 1 command string, got $#" >&2; exit 1; fi
exec sh -c "$1"
`;

describeBash('helper script behaviour (executed under bash)', () => {
  it('waits for the app to exit, then installs, then relaunches — in that order', async() => {
    const run = await runHelper({agent: 'none', cmd: echoStep('install'), waitIters: '20'});
    pidCleanup(run);
    expect(run.status).toBe(0);
    expect(run.marker).toEqual(['pid-exit', 'install', 'relaunch']);
    // Catches a broken wait loop that always burns the full bound instead of
    // breaking out when the app exits (bound here is 10s).
    expect(run.runtimeMs).toBeLessThan(5000);
    expect(run.log).toContain('install ok');
  }, 20_000);

  it('relaunches the old version when the install fails after the app exited', async() => {
    // exit 126 = a dismissed polkit prompt in electron-updater's world.
    const run = await runHelper({
      agent: 'none',
      cmd: (marker) => `echo install >> '${marker}'; exit 126`,
      waitIters: '20'
    });
    pidCleanup(run);
    expect(run.status).toBe(1);
    expect(run.marker).toEqual(['pid-exit', 'install', 'relaunch']);
    expect(run.log).toContain('install FAILED');
    expect(run.log).toContain('relaunching previous version');
  }, 20_000);

  it('installs but does NOT relaunch when the app never exits', async() => {
    const run = await runHelper({
      agent: 'none',
      cmd: echoStep('install'),
      pidCommand: () => 'sleep 30',
      waitIters: '2'
    });
    pidCleanup(run);
    expect(run.status).toBe(0);
    expect(run.marker).toEqual(['install']);
    expect(run.log).toContain('still running');
    expect(run.log).not.toMatch(/relaunching[: ]/);
  }, 20_000);

  it('the gksudo stub itself rejects the bare -c form (regression teeth)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-restart-'));
    const stub = join(dir, 'gksudo');
    writeFileSync(stub, GKsudo_STUB, {mode: 0o755});
    // The pre-fix argv shape: gksudo … bash -c <cmd>.
    const result = spawnSync('bash', [stub, '--message', 'm', 'bash', '-c', 'true'], {encoding: 'utf8'});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`invalid option`);
  });

  it('dispatches every privilege agent through its real argument shape', async() => {
    const cases: Array<[string, Record<string, string>]> = [
      ['gksudo', {gksudo: GKsudo_STUB}],
      ['kdesudo', {kdesudo: KDESU_STUB}],
      ['pkexec', {pkexec: PKEXEC_STUB}],
      ['beesu', {beesu: BEESU_STUB}]
    ];
    for(const [agent, stubs] of cases) {
      const run = await runHelper({agent, cmd: echoStep('install'), stubs, waitIters: '20'});
      pidCleanup(run);
      expect(run.status, `${agent} dispatch`).toBe(0);
      expect(run.marker, `${agent} dispatch`).toEqual(['pid-exit', 'install', 'relaunch']);
    }
  }, 30_000);

  it('fails fast on an unknown privilege agent, still giving the app back', async() => {
    const run = await runHelper({agent: 'bogus', cmd: echoStep('install'), waitIters: '20'});
    pidCleanup(run);
    expect(run.status).toBe(1);
    expect(run.log).toContain('unknown privilege agent: bogus');
    expect(run.marker).toEqual(['pid-exit', 'relaunch']);
  }, 20_000);

  it('keeps going when the log path is unwritable', async() => {
    const run = await runHelper({
      agent: 'none',
      cmd: echoStep('install'),
      waitIters: '20',
      logPath: (dir) => join(dir, 'no-such-dir', 'helper.log')
    });
    pidCleanup(run);
    expect(run.status).toBe(0);
    expect(run.marker).toEqual(['pid-exit', 'install', 'relaunch']);
  }, 20_000);

  it('the generated script passes bash -n', () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-restart-'));
    const scriptPath = join(dir, 'helper.sh');
    writeFileSync(scriptPath, helperScript());
    const result = spawnSync('bash', ['-n', scriptPath], {encoding: 'utf8'});
    expect(result.status).toBe(0);
  });
});

function pidCleanup(run: HelperRun): void {
  try {
    run.pidProcess.kill('SIGKILL');
  } catch { /* already gone */ }
}

// --- install-now wiring (the guard/retry semantics from #248 review) -------

describe('createInstallNowHandler', () => {
  function harness(helperAvailable: boolean) {
    const calls = {tryClean: 0, quitApp: 0, stock: 0, autoInstallOnAppQuit: [] as boolean[]};
    const deps: InstallNowDeps = {
      tryCleanQuitInstall: () => {
        calls.tryClean++;
        return helperAvailable;
      },
      quitApp: () => {
        calls.quitApp++;
      },
      stockQuitAndInstall: () => {
        calls.stock++;
      },
      setAutoInstallOnAppQuit: (value) => {
        calls.autoInstallOnAppQuit.push(value);
      }
    };
    return {calls, handle: createInstallNowHandler(deps)};
  }

  it('helper path: latches, disables install-on-quit and quits', () => {
    const {calls, handle} = harness(true);
    handle();
    expect(calls).toEqual({tryClean: 1, quitApp: 1, stock: 0, autoInstallOnAppQuit: [false]});
  });

  it('helper path: a second click cannot spawn a second installer', () => {
    const {calls, handle} = harness(true);
    handle();
    handle();
    expect(calls.tryClean).toBe(1);
    expect(calls.quitApp).toBe(1);
    expect(calls.stock).toBe(0);
  });

  it('stock fallback: no latch — a failed install can be retried', () => {
    // Kai's repro: ready → install fails and leaves the app open → ready →
    // install must reach the installer again.
    const {calls, handle} = harness(false);
    handle();
    handle();
    expect(calls.stock).toBe(2);
    expect(calls.tryClean).toBe(2);
    expect(calls.autoInstallOnAppQuit).toEqual([]);
    expect(calls.quitApp).toBe(0);
  });

  it('a retry can still take the helper path once it becomes available', () => {
    let helperAvailable = false;
    const calls = {tryClean: 0, quitApp: 0, stock: 0, autoInstallOnAppQuit: [] as boolean[]};
    const handle = createInstallNowHandler({
      tryCleanQuitInstall: () => {
        calls.tryClean++;
        return helperAvailable;
      },
      quitApp: () => {
        calls.quitApp++;
      },
      stockQuitAndInstall: () => {
        calls.stock++;
      },
      setAutoInstallOnAppQuit: (value) => {
        calls.autoInstallOnAppQuit.push(value);
      }
    });
    handle();
    expect(calls.stock).toBe(1);
    helperAvailable = true;
    handle();
    expect(calls.quitApp).toBe(1);
    expect(calls.autoInstallOnAppQuit).toEqual([false]);
    handle();
    expect(calls.tryClean).toBe(2);
    expect(calls.quitApp).toBe(1);
  });
});
