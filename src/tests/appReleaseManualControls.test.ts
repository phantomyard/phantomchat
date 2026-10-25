import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {load} from 'js-yaml';

type Step = {name?: string; if?: string; run?: string};
type Workflow = {on: Record<string, unknown>; jobs: Record<string, {steps: Step[]}>};
const readWorkflow = (name: string) => load(readFileSync(join(process.cwd(), '.github', 'workflows', name), 'utf8')) as Workflow;

describe('manual independent release controls', () => {
  it.each(['deploy.yml', 'pwa-promote.yml', 'app-release.yml', 'app-promote.yml'])('%s cannot build or publish on a push or merge', name => {
    const workflow = readWorkflow(name);
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const scripts = Object.values(workflow.jobs).flatMap(job => job.steps).map(step => step.run || '').join('\n');
    expect(scripts).not.toContain('refs/heads/main');
    if(name.includes('promote')) expect(scripts).not.toMatch(/pnpm (?:run )?build|electron-builder/);
  });
  it('PR CI has no application/native builds', () => {
    const workflow = readWorkflow('ci.yml');
    expect(Object.keys(workflow.on)).toEqual(['pull_request']);
    expect(Object.keys(workflow.jobs)).toEqual(['typecheck', 'test']);
    expect(JSON.stringify(workflow)).not.toMatch(/pnpm (?:run )?build|electron-builder/);
  });
  it('Electron release does not look up a PWA deploy version', () => {
    const source = JSON.stringify(readWorkflow('app-release.yml'));
    expect(source).not.toContain('workflows/deploy.yml');
    expect(source).toContain('GITHUB_RUN_NUMBER');
  });
});
