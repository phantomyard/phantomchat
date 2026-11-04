import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {chunkResult, LocalToolsHost, type EngineTools} from './host';

const OWNER = 'a'.repeat(64);
const PHANTOM = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
const DEVICE = '0'.repeat(32);
const NOW = 1_800_000_000_000;
const dirs: string[] = [];

function setup(confirm = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'lt-'));
  dirs.push(dataDir);
  const pending = new Map<string, (r: any) => void>();
  const tools: EngineTools = {
    run: vi.fn((runId: string, tool: string, args: any) => args.hang ?
      new Promise((resolve) => pending.set(runId, resolve)) :
      Promise.resolve({status: 'ok' as const, output: `${tool}:${JSON.stringify(args)}`, exit: 0})),
    cancel: vi.fn(async(runId: string) => pending.get(runId)?.({status: 'error', output: 'aborted'}))
  };
  const host = new LocalToolsHost({dataDir, tools, confirm: async() => confirm, now: () => NOW, newDeviceId: () => DEVICE, deviceName: 'pc'});
  host.setOwner(OWNER);
  return {host, tools, dataDir};
}

const call = (callId: string, args: Record<string, unknown> = {command: 'ls'}, extra: Record<string, unknown> = {}) =>
  ({t: 'call', callId, deviceId: DEVICE, tool: 'bash', args, expiresAt: NOW + 60_000, ...extra});

afterEach(() => {
  for(const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true});
});

describe('Local tools host', () => {
  it('answers nothing while the switch is off', async() => {
    const {host, tools} = setup();
    expect(await host.handleMessage(PHANTOM, {t: 'hello'}, null)).toEqual([]);
    expect(await host.handleMessage(PHANTOM, call('c1'), null)).toEqual([]);
    expect(tools.run).not.toHaveBeenCalled();
  });

  it('turns on only after Allow, then advertises and runs calls once', async() => {
    const declined = setup(false);
    expect(await declined.host.setLocalAccess(PHANTOM, true, 'Kai')).toEqual({enabled: false, notify: null});

    const {host, tools} = setup();
    const on = await host.setLocalAccess(PHANTOM, true, 'Kai');
    expect(on.enabled).toBe(true);
    expect(on.notify).toMatchObject({t: 'capability', deviceId: DEVICE, tools: ['bash', 'read', 'write', 'edit', 'ls', 'find', 'grep']});
    expect(await host.handleMessage(PHANTOM, {t: 'hello'}, null)).toHaveLength(1);
    const res = await host.handleMessage(PHANTOM, call('c1'), null);
    expect(res).toEqual(chunkResult('c1', {status: 'ok', output: 'bash:{"command":"ls"}', exit: 0}));
    expect(await host.handleMessage(PHANTOM, call('c1'), null)).toEqual([]);
    expect(tools.run).toHaveBeenCalledTimes(1);
    // Another contact gets nothing, and the owner can never be switched on.
    expect(await host.handleMessage(OTHER, call('c2'), null)).toEqual([]);
    expect((await host.setLocalAccess(OWNER, true, 'me')).enabled).toBe(false);
  });

  it('off cancels what that contact has running and says revoked', async() => {
    const {host, tools} = setup();
    await host.setLocalAccess(PHANTOM, true, 'Kai');
    const running = host.handleMessage(PHANTOM, call('c1', {hang: true}), null);
    await vi.waitFor(() => expect(host.runningCount).toBe(1));
    expect((await host.setLocalAccess(PHANTOM, false, 'Kai')).notify).toEqual({t: 'revoked', deviceId: DEVICE});
    const [result] = await running;
    expect(JSON.parse((result as any).data).status).toBe('cancelled');
    expect(tools.cancel).toHaveBeenCalled();
  });

  it('a contact cancels only its own call', async() => {
    const {host} = setup();
    await host.setLocalAccess(PHANTOM, true, 'Kai');
    await host.setLocalAccess(OTHER, true, 'Lena');
    const mine = host.handleMessage(PHANTOM, call('same', {hang: true}), null);
    await vi.waitFor(() => expect(host.runningCount).toBe(1));
    await host.handleMessage(OTHER, {t: 'cancel', callId: 'same'}, null);
    expect(host.runningCount).toBe(1);
    await host.handleMessage(PHANTOM, {t: 'cancel', callId: 'same'}, null);
    const [result] = await mine;
    expect(JSON.parse((result as any).data).status).toBe('cancelled');
  });

  it('a new identity starts with every switch off; the log has no command', async() => {
    const {host, dataDir} = setup();
    await host.setLocalAccess(PHANTOM, true, 'Kai');
    await host.handleMessage(PHANTOM, call('c1', {command: 'cat secret.txt'}), null);
    expect(readFileSync(join(dataDir, 'local-tools.log'), 'utf8')).not.toContain('secret');
    host.setOwner(OTHER);
    expect(host.enabled()).toEqual([]);
  });

  it('splits a large result and the parts join back', () => {
    const parts = chunkResult('c', {status: 'ok', output: 'x'.repeat(50)}, 20);
    expect(parts.length).toBeGreaterThan(1);
    expect(JSON.parse(parts.map((p: any) => p.data).join(''))).toEqual({status: 'ok', output: 'x'.repeat(50)});
  });
});
