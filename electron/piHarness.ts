/*
 * The Pi harness shipped for Local PC access (issue #276).
 *
 * It runs on the app's own Node runtime, so it needs nothing installed on the
 * machine. The CLI entry is only used by the `--pi-version` packaging probe; the
 * app itself loads the SDK entry on first use (localAi/piRuntime.ts).
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

/** The SDK entry of the same bundled copy of Pi. */
export function piSdkPath(isPackaged: boolean, resourcesPath: string, bundleDir: string): string {
  const root = isPackaged ? join(resourcesPath, 'pi') : join(bundleDir, 'pi');
  return join(root, 'dist', 'bundle', 'index.js');
}
