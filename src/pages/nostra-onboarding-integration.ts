/**
 * Nostra.chat Onboarding Integration for tweb
 *
 * Mounts NostraOnboarding inside tweb's auth-pages container when
 * `?nostra=1` is set, replacing the phone/SMS auth flow.
 *
 * Flow:
 * 1. User lands on / (no identity) → sees NostraOnboarding UI
 * 2. User generates identity → onIdentityCreated callback fires
 * 3. Callback: init NostraBridge → store own mapping → enable flag → mount chat → init Virtual MTProto Server
 * 4. User reloads (identity exists) → init() → showExistingIdentity → callback fires → mount chat → init Virtual MTProto Server
 */

import {loadEncryptedIdentity, loadBrowserKey, decryptKeys} from '../lib/nostra/key-storage';
import {importFromMnemonic} from '../lib/nostra/nostr-identity';
import {NostraBridge} from '../lib/nostra/nostra-bridge';
import {NostraOnboarding} from './nostra/onboarding';
import {ChatAPI} from '../lib/nostra/chat-api';
import {NostraMTProtoServer} from '../lib/nostra/virtual-mtproto-server';
import {NostraSync} from '../lib/nostra/nostra-sync';
import {MOUNT_CLASS_TO} from '@config/debug';
import rootScope from '../lib/rootScope';
import {handleIncomingMessage, handleIncomingEdit, resetUnreadForPeer} from '@lib/nostra/nostra-message-handler';
import {createPendingFlush} from '@lib/nostra/nostra-pending-flush';
import {createReadReceiptSender} from '@lib/nostra/nostra-read-receipts';
import {createDeliveryUI} from '@lib/nostra/nostra-delivery-ui';
import {FoldersSync} from '@lib/nostra/folders-sync';
import {setLastModifiedAt} from '@lib/nostra/folders-sync-state';
import {getConversationKey, nip44Encrypt, nip44Decrypt} from '@lib/nostra/nostr-crypto';
import {toast} from '@components/toast';
import I18n from '@lib/langPack';
// tweb-contained CSS no longer needed — onboarding uses native tweb styles

declare global {
  interface Window {
    __nostraChatAPI?: ChatAPI;
  }
}

export interface OnboardingMount {
  onboarding: NostraOnboarding;
  destroy: () => void;
}

/**
 * Mount NostraOnboarding into a container element.
 */
