// @ts-nocheck
/**
 * Offline e2e setup for tests driven through bootHarness: patches LocalRelay and
 * chromium.launch, so call it before bootHarness.
 */
import {WebSocketServer} from 'ws';
import {chromium} from 'playwright';
import {matchFilters} from 'nostr-tools';
import {LocalRelay} from './local-relay';

export function useIsolatedNetwork() {
  // An isolated NIP-01 relay avoids Docker permissions and shared test containers.
  let relayServer: WebSocketServer;
  LocalRelay.prototype.start = async function() {
    relayServer = new WebSocketServer({host: '127.0.0.1', port: 0});
    await new Promise<void>((resolve) => relayServer.once('listening', resolve));
    this.url = `ws://127.0.0.1:${relayServer.address().port}`;
    const events = new Map();
    const subscriptions = new Map();
    relayServer.on('connection', (socket) => {
      subscriptions.set(socket, new Map());
      socket.on('close', () => subscriptions.delete(socket));
      socket.on('message', (raw) => {
        const [kind, id, ...rest] = JSON.parse(String(raw));
        const send = (s, msg) => s.readyState === 1 && s.send(JSON.stringify(msg));
        if(kind === 'EVENT') {
          const event = id;
          events.set(event.id, event);
          send(socket, ['OK', event.id, true, '']);
          for(const [client, subs] of subscriptions) {
            for(const [sub, filters] of subs) {
              if(matchFilters(filters, event)) send(client, ['EVENT', sub, event]);
            }
          }
        } else if(kind === 'REQ') {
          subscriptions.get(socket).set(id, rest);
          for(const event of events.values()) {
            if(matchFilters(rest, event)) send(socket, ['EVENT', id, event]);
          }
          send(socket, ['EOSE', id]);
        } else if(kind === 'CLOSE') subscriptions.get(socket).delete(id);
      });
    });
  };
  LocalRelay.prototype.stop = async function() {
    for(const client of relayServer.clients) client.terminate();
    await new Promise<void>((resolve) => relayServer.close(() => resolve()));
  };

  // Keep onboarding independent of public profile/asset services. The actual
  // messaging transport is the local relay above; all app assets come from Vite.
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async(options) => {
    const browser = await launch({...options, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {})});
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async(contextOptions) => {
      const context = await newContext(contextOptions);
      context.on('page', (page) => {
        page.on('domcontentloaded', () => console.log('browser DOM loaded'));
        page.on('pageerror', (error) => console.error('browser pageerror:', error.message));
      });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
      });
      return context;
    };
    return browser;
  };
}
