import {describe, expect, it} from 'vitest';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {checkRequest, hostBinaryPath, isAllowedCaller, PhantombotHostClient} from './client';

/** A fake host process that answers each request line with `reply`. */
function fakeHost(reply: (req: any, write: (msg: object) => void) => void) {
  const spawned: Array<{command: string; args: string[]; env: any}> = [];
  let child: any;
  const spawn = (command: string, args: string[], options: any) => {
    spawned.push({command, args, env: options.env});
    child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null, 'SIGTERM');
    let buf = '';
    child.stdin.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        reply(JSON.parse(line), (msg) => child.stdout.write(JSON.stringify(msg) + '\n'));
      }
    });
    child.stdin.on('finish', () => child.emit('exit', 0, null));
    return child;
  };
  return {spawn: spawn as any, spawned, child: () => child};
}

describe('phantombot bridge caller check', () => {
  it('allows only the app top frame, or the dev server in development', () => {
    expect(isAllowedCaller('app://localhost/index.html', true)).toBe(true);
    expect(isAllowedCaller('app://localhost/index.html', false)).toBe(false);
    expect(isAllowedCaller('app://evil/index.html', true)).toBe(false);
    expect(isAllowedCaller('https://phantomchat.chat/', true)).toBe(false);
    expect(isAllowedCaller('http://localhost:8080/', true)).toBe(false);
    expect(isAllowedCaller('http://localhost:8080/', true, 'http://localhost:8080')).toBe(true);
    expect(isAllowedCaller('http://localhost:9999/', true, 'http://localhost:8080')).toBe(false);
    expect(isAllowedCaller(undefined, true)).toBe(false);
  });

  it('checks method, params shape and size before anything is sent', () => {
    expect(checkRequest('rm -rf', {})).toMatchObject({code: 'invalid_argument'});
    expect(checkRequest('info', [])).toMatchObject({code: 'invalid_argument'});
    expect(checkRequest('info', undefined)).toEqual({method: 'info', params: {}});
    expect(checkRequest('persona.turn', {big: 'x'.repeat(1024 * 1024 + 1)})).toMatchObject({message: 'request too large'});
  });

  it('resolves the binary inside resources when packaged', () => {
    expect(hostBinaryPath(true, '/r', '/b', 'linux')).toBe('/r/phantombot/phantombot-host');
    expect(hostBinaryPath(false, '/r', '/b', 'win32')).toMatch(/phantombot-host\.exe$/);
  });
});

describe('PhantombotHostClient', () => {
  it('starts the host once, on first use, with its own root and without Electron node mode', async() => {
    process.env.ELECTRON_RUN_AS_NODE = '1';
    const host = fakeHost((req, write) => write({id: req.id, result: req.method}));
    const client = new PhantombotHostClient({binary: '/bin/host', root: '/data/phantombot', spawn: host.spawn});
    expect(host.spawned).toHaveLength(0);
    expect(await client.call('info', {})).toEqual({ok: true, value: 'info'});
    expect(await client.call('personas.list', {})).toEqual({ok: true, value: 'personas.list'});
    expect(host.spawned).toHaveLength(1);
    expect(host.spawned[0].args).toEqual(['--root', '/data/phantombot']);
    expect(host.spawned[0].env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    delete process.env.ELECTRON_RUN_AS_NODE;
  });

  it('routes turn events to the caller of that turn, then resolves', async() => {
    const host = fakeHost((req, write) => {
      write({event: 'turn', turnId: 'other', data: 'not mine'});
      write({event: 'turn', turnId: req.params.turnId, data: {type: 'text', text: 'hi'}});
      write({id: req.id, result: {text: 'hi'}});
    });
    const client = new PhantombotHostClient({binary: 'h', root: 'r', spawn: host.spawn});
    const events: unknown[] = [];
    const result = await client.call('persona.turn', {turnId: 't1'}, (_id, e) => events.push(e));
    expect(events).toEqual([{type: 'text', text: 'hi'}]);
    expect(result).toEqual({ok: true, value: {text: 'hi'}});
  });

  it('returns host errors as values, never throws', async() => {
    const host = fakeHost((req, write) => write({id: req.id, error: {code: 'root_locked', message: 'busy'}}));
    const client = new PhantombotHostClient({binary: 'h', root: 'r', spawn: host.spawn});
    expect(await client.call('info', {})).toEqual({ok: false, error: {code: 'root_locked', message: 'busy'}});
  });

  it('fails pending calls when the host dies, and starts a fresh one next time', async() => {
    const host = fakeHost(() => {});
    const client = new PhantombotHostClient({binary: 'h', root: 'r', spawn: host.spawn});
    const pending = client.call('info', {});
    await new Promise((r) => setTimeout(r, 0));
    host.child().emit('exit', 1, null);
    expect(await pending).toMatchObject({ok: false, error: {code: 'host_exited'}});
    expect(client.running).toBe(false);
    void client.call('info', {});
    expect(host.spawned).toHaveLength(2);
  });

  it('reports a missing binary as host_exited', async() => {
    const host = fakeHost(() => {});
    const client = new PhantombotHostClient({binary: 'h', root: 'r', spawn: host.spawn});
    const pending = client.call('info', {});
    await new Promise((r) => setTimeout(r, 0));
    host.child().emit('error', new Error('spawn h ENOENT'));
    expect(await pending).toMatchObject({ok: false, error: {code: 'host_exited', message: expect.stringContaining('ENOENT')}});
  });

  it('shuts down by closing stdin', async() => {
    const host = fakeHost((req, write) => write({id: req.id, result: null}));
    const client = new PhantombotHostClient({binary: 'h', root: 'r', spawn: host.spawn});
    await client.call('info', {});
    await client.shutdown(1000);
    expect(client.running).toBe(false);
  });
});
