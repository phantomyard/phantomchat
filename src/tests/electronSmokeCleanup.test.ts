import {describe, expect, it, vi} from 'vitest';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {load} from 'js-yaml';
import {removeScratch} from '../../scripts/channels/smoke-cleanup.mjs';

const WORKFLOWS = join(process.cwd(), '.github', 'workflows');
const CHANNEL_SCRIPTS = join(process.cwd(), 'scripts', 'channels');

type Workflow = {jobs: Record<string, {steps?: Array<{run?: string}>}>};

describe('Electron smoke cleanup', () => {
  it('warns instead of throwing, so it cannot replace the real failure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failingRm = () => {
      throw new Error('EPERM, Permission denied');
    };
    expect(() => removeScratch('scratch-dir', failingRm)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('scratch-dir'));
    warn.mockRestore();
  });

  it('retries, because Windows releases a closed Electron profile late', () => {
    const rm = vi.fn();
    removeScratch('scratch-dir', rm);
    expect(rm).toHaveBeenCalledWith('scratch-dir', expect.objectContaining({recursive: true, force: true, maxRetries: 5}));
  });

  it('is what every Electron smoke script uses', () => {
    const scripts = readdirSync(CHANNEL_SCRIPTS).filter((name) => /^electron-.*smoke\.mjs$/.test(name));
    expect(scripts.length).toBeGreaterThanOrEqual(3);
    for(const name of scripts) {
      const source = readFileSync(join(CHANNEL_SCRIPTS, name), 'utf8');
      expect(source, name).toContain('removeScratch(dir)');
      expect(source, name).not.toContain('rmSync');
    }
  });
});

describe('vitest jobs', () => {
  it('install the Pi runtime before running the suite, in every workflow', () => {
    const jobs: string[] = [];
    for(const file of readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name))) {
      const workflow = load(readFileSync(join(WORKFLOWS, file), 'utf8')) as Workflow;
      for(const [name, job] of Object.entries(workflow.jobs ?? {})) {
        const runs = (job.steps ?? []).map((step) => step.run ?? '');
        const vitest = runs.findIndex((run) => run.includes('vitest run'));
        if(vitest === -1) continue;
        jobs.push(`${file}:${name}`);
        const install = runs.findIndex((run) => run.includes('electron/pi-harness install'));
        expect(install, `${file}:${name}`).toBeGreaterThanOrEqual(0);
        expect(install, `${file}:${name}`).toBeLessThan(vitest);
      }
    }
    expect(jobs).toEqual(expect.arrayContaining(['app-release.yml:test', 'ci.yml:test']));
  });
});
