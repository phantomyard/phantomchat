/*
 * The Pi harness shipped for Local PC access (issue #276).
 *
 * Inert today: nothing starts it except the `--pi-version` packaging probe, and
 * no renderer or relay path can reach it. It runs on the app's own Node runtime,
 * so it needs nothing installed on the machine.
 */
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

export function piCliPath(isPackaged: boolean, resourcesPath: string, bundleDir: string): string {
  const root = isPackaged ? join(resourcesPath, 'pi') : join(bundleDir, 'pi');
  return join(root, 'dist', 'bundle', 'cli.js');
}

/** Exit status of `pi --version` on the app's runtime, with its output inherited. */
export function runPiVersion(execPath: string, cliPath: string): number {
  const result = spawnSync(execPath, [cliPath, '--version'], {
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
    stdio: 'inherit'
  });
  return result.status ?? 1;
}
