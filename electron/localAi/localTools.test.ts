import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {LocalToolRunner} from './localTools';
import type {ToolCall} from './localAccess';

const SENDER = 'b'.repeat(64);
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'local-tools-'));
});
afterEach(() => {
  rmSync(dir, {recursive: true, force: true});
});

function call(extra: Partial<ToolCall> = {}): ToolCall {
  return {callId: 'c1', deviceId: 'd', tool: 'bash', args: {command: 'x'}, expiresAt: Date.now() + 1000, ...extra};
}

function hanging() {
  return async() => ({
    execute: (_id: string, _args: unknown, signal: AbortSignal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({content: [{type: 'text', text: 'partial'}], isError: true}));
    })
  });
}

describe('LocalToolRunner', () => {
  it('returns output and exit, and logs metadata only', async() => {
    const runner = new LocalToolRunner({
      logPath: join(dir, 'log'),
      onActivity: () => {},
      resolveTool: async() => ({
        execute: async() => ({content: [{type: 'text', text: 'SECRET-OUTPUT'}], structuredContent: {exit_code: 3}, isError: true})
      })
    });
    const result = await runner.run(SENDER, call({args: {command: 'SECRET-COMMAND'}}));
    expect(result).toEqual({status: 'error', output: 'SECRET-OUTPUT', exit: 3});
    const log = readFileSync(join(dir, 'log'), 'utf8');
    expect(JSON.parse(log)).toMatchObject({contact: SENDER, tool: 'bash', exit: 3});
    expect(log).not.toContain('SECRET');
  });

  it('turning the switch OFF cancels that contact and nobody else', async() => {
    const runner = new LocalToolRunner({logPath: join(dir, 'log'), onActivity: () => {}, resolveTool: hanging()});
    const mine = runner.run(SENDER, call({callId: 'mine'}));
    const theirs = runner.run('c'.repeat(64), call({callId: 'theirs'}));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runner.revoke(SENDER)).toBe(1);
    expect((await mine).status).toBe('cancelled');
    expect(runner.running).toBe(1);
    runner.revoke('c'.repeat(64));
    await theirs;
  });

  it('only lets a contact cancel its own call', async() => {
    const runner = new LocalToolRunner({logPath: join(dir, 'log'), onActivity: () => {}, resolveTool: hanging()});
    const pending = runner.run(SENDER, call());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runner.cancel('c'.repeat(64), 'c1')).toBe(false);
    expect(runner.cancel(SENDER, 'c1')).toBe(true);
    expect((await pending).status).toBe('cancelled');
  });

  it('times out', async() => {
    const runner = new LocalToolRunner({logPath: join(dir, 'log'), onActivity: () => {}, resolveTool: hanging()});
    expect((await runner.run(SENDER, call({timeoutMs: 5}))).status).toBe('timeout');
  });

  it('reports a tool failure instead of throwing, without naming the runtime', async() => {
    const runner = new LocalToolRunner({
      logPath: join(dir, 'log'),
      onActivity: () => {},
      resolveTool: async() => {
        throw new Error('Pi could not start');
      }
    });
    const result = await runner.run(SENDER, call());
    expect(result.status).toBe('error');
    expect(result.output).not.toMatch(/\bPi\b/);
  });

  it('runs the real tools with no provider configured', async() => {
    const {PiRuntime} = await import('./piRuntime');
    const home = join(dir, 'home');
    const piRoot = join(process.cwd(), 'electron/pi-harness/node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js');
    const pi = new PiRuntime({sdkPath: piRoot, dataDir: join(dir, 'data'), openExternal: () => {}, askUser: async() => '', home: dir});
    writeFileSync(join(dir, 'file.txt'), 'hello from the file');
    const runner = new LocalToolRunner({logPath: join(dir, 'log'), onActivity: () => {}, resolveTool: (name) => pi.tool(name)});
    const read = await runner.run(SENDER, call({callId: 'r', tool: 'read', args: {path: join(dir, 'file.txt')}}));
    expect(read.output).toContain('hello from the file');
    const bash = await runner.run(SENDER, call({callId: 'b', args: {command: 'echo out; exit 4'}}));
    expect(bash).toMatchObject({exit: 4});
    expect(bash.output).toContain('out');
    expect(home).toBeTruthy();
  }, 30000);
});
