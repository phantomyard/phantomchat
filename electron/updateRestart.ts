/*
 * PhantomChat desktop — clean-quit-first update install on Linux (issue #243).
 *
 * electron-updater's `quitAndInstall` on a deb/rpm install runs the whole
 * privileged install (`pkexec … dpkg -i …`) SYNCHRONOUSLY on the app's main
 * thread BEFORE it quits (BaseUpdater.quitAndInstall → install → doInstall →
 * LinuxUpdater.runCommandWithSudoIfNeeded → spawnSync). The window stops
 * responding while the polkit password prompt is up, GNOME offers
 * Force Quit/Wait, and force-quitting kills the app mid IndexedDB write —
 * the suspected corruption vector behind the update-restart freezes (#243).
 *
 * The fix flips the order, matching what the macOS and Windows builds already
 * feel like: the app quits CLEANLY first, a detached helper then installs and
 * relaunches. This module is the pure part — the shell command selection
 * (mirroring electron-updater's package-manager choice), the privilege-agent
 * dispatch (mirroring its determineSudoCommand), the helper script text, and
 * the install-now decision logic. Spawning and quitting live in updater.ts.
 */
import {PRIVILEGE_AGENTS, type PackageType} from './updateCapability';

/** The install runs either as root already, or through one of the graphical
 * privilege agents electron-updater's LinuxUpdater accepts. Plain `sudo` is
 * deliberately absent: a desktop app has no terminal to prompt in. */
export type PrivilegeAgent = 'none' | 'gksudo' | 'kdesudo' | 'pkexec' | 'beesu';

/** Package types whose install blocks on the package manager + root. The
 * AppImage updater swaps the image file in place and is fine stock. */
export type BlockingPackageType = Extract<PackageType, 'deb' | 'rpm'>;

/**
 * POSIX single-quote an argument for a shell command line. Every path and
 * flag value that reaches the helper goes through here, so a downloaded
 * package in a directory with spaces or quotes cannot turn into syntax.
 */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The install command electron-updater would run for this package type —
 * same package-manager priority lists, same flags, same deb fallback
 * (dpkg unpacks even with missing dependencies and exits non-zero;
 * `apt-get install -f -y` then completes the configure step).
 *
 * Returns null when no usable package manager exists, which the caller
 * treats as "fall back to the stock install path".
 */
export function installShellCommand(
  packageType: BlockingPackageType,
  installerPath: string,
  findExecutable: (name: string) => string | null
): string | null {
  const file = shellQuote(installerPath);

  if(packageType === 'deb') {
    // electron-updater DebUpdater: priority list ["dpkg", "apt"].
    if(findExecutable('dpkg')) return `dpkg -i ${file} || apt-get install -f -y`;
    if(findExecutable('apt')) {
      return `apt install -y --allow-unauthenticated --allow-downgrades --allow-change-held-packages ${file}`;
    }
    return null;
  }

  // electron-updater RpmUpdater: priority list ["zypper", "dnf", "yum", "rpm"].
  if(findExecutable('zypper')) return `zypper --non-interactive --no-refresh install --allow-unsigned-rpm -f ${file}`;
  if(findExecutable('dnf')) return `dnf install --nogpgcheck -y ${file}`;
  if(findExecutable('yum')) return `yum install --nogpgcheck -y ${file}`;
  if(findExecutable('rpm')) return `rpm -Uvh --replacepkgs --replacefiles --nodeps ${file}`;
  return null;
}

/**
 * How the helper should obtain root: already root ('none'), or the first of
 * electron-updater's agents found on PATH, in its determineSudoCommand
 * order. Null when nothing can prompt — the caller then falls back to the
 * stock path rather than spawning a helper that dies at the root step.
 */
export function resolvePrivilegeAgent(
  isRoot: boolean,
  findExecutable: (name: string) => string | null
): PrivilegeAgent | null {
  if(isRoot) return 'none';
  for(const agent of PRIVILEGE_AGENTS) {
    if(findExecutable(agent)) return agent;
  }
  return null;
}

/** What the helper needs to know to install and relaunch. */
export interface HelperLaunch {
  pid: number;
  agent: PrivilegeAgent;
  exePath: string;
  logPath: string;
  installCommand: string;
}

/**
 * The helper's argv: the raw command for the agents that take a direct
 * command + argv (`none`, `pkexec`), and the same command as ONE
 * argument-safe string for the agents that take a single command string
 * (`gksudo`, `kdesudo`, `beesu`) — mirroring how electron-updater wraps
 * `/bin/bash -c '…'` into one quoted word for them.
 *
 * Passing `bash -c <cmd>` as separate words to gksudo is a trap: its GNU
 * getopt_long parser permutes options after positional arguments, hits the
 * bare `-c`, and aborts with `invalid option -- 'c'` before anything runs
 * (#248 review). The single string is built here in TypeScript so all the
 * quoting lives in one tested place.
 */