export async function mountNostraOnboarding(container: HTMLElement): Promise<OnboardingMount> {
  const onboarding = new NostraOnboarding();
  container.appendChild(onboarding.container);

  let identityHandled = false;

  const handleIdentity = async() => {
    if(identityHandled) return;
    identityHandled = true;
    window.removeEventListener('nostra-identity-created', handleIdentityFallback);
    console.log('[NostraOnboardingIntegration] onIdentityCreated fired');

    try {
      // --- Load & decrypt identity ---
      const record = await loadEncryptedIdentity();
      if(!record) {
        console.error('[NostraOnboardingIntegration] no identity in callback');
        return;
      }
      const browserKey = await loadBrowserKey();
      if(!browserKey) {
        console.error('[NostraOnboardingIntegration] browser key missing');
        return;
      }
      const {seed} = await decryptKeys(record.iv, record.encryptedKeys, browserKey);
      const identity = importFromMnemonic(seed);

      // Populate nostraIdentity store
      rootScope.dispatchEvent('nostra_identity_loaded', {
        npub: identity.npub,
        displayName: record.displayName || null,
        nip05: undefined,
        protectionType: 'none'
      });

      // --- Initialize bridge ---
      const bridge = NostraBridge.getInstance();
      await bridge.init(identity.publicKey);

      // Publish NIP-65 relay list
      try {
        const privKeyBytes = new Uint8Array(identity.privateKey.match(/.{2}/g)!.map(b => parseInt(b, 16)));
        bridge.publishNip65(privKeyBytes);
      } catch(err) {
        console.warn('[NostraOnboardingIntegration] NIP-65 publish failed:', err);
      }

      // Store own-pubkey → own-peerId mapping
      const ownPeerId = await bridge.mapPubkeyToPeerId(identity.publicKey);
      await bridge.storePeerMapping(identity.publicKey, ownPeerId, record.displayName || 'Me');
      console.log('[NostraOnboardingIntegration] own mapping stored: peerId', ownPeerId);

      // --- Initialize Virtual MTProto Server ---
      const server = new NostraMTProtoServer();
      server.setOwnPubkey(identity.publicKey);
      // FIND-0ed3a22c: seed the pts high-water-mark from persisted state
      // BEFORE registering the proxy, so the first VMT response that emits
      // an update event allocates a pts strictly greater than the value
      // apiUpdatesManager will restore from disk. Without this, returning
      // users hit the dedup gate on every deleteMessages until VMT's
      // counter climbs past the persisted ceiling — silently regressing
      // the original bug.
      try {
        const persisted = await rootScope.managers.appStateManager.getState();
        if(persisted?.updates?.pts) {
          server.seedPts(persisted.updates.pts);
        }
      } catch(err) {
        console.warn('[NostraOnboardingIntegration] seedPts read failed (non-fatal):', err);
      }
      const proxy = MOUNT_CLASS_TO.apiManagerProxy;
      if(proxy) {
        proxy.setNostraMTProtoServer(server);
      }
      (window as any).__nostraMTProtoServer = server;
      (window as any).__nostraOwnPubkey = identity.publicKey;
      console.log('[NostraOnboardingIntegration] Virtual MTProto Server registered');

      // --- Import chat page (loads the module graph incl. nostraIdentity store) ---
      const pageIm = await import('./pageIm');

      // Re-dispatch identity_loaded so stores registered inside pageIm module graph
      // (e.g. nostraIdentity.ts) pick up the npub after their module is loaded.
      rootScope.dispatchEventSingle('nostra_identity_loaded', {
        npub: identity.npub,
        displayName: record.displayName || null,
        nip05: undefined,
        protectionType: 'none'
      });

      // Hydrate own profile from the local cache BEFORE mounting so the
      // sidebar menu (avatar, name, bio) renders with the correct values on
      // the very first read — otherwise the hamburger profile entry would
      // show a dicebear placeholder until the background relay fetch lands.
      let refreshOwnProfileFromRelaysFn: ((pk: string) => Promise<unknown>) | null = null;
      try {
        const {hydrateOwnProfileFromCache, refreshOwnProfileFromRelays} =
          await import('@lib/nostra/own-profile-sync');
        hydrateOwnProfileFromCache();
        refreshOwnProfileFromRelaysFn = refreshOwnProfileFromRelays;
      } catch(err) {
        console.warn('[NostraOnboardingIntegration] own profile sync init failed:', err);
      }

      // --- Mount chat page ---
      pageIm.default.mount();

      // Kick off background relay fetch to pick up edits made from other devices.
      refreshOwnProfileFromRelaysFn?.(identity.publicKey).catch((err) => {
        console.warn('[NostraOnboardingIntegration] own profile relay refresh failed:', err);
      });

      // --- Initialize ChatAPI ---
      const chatAPI = new ChatAPI(identity.publicKey);
      window.__nostraChatAPI = chatAPI;
      server.setChatAPI(chatAPI);
      console.log('[NostraOnboardingIntegration] ChatAPI initialized');

      // --- Initialize GroupAPI ---
      //
      // GroupAPI internally calls handleGroupIncoming/handleGroupOutgoing
      // (nostra-groups-sync) for the render pipeline. We pass a dispatch
      // function that forwards nostra_new_message onto rootScope so
      // downstream listeners (mesh signaling, etc) see group messages the
      // same way they see DMs. Closes FIND-dbe8fdd2.
      try {
        const {initGroupAPI} = await import('@lib/nostra/group-api');
        const privKeyBytes = new Uint8Array(identity.privateKey.match(/.{2}/g)!.map(b => parseInt(b, 16)));
        const pool = bridge.getRelayPool();
        const publishFn = async(events: any[]) => {
          if(!pool) return;
          for(const event of events) {
            await pool.publishRawEvent(event);
          }
        };
        const groupDispatch = (event: string, data: any) => {
          rootScope.dispatchEvent(event as any, data);
        };
        initGroupAPI(identity.publicKey, privKeyBytes, publishFn, groupDispatch);
        console.log('[NostraOnboardingIntegration] GroupAPI initialized with render pipeline');
      } catch(err) {
        console.warn('[NostraOnboardingIntegration] GroupAPI init failed:', err);
      }

      // --- Initialize NostraSync ---
      const sync = new NostraSync(identity.publicKey, (event: string, data: any) => {
        rootScope.dispatchEvent(event as any, data);
      });
      chatAPI.onMessage = (msg: any) => {
        sync.onIncomingMessage(msg, msg.from);
      };
      chatAPI.onEditMessage = (edit: any) => {
        sync.onIncomingEdit(edit);
      };
      console.log('[NostraOnboardingIntegration] NostraSync wired to ChatAPI');

      // Defer the ChatAPI's global subscription until the PrivacyTransport
      // has reached tor-active when Tor is required. ChatAPI owns its own
      // NostrRelayPool which would otherwise open direct WebSockets to every
      // relay the moment initGlobalSubscription runs — leaking the user IP
      // for the full duration of the Tor bootstrap in Tor-only mode.
      const startChatAPI = () => {
        chatAPI.initGlobalSubscription().catch((err) => {
          console.warn('[NostraOnboardingIntegration] global subscription failed:', err);
        });
      };

      const mode = (await import('@lib/nostra/privacy-transport')).PrivacyTransport.readMode();
      if(mode === 'only') {
        // In only-mode we must wait for Tor before ChatAPI opens its relay sockets.
        const transport = (window as any).__nostraTransport;
        const getState = () => transport?.getRuntimeState?.();
        if(getState() === 'tor-active') {
          startChatAPI();
        } else {
          const handler = (e: {state: string}) => {
            if(e.state === 'tor-active') {
              rootScope.removeEventListener('nostra_tor_state', handler);
              startChatAPI();
            }
          };
          rootScope.addEventListener('nostra_tor_state', handler);
        }
      } else {
        // when-available / off — ChatAPI starts immediately.
        startChatAPI();
      }

      // --- Wire extracted modules ---
      const pendingFlush = createPendingFlush();
      const readReceipts = createReadReceiptSender();
      const deliveryUI = createDeliveryUI();

      // Incoming message handler
      rootScope.addEventListener('nostra_new_message', async(data) => {
        try {
          const result = await handleIncomingMessage(data, identity.publicKey);
          if(result) {
            pendingFlush.enqueue(result.peerId, result.msg);
          }
        } catch(err) {
          console.warn('[NostraOnboardingIntegration] nostra_new_message handler error:', err);
        }
      });

      // Incoming edit handler — updates existing bubble in place
      rootScope.addEventListener('nostra_message_edit', async(data) => {
        try {
          await handleIncomingEdit(data, identity.publicKey);
        } catch(err) {
          console.warn('[NostraOnboardingIntegration] nostra_message_edit handler error:', err);
        }
      });

      // Pending flush with read receipts on peer open
      pendingFlush.attachListener((peerId) => {
        readReceipts.sendForPeer(peerId).catch((err) => {
          console.warn('[NostraOnboardingIntegration] markRead batch failed:', err);
        });
      });
      pendingFlush.startPeriodicFlush();

      // --- Background push notifications ---
      // Auto-subscribe when notification permission is already granted at boot.
      // VAPID public key is fetched (and localStorage-cached) via resolveVapidKey.
      (async() => {
        try {
          if(typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
          const {subscribePush, getRegistration} = await import('@lib/nostra/nostra-push-client');
          const {resolveVapidKey} = await import('@lib/nostra/nostra-push-helpers');
          const pubkeyHex = identity.publicKey;
          const existing = await getRegistration();
          if(existing && existing.pubkey === pubkeyHex) return;

          const transport = (window as any).__nostraTransport;
          const torActive = transport?.getRuntimeState?.() === 'tor-active';
          const fetchFn: typeof fetch | undefined = torActive && typeof transport?.fetch === 'function' ?
            ((input: RequestInfo | URL, init?: RequestInit) => transport.fetch(typeof input === 'string' ? input : input.toString(), init)) as typeof fetch :
            undefined;

          const vapidKey = await resolveVapidKey();
          if(!vapidKey) return;

          const privkeyHex = identity.privateKey;
          const rec = await subscribePush({
            pubkeyHex,
            privkeyHex,
            vapidPublicKey: vapidKey,
            fetchFn
          });
          if(rec) {
            rootScope.dispatchEvent('nostra_push_subscription_changed' as any, {
              state: 'registered',
              pubkey: rec.pubkey
            });
          }
        } catch(err) {
          console.warn('[NostraOnboardingIntegration] push subscribe failed:', err);
        }
      })();

      // Clear the main-thread unread counter as soon as a P2P peer's chat
      // is opened — the standard readHistory path can't decrement synthetic
      // dialogs, so the badge would otherwise stay visible.
      const attachUnreadReset = () => {
        const im = (MOUNT_CLASS_TO as any).appImManager;
        if(!im?.addEventListener) {
          setTimeout(attachUnreadReset, 500);
          return;
        }
        im.addEventListener('peer_changed', (chat: any) => {
          const pid = +chat?.peerId;
          if(pid) {
            resetUnreadForPeer(pid).catch((err) => {
              console.warn('[NostraOnboardingIntegration] resetUnread error:', err);
            });
          }
        });
      };
      attachUnreadReset();

      // Delivery status UI
      deliveryUI.attach();

      // --- Initialize folders sync (kind 30078, self-encrypted) ---
      try {
        const privKeyBytes = new Uint8Array(
          identity.privateKey.match(/.{2}/g)!.map((b) => parseInt(b, 16))
        );
        const convKey = getConversationKey(privKeyBytes, identity.publicKey);

        const foldersSync = new FoldersSync({
          chatAPI: {
            publishEvent: async(event) => { await chatAPI.publishEvent(event); },
            queryLatestEvent: (filter) => chatAPI.queryLatestEvent(filter) as any
          },
          filtersStore: {
            getFilters: async() => {
              const map = await rootScope.managers.filtersStorage.getFilters();
              return Object.values(map) as any[];
            },
            setFilters: (next) => rootScope.managers.filtersStorage.replaceAllFilters(next),
            reseedSystemFolders: () => rootScope.managers.filtersStorage.reseedSystemFolders()
          },
          encrypt: (plain) => nip44Encrypt(plain, convKey),
          decrypt: (cipher) => nip44Decrypt(cipher, convKey),
          nowSeconds: () => Math.floor(Date.now() / 1000),
          toast: (msg) => toast(msg),
          i18n: (key) => I18n.format(key as any, true)
        });

        // Bounded 5s reconcile — never block onboarding on relay latency
        await Promise.race([
          foldersSync.reconcile().catch((e) => console.warn('[FoldersSync] reconcile failed', e)),
          new Promise<void>((resolve) => setTimeout(resolve, 5000))
        ]);

        // Debounced publish on filter events
        let publishTimer: ReturnType<typeof setTimeout> | null = null;
        const schedulePublish = () => {
          setLastModifiedAt(Math.floor(Date.now() / 1000));
          if(publishTimer) clearTimeout(publishTimer);
          publishTimer = setTimeout(() => {
            foldersSync.publish().catch((e) => console.warn('[FoldersSync] publish failed', e));
          }, 2000);
        };

        rootScope.addEventListener('filter_update', schedulePublish);
        rootScope.addEventListener('filter_delete', schedulePublish);
        rootScope.addEventListener('filter_order', schedulePublish);
        console.log('[NostraOnboardingIntegration] FoldersSync wired');
      } catch(err) {
        console.warn('[NostraOnboardingIntegration] FoldersSync init failed:', err);
      }

      // Trigger initial dialog refresh
      setTimeout(() => {
        rootScope.dispatchEvent('dialogs_multiupdate', new Map());
      }, 1000);

      // --- Initialize presence ---
      try {
        const {initPresence} = await import('@lib/nostra/nostra-presence');
        await initPresence(identity.publicKey, identity.privateKey);
        console.log('[NostraOnboardingIntegration] presence initialized');
      } catch(err) {
        console.warn('[NostraOnboardingIntegration] presence init failed:', err);
      }

      // --- Publish kind 0 metadata (first boot only) ---
      // Historically this republished on every boot with only display_name,
      // which silently wiped picture/about/website/lud16/nip05 from the
      // relay. Now we only publish if the relay has no kind 0 yet OR the
      // cached profile is strictly newer than the relay (cross-device push).
      if(record.displayName) {
        setTimeout(async() => {
          try {
            const pool = (chatAPI as any).relayPool;
            if(!pool || !pool.isConnected()) {
              await new Promise((r) => setTimeout(r, 3000));
            }
            const {fetchOwnKind0} = await import('../lib/nostra/nostr-profile');
            const {loadCachedProfile} = await import('../lib/nostra/profile-cache');

            const relayResult = await fetchOwnKind0(identity.publicKey).catch((): null => null);
            const cached = loadCachedProfile();

            // If the relay already has a kind 0 and the cache is not newer,
            // there is nothing to publish — the relay is already current.
            if(relayResult && (!cached || cached.created_at <= relayResult.created_at)) {
              console.log('[NostraOnboardingIntegration] kind 0 already on relay, skipping republish');
              return;
            }

            const {finalizeEvent} = await import('nostr-tools/pure');
            const {loadEncryptedIdentity: loadEI, loadBrowserKey: loadBK, decryptKeys: dK} = await import('../lib/nostra/key-storage');
            const {importFromMnemonic: iFM} = await import('../lib/nostra/nostr-identity');
            const {hexToBytes} = await import('nostr-tools/utils');

            const encRecord = await loadEI();
            const bk = await loadBK();
            if(!encRecord || !bk) throw new Error('No encrypted identity');
            const {seed: s} = await dK(encRecord.iv, encRecord.encryptedKeys, bk);
            const id = iFM(s);
            const sk = hexToBytes(id.privateKey);

            // Merge cached profile fields so we don't clobber picture/about/
            // website/lud16/nip05 when republishing.
            const cachedProfile = cached?.profile ?? {};
            const content = JSON.stringify({
              display_name: cachedProfile.display_name || record.displayName,
              name: cachedProfile.name || cachedProfile.display_name || record.displayName,
              picture: cachedProfile.picture || undefined,
              about: cachedProfile.about || undefined,
              nip05: cachedProfile.nip05 || undefined,
              website: cachedProfile.website || undefined,
              lud16: cachedProfile.lud16 || undefined,
              banner: cachedProfile.banner || undefined
            });

            const event = finalizeEvent({
              kind: 0,
              created_at: Math.floor(Date.now() / 1000),
              tags: [],
              content
            }, sk);

            await pool.publishRawEvent(event);
            console.log('[NostraOnboardingIntegration] kind 0 metadata published:', record.displayName);
          } catch(err) {
            console.warn('[NostraOnboardingIntegration] kind 0 publish failed:', err);
          }
        }, 3000);
      }
    } catch(err) {
      console.error('[NostraOnboardingIntegration] error during identity post-processing:', err);
    }
  };

  onboarding.onIdentityCreated = handleIdentity;

  const handleIdentityFallback = () => handleIdentity();
  window.addEventListener('nostra-identity-created', handleIdentityFallback);

  await onboarding.init();

  return {
    onboarding,
    destroy: () => onboarding.destroy()
  };
}
