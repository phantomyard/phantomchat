import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {load} from 'js-yaml';

type Step = {id?: string; name?: string; if?: string; run?: string; env?: Record<string, string>};
type Job = {steps: Step[]; if?: string; needs?: string | string[]; env?: Record<string, string>; environment?: unknown};
type Workflow = {on: Record<string, unknown>; permissions?: Record<string, string>; env?: Record<string, string>; jobs: Record<string, Job>};
const readWorkflow = (name: string) => load(readFileSync(join(process.cwd(), '.github', 'workflows', name), 'utf8')) as Workflow;

describe('independent release controls', () => {
  it.each(['pwa-promote.yml', 'app-promote.yml'])('%s cannot build or publish on a push or merge', name => {
    const workflow = readWorkflow(name);
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const scripts = Object.values(workflow.jobs).flatMap(job => job.steps).map(step => step.run || '').join('\n');
    expect(scripts).not.toContain('refs/heads/main');
    if(name.includes('promote')) expect(scripts).not.toMatch(/pnpm (?:run )?build|electron-builder/);
  });
  it('PWA Preview publishes automatically only from main and supports manual dispatch', () => {
    const workflow = readWorkflow('deploy.yml');
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(workflow.on.push).toEqual({branches: ['main']});
  });
  it('Electron Preview can only be started by hand, never by a push or merge', () => {
    expect(Object.keys(readWorkflow('app-release.yml').on)).toEqual(['workflow_dispatch']);
  });
  it('Stable promotion boots the assembled artifact before deployment without rebuilding', () => {
    const steps = readWorkflow('pwa-promote.yml').jobs.promote.steps;
    const bootIndex = steps.findIndex(step => step.run?.includes('scripts/channels/browser-smoke.mjs'));
    const deployIndex = steps.findIndex(step => JSON.stringify(step).includes('actions/deploy-pages@'));
    expect(bootIndex).toBeGreaterThanOrEqual(0);
    expect(deployIndex).toBeGreaterThan(bootIndex);
  });
  it('PR CI may compile both channels dry, but can never assemble a release or publish', () => {
    const workflow = readWorkflow('ci.yml');
    // Still only PRs: no push or dispatch path into a release.
    expect(Object.keys(workflow.on)).toEqual(['pull_request']);
    expect(workflow.permissions).toEqual({contents: 'read'});
    expect(Object.keys(workflow.jobs).sort()).toEqual(['changes', 'channel-build', 'test', 'typecheck']);

    const steps = Object.values(workflow.jobs).flatMap(job => job.steps);
    const serialized = JSON.stringify(workflow);
    // The publication surface: no Pages upload/deploy, no GitHub release, no
    // packaging. Release-record lookups are banned too — PR CI must compile
    // from the repo's pinned config, never from deployed truth.
    expect(serialized).not.toMatch(/deploy-pages|upload-pages-artifact|actions\/(?:create|upload)-release|electron-builder/);
    expect(serialized).not.toMatch(/scripts\/releases\/registry\.mjs|check-site\.mjs/);
    // A Pages environment attached to a PR job is a publish-shaped hole.
    // GitHub only accepts `environment` on a JOB, never on a step, so the
    // check has to sit there or it passes whatever the workflow says.
    expect(Object.values(workflow.jobs).some(job => 'environment' in job)).toBe(false);
    // Release mode is env-driven inside build.mjs: any of these turns the dry
    // build into a promotion build against live bytes. `env` is legal at
    // workflow, job AND step scope, so match the whole workflow rather than
    // one scope that a job-level value would slip past.
    expect(serialized).not.toMatch(/PWA_RELEASE|CHANNEL_BASELINE|PWA_STABLE_DIST/);
    // Exactly one build, and it is the plain channel build off repo config.
    const builds = steps.filter(step => /pnpm (?:run )?build/.test(step.run || ''));
    expect(builds).toHaveLength(1);
    expect((builds[0].run || '').trim()).toBe('pnpm run build');
    // Cost control: a PR that cannot affect the build must not pay for it.
    expect(workflow.jobs['channel-build'].needs).toContain('changes');
    expect(workflow.jobs['channel-build'].if ?? '').toContain('needs.changes.outputs.relevant');
    // ...but the list that decides "relevant" has to cover everything the
    // builder reads, because a skipped job counts as a satisfied job: a build
    // entry point missing from the filter would not fail, it would skip, and
    // the run would still report green. So derive the inputs from build.mjs
    // itself rather than trusting a second hand-maintained list.
    const filterRun = workflow.jobs.changes.steps.find(step => step.id === 'filter')?.run ?? '';
    const filterPattern = /grep -Eq '([^']+)'/.exec(filterRun)?.[1];
    expect(filterPattern).toBeTruthy();
    const relevant = new RegExp(filterPattern as string);
    const builder = readFileSync(join(process.cwd(), 'scripts', 'channels', 'build.mjs'), 'utf8');
    const builderInputs = [
      ...builder.matchAll(/readFileSync\('([^']+)'/g),
      ...builder.matchAll(/patch\('([^']+)'/g),
      ...builder.matchAll(/git', \['show', `\$\{candidate\}:([^`$]+)`/g),
      ...builder.matchAll(/^ {6}'([a-z0-9][\w.-]*\/[\w./-]+\.ts)',?$/gm)
    ].map(match => match[1]);
    expect(new Set(builderInputs).size).toBeGreaterThanOrEqual(8);
    for(const input of builderInputs) expect(relevant.test(input), `build.mjs reads ${input} but the changes filter does not match it`).toBe(true);
  });
  it('every Electron Preview job remains main-only', () => {
    const workflow = readWorkflow('app-release.yml');
    for(const job of Object.values(workflow.jobs)) {
      expect((job as {if?: string}).if).toContain("github.ref == 'refs/heads/main'");
    }
  });
  it('Electron release does not look up a PWA deploy version', () => {
    const source = JSON.stringify(readWorkflow('app-release.yml'));
    expect(source).not.toContain('workflows/deploy.yml');
    expect(source).toContain('GITHUB_RUN_NUMBER');
  });
});
