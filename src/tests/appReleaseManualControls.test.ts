import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {load} from 'js-yaml';

type Step = {name?: string; if?: string; run?: string; env?: Record<string, string>};
type Job = {steps: Step[]; if?: string; needs?: string | string[]};
type Workflow = {on: Record<string, unknown>; permissions?: Record<string, string>; jobs: Record<string, Job>};
const readWorkflow = (name: string) => load(readFileSync(join(process.cwd(), '.github', 'workflows', name), 'utf8')) as Workflow;

describe('independent release controls', () => {
  it.each(['pwa-promote.yml', 'app-promote.yml'])('%s cannot build or publish on a push or merge', name => {
    const workflow = readWorkflow(name);
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    const scripts = Object.values(workflow.jobs).flatMap(job => job.steps).map(step => step.run || '').join('\n');
    expect(scripts).not.toContain('refs/heads/main');
    if(name.includes('promote')) expect(scripts).not.toMatch(/pnpm (?:run )?build|electron-builder/);
  });
  it.each(['deploy.yml', 'app-release.yml'])('%s publishes Preview automatically only from main and supports manual dispatch', name => {
    const workflow = readWorkflow(name);
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(workflow.on.push).toEqual({branches: ['main']});
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
    expect(steps.some(step => 'environment' in step)).toBe(false);
    // Release mode is env-driven inside build.mjs: any of these turns the dry
    // build into a promotion build against live bytes.
    const env = steps.map(step => JSON.stringify(step.env ?? {})).join('\n');
    expect(env).not.toMatch(/PWA_RELEASE|CHANNEL_BASELINE|PWA_STABLE_DIST/);
    // Exactly one build, and it is the plain channel build off repo config.
    const builds = steps.filter(step => /pnpm (?:run )?build/.test(step.run || ''));
    expect(builds).toHaveLength(1);
    expect((builds[0].run || '').trim()).toBe('pnpm run build');
    // Cost control: a PR that cannot affect the build must not pay for it.
    expect(workflow.jobs['channel-build'].needs).toContain('changes');
    expect(workflow.jobs['channel-build'].if ?? '').toContain('needs.changes.outputs.relevant');
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
