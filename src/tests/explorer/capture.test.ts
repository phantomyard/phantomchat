import {describe, expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {decodeMessages, encodeMessage} from '../../../scripts/explorer/ipc';
import {randomUUID} from 'node:crypto';

const SOCKET = `/tmp/exp-test-${randomUUID().slice(0, 8)}.sock`;

describe('driver capture', () => {
  it('returns observations for both pages', async() => {
    const driver = spawn('pnpm', ['explorer:driver', `--socket=${SOCKET}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Wait for READY on stdout.
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

    sock.write(encodeMessage({id: '1', cmd: 'capture'}));
    await new Promise((r) => setTimeout(r, 3000));

    expect(responses[0]).toMatchObject({id: '1', ok: true});
    expect(responses[0].data).toHaveProperty('A');
    expect(responses[0].data).toHaveProperty('B');
    expect(responses[0].data.A).toHaveProperty('url');
    expect(responses[0].data.A).toHaveProperty('screenshotPath');
    expect(responses[0].data.A).toHaveProperty('consoleTail');

    sock.write(encodeMessage({id: '2', cmd: 'teardown'}));
    await new Promise((r) => setTimeout(r, 1000));
    sock.end();
  }, 120_000);
});
