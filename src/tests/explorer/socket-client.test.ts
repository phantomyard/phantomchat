import {describe, expect, it} from 'vitest';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {sendOnce} from '../../../scripts/explorer/socket-client';
import {encodeMessage, decodeMessages} from '../../../scripts/explorer/ipc';
import {unlinkSync, existsSync} from 'node:fs';

describe('sendOnce — Unix socket JSON-RPC client', () => {
  it('sends one request and returns the parsed response', async() => {
    const sockPath = `/tmp/exp-test-sc-${randomUUID().slice(0, 8)}.sock`;
    if(existsSync(sockPath)) unlinkSync(sockPath);

    const server = createServer((sock) => {
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const {messages, remainder} = decodeMessages(buf);
        buf = remainder;
        for(const raw of messages) {
          const r = raw as {id: string; cmd: string};
          sock.write(encodeMessage({id: r.id, ok: true, data: {echoed: r.cmd}}));
        }
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));

    try {
      const response = await sendOnce(sockPath, {id: '1', cmd: 'capture'}, 5000);
      expect(response).toEqual({id: '1', ok: true, data: {echoed: 'capture'}});
    } finally {
      server.close();
      if(existsSync(sockPath)) unlinkSync(sockPath);
    }
  });

  it('rejects on timeout if the server never responds', async() => {
    const sockPath = `/tmp/exp-test-sc-${randomUUID().slice(0, 8)}.sock`;
    if(existsSync(sockPath)) unlinkSync(sockPath);
    const server = createServer(() => { /* never write a response */ });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));

    try {
      await expect(sendOnce(sockPath, {id: '1', cmd: 'capture'}, 200)).rejects.toThrow(/timeout/i);
    } finally {
      server.close();
      if(existsSync(sockPath)) unlinkSync(sockPath);
    }
  });
});