export function helperArgs(launch: HelperLaunch): string[] {
  return [
    String(launch.pid),
    launch.agent,
    launch.exePath,
    launch.logPath,
    launch.installCommand,
    `bash -c ${shellQuote(launch.installCommand)}`
  ];
}

/**
 * The detached helper itself. Usage:
 *
 *   bash linux-update-helper.sh <pid> <agent> <exe> <log> <command> <command-string>
 *
 * It waits for the app's PID to exit, runs the install command through the
 * privilege agent (the polkit prompt therefore appears over an app that is
 * already gone, not over a frozen window), and relaunches the app. Failures
 * are logged and surfaced with notify-send, because by then there is no app
 * left on screen to show an error.
 *
 * HELPER_WAIT_ITERS (optional env) bounds the wait loop in 0.5s steps
 * (default 120 = 60s). It exists as a test seam so the never-exits path can
 * be exercised in seconds; the app never sets it.
 */
export function helperScript(): string {
  return `#!/bin/bash
# PhantomChat desktop — clean-quit update installer (issue #243).
# Spawned detached by the app right before it quits; see updateRestart.ts.
set -u
PID="$1"; AGENT="$2"; EXE="$3"; LOG="$4"; CMD="$5"; CMDSTR="$6"

# Probe before exec: a redirection error on exec would kill this shell.
if : >>"$LOG" 2>/dev/null; then
  exec >>"$LOG" 2>&1
fi
echo "---- $(date '+%Y-%m-%dT%H:%M:%S%z') helper start pid=$PID agent=$AGENT"
echo "command: $CMD"

# Wait for the app to exit — bounded, so a wedged app cannot stall the
# install forever. After the deadline install anyway (the package manager is
# fine replacing a running binary) but do NOT relaunch: a second instance
# next to a stuck first one is worse than no instance.
STILL_RUNNING=0
for _ in $(seq 1 "\${HELPER_WAIT_ITERS:-120}"); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$PID" 2>/dev/null; then
  STILL_RUNNING=1
  echo "app still running after the wait bound: installing anyway, not relaunching"
else
  sleep 0.5
fi

run_install() {
  case "$AGENT" in
    none)    bash -c "$CMD" ;;
    pkexec)  pkexec --disable-internal-agent bash -c "$CMD" ;;
    kdesudo) kdesudo --comment "PhantomChat would like to update" -c "$CMDSTR" ;;
    gksudo)  gksudo --message "PhantomChat would like to update" "$CMDSTR" ;;
    beesu)   beesu "$CMDSTR" ;;
    *) echo "unknown privilege agent: $AGENT"; return 1 ;;
  esac
}

if run_install; then
  echo "install ok"
  if [ "$STILL_RUNNING" = 0 ]; then
    echo "relaunching: $EXE"
    nohup "$EXE" >/dev/null 2>&1 &
  fi
  echo "---- helper done"
  exit 0
fi

echo "install FAILED"
# The app already quit and the install failed (dismissed polkit prompt, bad
# package, …). The old version is still installed: bring the user back where
# they were instead of leaving them with no app at all (#248 review).
if [ "$STILL_RUNNING" = 0 ]; then
  echo "relaunching previous version: $EXE"
  nohup "$EXE" >/dev/null 2>&1 &
fi
if command -v notify-send >/dev/null 2>&1; then
  notify-send "PhantomChat update failed" "The update could not be installed. See $LOG" || true
fi
exit 1
`;
}

/**
 * The install-now decision logic for the 'auto' capability, extracted so it
 * can be tested without mocking Electron (#248 review).
 *
 * Helper path: latch ON — the helper is already spawned and outlives the
 * app, a second click must not spawn a second installer. Stock fallback
 * (macOS/Windows/AppImage, or Linux where the helper cannot run): deliberately
 * NO latch — electron-updater guards double-invocation with its own
 * quitAndInstallCalled and resets it when the install fails and the app stays
 * running, so a failed attempt must remain retryable (#248 review).
 */
export interface InstallNowDeps {
  /** Try the clean-quit helper path; false → stock quitAndInstall. */
  tryCleanQuitInstall: () => boolean;
  quitApp: () => void;
  /** electron-updater's quitAndInstall(true, true). */
  stockQuitAndInstall: () => void;
  /** Turn electron-updater's install-on-quit behaviour on or off. */
  setAutoInstallOnAppQuit: (value: boolean) => void;
}

export function createInstallNowHandler(deps: InstallNowDeps): () => void {
  let helperHandedOff = false;
  return () => {
    if(helperHandedOff) return;
    if(deps.tryCleanQuitInstall()) {
      helperHandedOff = true;
      // The helper owns the install now: electron-updater's quit handler
      // must not fire its own blocking install on the way out.
      deps.setAutoInstallOnAppQuit(false);
      deps.quitApp();
      return;
    }
    deps.stockQuitAndInstall();
  };
}
