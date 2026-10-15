import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {load} from 'js-yaml';

type Step = {name?: string; if?: string; run?: string};
type Workflow = {
  on: Record<string, unknown>;
  jobs: Record<string, {steps: Step[]}>;
};

const readWorkflow = (name: string) => load(
  readFileSync(join(process.cwd(), '.github', 'workflows', name), 'utf8'),
) as Workflow;

describe('desktop release manual controls', () => {
  it('offers a main-only manual app release button', () => {
    const workflow = readWorkflow('app-release.yml');
    expect(workflow.on).toHaveProperty('workflow_dispatch');

    const guard = workflow.jobs.linux.steps.find(({name}) => name === 'Require main for manual releases');
    expect(guard?.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(guard?.run).toContain('refs/heads/main');
    expect(guard?.run).toContain('exit 1');
  });

  it('defaults promotion to the newest created release without falling back to stale previews', () => {
    const workflow = readWorkflow('app-promote.yml');
    const resolve = workflow.jobs.promote.steps.find(({name}) => name === 'Resolve tag (default: newest release preview)');

    expect(resolve?.run).toContain('sort_by(.created_at) | last');
    expect(resolve?.run).toContain('IS_PRERELEASE');
    expect(resolve?.run).not.toContain('select(.isPrerelease)');
  });
});
