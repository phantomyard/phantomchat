import {createConnection} from 'node:net';
import {decodeMessages, encodeMessage} from './ipc';

/**
 * Send one JSON-line request to a Unix domain socket and resolve with the
 * first JSON-line response. Rejects on timeout or socket error.
 */
export function sendOnce(
  socketPath: string,
  request: {id: string; [k: string]: unknown},
  timeoutMs: number = 30_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buf = '';
    let settled = false;
    const finish = (err: Error | null, value?: unknown) => {
      if(settled) return;
      settled = true;
      try {sock.end();} catch{}
      if(err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`sendOnce timeout after ${timeoutMs}ms`)), timeoutMs);

    sock.on('connect', () => {
      sock.write(encodeMessage(request));
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const {messages, remainder} = decodeMessages(buf);
      buf = remainder;
      if(messages.length > 0) {
        clearTimeout(timer);
        finish(null, messages[0]);
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });
  });
}

async function main() {
  const [sockPath, jsonReq] = process.argv.slice(2);
  if(!sockPath || !jsonReq) {
    console.error('Usage: tsx scripts/explorer/socket-client.ts <socketPath> <jsonRequest>');
    process.exit(2);
  }
  let req: {id: string; [k: string]: unknown};
  try {
    req = JSON.parse(jsonReq);
  } catch(err: any) {
    console.error(`invalid JSON request: ${err?.message ?? String(err)}`);
    process.exit(2);
  }
  if(!req.id) req.id = String(Date.now());
  try {
    const resp = await sendOnce(sockPath, req);
    console.log(JSON.stringify(resp));
  } catch(err: any) {
    console.error(`sendOnce failed: ${err?.message ?? String(err)}`);
    process.exit(3);
  }
}

if(process.argv[1] && process.argv[1].endsWith('socket-client.ts')) {
  main();
}
