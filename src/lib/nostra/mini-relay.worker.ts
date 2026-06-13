/**
 * mini-relay.worker.ts — Web Worker wrapper for MiniRelay
 *
 * Runs MiniRelay in a dedicated worker thread with a message-based protocol.
 * Handles init, peer lifecycle, and garbage collection.
 */

import {MiniRelay} from '@lib/nostra/mini-relay';
import {RelayStore} from '@lib/nostra/relay-store';

let relay: MiniRelay | null = null;
let store: RelayStore | null = null;
let gcInterval: ReturnType<typeof setInterval> | null = null;

const GC_INTERVAL = 60 * 60 * 1000;      // 1 hour
const EVENT_MAX_AGE = 72 * 3600;          // 72 hours in seconds
const FORWARD_MAX_AGE = 72 * 3600 * 1000; // 72 hours in ms

async function init(contactPubkeys: string[]): Promise<void> {
  store = new RelayStore();

  relay = new MiniRelay(store, contactPubkeys, (peerId: string, msg: string) => {
    self.postMessage({type: 'send', peerId, data: msg});
  });

  // Start garbage collection
  gcInterval = setInterval(async() => {
    if(!store) return;
    await store.pruneOlderThan(EVENT_MAX_AGE);
    await store.pruneForwardQueue(FORWARD_MAX_AGE);
  }, GC_INTERVAL);

  self.postMessage({type: 'ready'});
}

self.onmessage = async(e: MessageEvent) => {
  const msg = e.data;
  switch(msg.type) {
    case 'init':
      await init(msg.contactPubkeys || []);
      break;
    case 'peer-message':
      if(relay) await relay.handleMessage(msg.peerId, msg.data);
      break;
    case 'peer-connected':
      if(relay) await relay.onPeerConnected(msg.peerId, msg.pubkey);
      break;
    case 'peer-disconnected':
      if(relay) relay.onPeerDisconnected(msg.peerId);
      break;
    case 'update-contacts':
      if(relay) relay.updateContacts(msg.contactPubkeys);
      break;
    case 'stop':
      if(gcInterval) clearInterval(gcInterval);
      relay = null;
      store = null;
      self.postMessage({type: 'stopped'});
      break;
  }
};
