import type {NostrEvent} from '@lib/nostra/relay-store';
import {swallowHandler} from '@lib/nostra/log-swallow';

export type RoutePath = 'mesh-direct' | 'mesh-forward' | 'relay-external';

export interface RouteResult {
  path: RoutePath;
  delivered: boolean;
  forwardedVia?: string;
}

interface MeshManagerLike {
  getStatus(pubkey: string): 'connected' | 'connecting' | 'disconnected';
  getConnectedPeers(): string[];
  send(pubkey: string, message: string): boolean;
}

interface RouterDeps {
  meshManager: MeshManagerLike;
  relayPublish: (event: NostrEvent) => Promise<boolean>;
  getContactsForPeer: (pubkey: string) => string[];
}

export class MessageRouter {
  private deps: RouterDeps;

  constructor(deps: RouterDeps) {
    this.deps = deps;
  }

  async route(event: NostrEvent, recipientPubkey: string): Promise<RouteResult> {
    // Level 1: Direct mesh — recipient connected?
    if(this.deps.meshManager.getStatus(recipientPubkey) === 'connected') {
      const sent = this.deps.meshManager.send(
        recipientPubkey,
        JSON.stringify(['EVENT', event])
      );
      if(sent) {
        // Also publish to relay as backup (belt and suspenders)
        this.deps.relayPublish(event).catch(swallowHandler('MessageRouter.directBackupPublish'));
        return {path: 'mesh-direct', delivered: true};
      }
    }

    // Level 2: Forward via mutual contacts
    const mutualContacts = this.deps.getContactsForPeer(recipientPubkey);
    const connectedPeers = this.deps.meshManager.getConnectedPeers();
    for(const contactPubkey of mutualContacts) {
      if(connectedPeers.includes(contactPubkey)) {
        const sent = this.deps.meshManager.send(
          contactPubkey,
          JSON.stringify(['EVENT', event])
        );
        if(sent) {
          this.deps.relayPublish(event).catch(swallowHandler('MessageRouter.forwardBackupPublish'));
          return {path: 'mesh-forward', delivered: true, forwardedVia: contactPubkey};
        }
      }
    }

    // Level 3: Relay fallback
    const published = await this.deps.relayPublish(event);
    return {path: 'relay-external', delivered: published};
  }
}
