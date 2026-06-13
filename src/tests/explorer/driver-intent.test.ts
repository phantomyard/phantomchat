import {describe, expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {decodeMessages, encodeMessage} from '../../../scripts/explorer/ipc';
import {randomUUID} from 'node:crypto';

const SOCKET = `/tmp/exp-test-${randomUUID().slice(0, 8)}.sock`;

describe('driver intent dispatch', () => {
  it('runs send_text_message intent and returns ok=true with atomic_trace', async() => {
    const driver = spawn('pnpm', ['explorer:driver', `--socket=${SOCKET}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('driver did not READY in 90s')), 90_000);
      driver.stdout!.on('data', (b) => {
        if(b.toString('utf8').includes('[driver] listening')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    const sock = createConnection(SOCKET);
    let buf = '';
    const responses: any[] = [];
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const {messages, remainder} = decodeMessages(buf);
      buf = remainder;
      responses.push(...messages);
    });

    sock.write(encodeMessage({
      id: '1',
      cmd: 'intent',
      intentName: 'send_text_message',
      params: {from: 'userA', text: 'hello explorer'}
    }));
    await new Promise((r) => setTimeout(r, 8000));

    expect(responses[0]).toMatchObject({id: '1', ok: true});
    expect(responses[0].data.atomic_trace).toBeInstanceOf(Array);
    expect(responses[0].data.atomic_trace.length).toBeGreaterThan(0);

    sock.write(encodeMessage({id: '2', cmd: 'teardown'}));
    await new Promise((r) => setTimeout(r, 1000));
    sock.end();
  }, 180_000);

  it('returns ok=false with error for unknown intent', async() => {
    const sock2 = `/tmp/exp-test-${randomUUID().slice(0, 8)}.sock`;
    const _driver = spawn('pnpm', ['explorer:driver', `--socket=${sock2}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('driver did not READY in 90s')), 90_000);
      _driver.stdout!.on('data', (b) => {
        if(b.toString('utf8').includes('[driver] listening')) {clearTimeout(timeout); resolve();}
      });
    });
    const sock = createConnection(sock2);
    let buf = '';
    const responses: any[] = [];
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const {messages, remainder} = decodeMessages(buf);
      buf = remainder;
      responses.push(...messages);
    });
    sock.write(encodeMessage({id: '1', cmd: 'intent', intentName: 'nope_does_not_exist', params: {}}));
    await new Promise((r) => setTimeout(r, 2000));
    expect(responses[0]).toMatchObject({id: '1', ok: false});
    expect(responses[0].error).toContain('unknown intent');
    sock.write(encodeMessage({id: '2', cmd: 'teardown'}));
    await new Promise((r) => setTimeout(r, 1000));
    sock.end();
  }, 180_000);
});
