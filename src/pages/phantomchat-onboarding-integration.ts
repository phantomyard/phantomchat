/**
 * PhantomChat.chat Onboarding Integration for tweb
 *
 * Mounts PhantomChatOnboarding inside tweb's auth-pages container when
 * `?phantomchat=1` is set, replacing the phone/SMS auth flow.
 *
 * Flow:
 * 1. User lands on / (no identity) → sees PhantomChatOnboarding UI
 * 2. User generates identity → onIdentityCreated callback fires
 * 3. Callback: init PhantomChatBridge → store own mapping → enable flag → mount chat → init Virtual MTProto Server
 * 4. User reloads (identity exists) → init() → showExistingIdentity → callback fires → mount chat → init Virtual MTProto Server
 */

import App from '../config/app';
import {loadEncryptedIdentity, loadBrowserKey, decryptKeys} from '../lib/phantomchat/key-storage';
import {importFromStored} from '../lib/phantomchat/nostr-identity';
import {PhantomChatBridge} from '../lib/phantomchat/phantomchat-bridge';
import {PhantomChatOnboarding} from './phantomchat/onboarding';
import {ChatAPI} from '../lib/phantomchat/chat-api';
import {PhantomChatMTProtoServer} from '../lib/phantomchat/virtual-mtproto-server';
import {PhantomChatSync} from '../lib/phantomchat/phantomchat-sync';
import {MOUNT_CLASS_TO} from '@config/debug';
import rootScope from '../lib/rootScope';
import {handleIncomingMessage, handleIncomingEdit, resetUnreadForPeer} from '@lib/phantomchat/phantomchat-message-handler';
import {createPendingFlush} from '@lib/phantomchat/phantomchat-pending-flush';
import {createReadReceiptSender} from '@lib/phantomchat/phantomchat-read-receipts';
import {createDeliveryUI} from '@lib/phantomchat/phantomchat-delivery-ui';
import {FoldersSync} from '@lib/phantomchat/folders-sync';
import {setLastModifiedAt} from '@lib/phantomchat/folders-sync-state';
import {FOLDER_SYNC_TRIGGER_EVENTS} from '@lib/phantomchat/folders-sync-types';
import {getConversationKey, nip44Encrypt, nip44Decrypt} from '@lib/phantomchat/nostr-crypto';
import {CrdtSync} from '@lib/phantomchat/crdt-sync';
import {createContactsAdapter, CONTACTS_SYNC_D_TAG, CONTACTS_SYNC_VERSION} from '@lib/phantomchat/contacts-sync-adapter';
import {createGroupsAdapter, GROUPS_SYNC_D_TAG, GROUPS_SYNC_VERSION} from '@lib/phantomchat/groups-sync-adapter';
import {registerSyncPublisher} from '@lib/phantomchat/phantomchat-sync-triggers';
import {getAllMappings, setMappingDisplayName, setMappingUpdatedAt, removeMapping} from '@lib/phantomchat/virtual-peers-db';
import {getMessageStore} from '@lib/phantomchat/message-store';
import {getGroupStore} from '@lib/phantomchat/group-store';
import {groupIdToPeerId, type GroupRecord} from '@lib/phantomchat/group-types';
import {addP2PContact} from '@lib/phantomchat/add-p2p-contact';
import {writeGroupCreateServiceMessage} from '@lib/phantomchat/group-service-messages';
import {injectGroupCreateDialog, ensureGroupChatInjected, cleanupGroupChatInjection} from '@lib/phantomchat/phantomchat-groups-sync';
import {toast} from '@components/toast';
import I18n from '@lib/langPack';
// tweb-contained CSS no longer needed — onboarding uses native tweb styles

declare global {
  interface Window {
    __phantomchatChatAPI?: ChatAPI;
  }
}

export interface OnboardingMount {
  onboarding: PhantomChatOnboarding;
  destroy: () => void;
}

/**
 * Mount PhantomChatOnboarding into a container element.
 */
export async function mountPhantomChatOnboarding(container: HTMLElement): Promise<OnboardingMount> {
  const onboarding = new PhantomChatOnboarding();
  container.appendChild(onboarding.container);

  let identityHandled = false;

  const handleIdentity = async() => {
    if(identityHandled) return;
    identityHandled = true;
    window.removeEventListener('phantomchat-identity-created', handleIdentityFallback);
    console.log('[PhantomChatOnboardingIntegration] onIdentityCreated fired');

    try {
      // --- Load & decrypt identity ---
      const record = await loadEncryptedIdentity();
      if(!record) {
        console.error('[PhantomChatOnboardingIntegration] no identity in callback');
        return;
      }
      const browserKey = await loadBrowserKey();
      if(!browserKey) {
        console.error('[PhantomChatOnboardingIntegration] browser key missing');
        return;
      }
      const {seed, nsec} = await decryptKeys(record.iv, record.encryptedKeys, browserKey);
      const identity = importFromStored({seed, nsec});

      // Populate phantomchatIdentity store
      rootScope.dispatchEvent('phantomchat_identity_loaded', {
        npub: identity.npub,
        displayName: record.displayName || null,
        nip05: undefined,
        protectionType: 'none'
      });

      // --- Initialize bridge ---
      const bridge = PhantomChatBridge.getInstance();
      await bridge.init(identity.publicKey);

      // Publish NIP-65 relay list
      try {
        const privKeyBytes = new Uint8Array(identity.privateKey.match(/.{2}/g)!.map(b => parseInt(b, 16)));
        bridge.publishNip65(privKeyBytes);
      } catch(err) {
        console.warn('[PhantomChatOnboardingIntegration] NIP-65 publish failed:', err);
      }

      // Store own-pubkey → own-peerId mapping
      const ownPeerId = await bridge.mapPubkeyToPeerId(identity.publicKey);
      await bridge.storePeerMapping(identity.publicKey, ownPeerId, record.displayName || 'Me');
      console.log('[PhantomChatOnboardingIntegration] own mapping stored: peerId', ownPeerId);

      // Heal peer mappings missing from IndexedDB (e.g. peers we only ever
      // received from on a previous session, or after an identity reload).
      // Without this the send path drops silently at the `!peerPubkey` guard
      // ("VMT returned no phantomchatMid") until a fresh inbound message
      // happens to re-persist the mapping. Best-effort — never blocks load.
      try {
        await bridge.backfillPeerMappingsFromHistory(identity.publicKey);
      } catch(err) {
        console.warn('[PhantomChatOnboardingIntegration] peer-mapping backfill failed (non-fatal):', err);
      }

      // --- Initialize Virtual MTProto Server ---
      const server = new PhantomChatMTProtoServer();
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
        console.warn('[PhantomChatOnboardingIntegration] seedPts read failed (non-fatal):', err);
      }
      const proxy = MOUNT_CLASS_TO.apiManagerProxy;
      if(proxy) {
        proxy.setPhantomChatMTProtoServer(server);
      }
      (window as any).__phantomchatMTProtoServer = server;
      (window as any).__phantomchatOwnPubkey = identity.publicKey;
      console.log('[PhantomChatOnboardingIntegration] Virtual MTProto Server registered');

      // --- Import chat page (loads the module graph incl. phantomchatIdentity store) ---
      const pageIm = await import('./pageIm');

      // Re-dispatch identity_loaded so stores registered inside pageIm module graph
      // (e.g. phantomchatIdentity.ts) pick up the npub after their module is loaded.
      rootScope.dispatchEventSingle('phantomchat_identity_loaded', {
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
          await import('@lib/phantomchat/own-profile-sync');
        hydrateOwnProfileFromCache();
        refreshOwnProfileFromRelaysFn = refreshOwnProfileFromRelays;
      } catch(err) {
        console.warn('[PhantomChatOnboardingIntegration] own profile sync init failed:', err);
      }

      // --- Mount chat page ---
      pageIm.default.mount();

      // Kick off background relay fetch to pick up edits made from other devices.
      refreshOwnProfileFromRelaysFn?.(identity.publicKey).catch((err) => {
        console.warn('[PhantomChatOnboardingIntegration] own profile relay refresh failed:', err);
      });

      // --- Initialize ChatAPI ---
      const chatAPI = new ChatAPI(identity.publicKey, identity.privateKey);
      window.__phantomchatChatAPI = chatAPI;
      server.setChatAPI(chatAPI);
      console.log('[PhantomChatOnboardingIntegration] ChatAPI initialized');

      // --- Initialize GroupAPI ---
      //
      // GroupAPI internally calls handleGroupIncoming/handleGroupOutgoing
      // (phantomchat-groups-sync) for the render pipeline. We pass a dispatch
      // function that forwards phantomchat_new_message onto rootScope so
      // downstream listeners (mesh signaling, etc) see group messages the
      // same way they see DMs. Closes FIND-dbe8fdd2.
      try {
        const {initGroupAPI} = await import('@lib/phantomchat/group-api');
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
        console.log('[PhantomChatOnboardingIntegration] GroupAPI initialized with render pipeline');
      } catch(err) {
        console.warn('[PhantomChatOnboardingIntegration] GroupAPI init failed:', err);
      }

      // --- Initialize PhantomChatSync ---
      const sync = new PhantomChatSync(identity.publicKey, (event: string, data: any) => {
        rootScope.dispatchEvent(event as any, data);
      });
      chatAPI.onMessage = (msg: any) => {
        sync.onIncomingMessage(msg, msg.from);
      };
      chatAPI.onEditMessage = (edit: any) => {
        sync.onIncomingEdit(edit);
      };
      console.log('[PhantomChatOnboardingIntegration] PhantomChatSync wired to ChatAPI');

      // ChatAPI owns its own NostrRelayPool. Start its global subscription
      // immediately over direct WebSocket — there is no Tor layer to wait for.
      const startChatAPI = () => {
        chatAPI.initGlobalSubscription().catch((err) => {
          console.warn('[PhantomChatOnboardingIntegration] global subscription failed:', err);
        });
      };

      startChatAPI();

      // --- Wire extracted modules ---
      const pendingFlush = createPendingFlush();
      const readReceipts = createReadReceiptSender();
      const deliveryUI = createDeliveryUI();

      // Incoming message handler
      rootScope.addEventListener('phantomchat_new_message', async(data) => {
        try {
          const result = await handleIncomingMessage(data, identity.publicKey);
          if(result) {
            pendingFlush.enqueue(result.peerId, result.msg);
          }
        } catch(err) {
          console.warn('[PhantomChatOnboardingIntegration] phantomchat_new_message handler error:', err);
        }
      });

      // Incoming edit handler — updates existing bubble in place
      rootScope.addEventListener('phantomchat_message_edit', async(data) => {
        try {
          await handleIncomingEdit(data, identity.publicKey);
        } catch(err) {
          console.warn('[PhantomChatOnboardingIntegration] phantomchat_message_edit handler error:', err);
        }
      });

      // Conversation-deleted handler — drop the dialog from the chat list.
      // Fired by ChatAPI.deleteConversation and the VMT contacts.deleteContacts
      // handler after the underlying messages are wiped + tombstoned. We route
      // through the same flushHistory path the native "delete chat" UI uses so
      // the dialog, unread badge and message storages are cleared coherently.
      // flushHistory re-invokes messages.deleteHistory (idempotent: re-wipe +
      // re-tombstone, no further dispatch) so there is no event loop.
      rootScope.addEventListener('phantomchat_conversation_deleted', async({peerPubkey}) => {
        try {
          const peerId = await PhantomChatBridge.getInstance().mapPubkeyToPeerId(peerPubkey);
          await rootScope.managers.appMessagesManager.flushHistory({peerId, justClear: false, revoke: false});
        } catch(err) {
          console.warn('[PhantomChatOnboardingIntegration] phantomchat_conversation_deleted handler error:', err);
        }
      });

      // Pending flush with read receipts on peer open
      pendingFlush.attachListener((peerId) => {
        readReceipts.sendForPeer(peerId).catch((err) => {
          console.warn('[PhantomChatOnboardingIntegration] markRead batch failed:', err);
        });
      });
      pendingFlush.startPeriodicFlush();

      // --- Background push notifications ---
      // Auto-subscribe when notification permission is already granted at boot.
      // VAPID public key is fetched (and localStorage-cached) via resolveVapidKey.
      (async() => {
        try {
          // Push is gated off until a relay is deployed (App.pushEnabled). Without
          // this guard, resolveVapidKey() hits the non-existent push relay on every
          // boot and spams "/info fetch failed". Keep the code; flip the flag later.
          if(!App.pushEnabled) return;
          if(typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
          const {subscribePush, getRegistration} = await import('@lib/phantomchat/phantomchat-push-client');
          const {resolveVapidKey} = await import('@lib/phantomchat/phantomchat-push-helpers');
          const pubkeyHex = identity.publicKey;
          const existing = await getRegistration();
          if(existing && existing.pubkey === pubkeyHex) return;

          // Direct WebSocket transport — no Tor fetch wrapper.
          const fetchFn: typeof fetch | undefined = undefined;

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
            rootScope.dispatchEvent('phantomchat_push_subscription_changed' as any, {
              state: 'registered',
              pubkey: rec.pubkey
            });
          }
        } catch(err) {
          console.warn('[PhantomChatOnboardingIntegration] push subscribe failed:', err);
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
              console.warn('[PhantomChatOnboardingIntegration] resetUnread error:', err);
            });
          }
        });
      };
      attachUnreadReset();

      // Delivery status UI
      deliveryUI.attach();

      // --- Folders sync (kind 30078) — cross-device folder reconcile + publish ---
      // The folder-persistence wipe was NOT this sync. The real root cause was the
      // boot-time single→multi-account migration: checkIfHasMultiAccount() gated it
      // on a Telegram MTProto DC auth key, which this P2P fork never has, so the
      // migration ran every boot and reloaded account 1 from the old/empty `tweb`
      // DB — clobbering tweb-account-1 and wiping custom folders (see loadState.ts
      // fix). With that fixed (and verified live: create folder → restart → folder
      // persists), cross-device folder sync is re-enabled: a bounded remote-wins
      // reconcile on boot and a debounced publish on filter changes. The reconcile
      // only wins when the remote snapshot is genuinely newer than local
      // (decideMerge), so it does not clobber freshly-created local folders.
      const FOLDERS_SYNC_ENABLED = true;
      if(FOLDERS_SYNC_ENABLED) {
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

          for(const event of FOLDER_SYNC_TRIGGER_EVENTS) {
            rootScope.addEventListener(event, schedulePublish);
          }
          console.log('[PhantomChatOnboardingIntegration] FoldersSync wired');
        } catch(err) {
          console.warn('[PhantomChatOnboardingIntegration] FoldersSync init failed:', err);
        }
      }

      // --- Contacts + Groups sync (kind 30078) — cross-device address book +
      // group roster reconcile. Unlike folders (whole-blob last-write-wins),
      // these use the union-merge-with-tombstones CRDT so two devices adding
      // different contacts/groups offline never lose either. Pairing a new
      // device (seed-phrase QR) restores keys but NOT contacts/groups; this is
      // what makes those come across too. ---
      const CONTACTS_GROUPS_SYNC_ENABLED = true;
      if(CONTACTS_GROUPS_SYNC_ENABLED) {
        try {
          const privKeyBytes = new Uint8Array(
            identity.privateKey.match(/.{2}/g)!.map((b) => parseInt(b, 16))
          );
          const convKey = getConversationKey(privKeyBytes, identity.publicKey);
          const store = getMessageStore();
          const ownPubkey = identity.publicKey;

          const crdtChatAPI = {
            publishEvent: async(event: any) => { await chatAPI.publishEvent(event); },
            queryLatestEvent: (filter: any) => chatAPI.queryLatestEvent(filter) as any
          };
          const crdtCrypto = {
            encrypt: (plain: string) => nip44Encrypt(plain, convKey),
            decrypt: (cipher: string) => nip44Decrypt(cipher, convKey),
            nowSeconds: () => Math.floor(Date.now() / 1000)
          };

          const contactsAdapter = createContactsAdapter({
            getOwnPubkey: () => (window as any).__phantomchatOwnPubkey || ownPubkey,
            listMappings: () => getAllMappings(),
            listTombstones: () => store.getAllTombstones(),
            conversationId: (a, b) => store.getConversationId(a, b),
            addContact: async(pubkey, displayName) => {
              await addP2PContact({pubkey, nickname: displayName, openChat: false, source: 'contacts-sync'});
            },
            setDisplayName: (pubkey, displayName) => setMappingDisplayName(pubkey, displayName),
            setUpdatedAt: (pubkey, ms) => setMappingUpdatedAt(pubkey, ms),
            removeContact: (pubkey) => removeMapping(pubkey),
            setTombstone: (convId, sec) => store.setTombstone(convId, sec)
          });

          const groupsAdapter = createGroupsAdapter({
            listGroups: () => getGroupStore().getAll(),
            listTombstones: () => store.getAllTombstones(),
            upsertGroup: async(record: GroupRecord) => {
              const peerId = await groupIdToPeerId(record.groupId);
              const rec: GroupRecord = {...record, peerId};
              const existing = await getGroupStore().get(record.groupId);
              await getGroupStore().save(rec);
              const createdAtSec = Math.floor((rec.createdAt || Date.now()) / 1000);
              if(!existing) {
                // Fresh restore: clear any stale deletion watermark so the
                // create service row isn't suppressed, then seed + inject.
                try { await store.clearTombstone(`group:${rec.groupId}`); } catch{ /* none */ }
                const service = await writeGroupCreateServiceMessage({
                  groupId: rec.groupId,
                  peerId,
                  timestamp: createdAtSec,
                  adminPubkey: rec.adminPubkey,
                  title: rec.name,
                  isOutgoing: rec.adminPubkey === ownPubkey
                });
                await injectGroupCreateDialog(rec.groupId, service.mid, createdAtSec);
              } else {
                // Update (rename / membership): refresh the mirror + title.
                await ensureGroupChatInjected(rec.groupId, peerId);
              }
            },
            removeGroup: async(groupId) => {
              const peerId = await groupIdToPeerId(groupId);
              await getGroupStore().delete(groupId);
              try { await cleanupGroupChatInjection(peerId); } catch{ /* mirror already gone */ }
            },
            setTombstone: (convId, sec) => store.setTombstone(convId, sec)
          });

          const contactsSync = new CrdtSync({
            dTag: CONTACTS_SYNC_D_TAG, version: CONTACTS_SYNC_VERSION,
            chatAPI: crdtChatAPI, adapter: contactsAdapter, ...crdtCrypto
          });
          const groupsSync = new CrdtSync({
            dTag: GROUPS_SYNC_D_TAG, version: GROUPS_SYNC_VERSION,
            chatAPI: crdtChatAPI, adapter: groupsAdapter, ...crdtCrypto
          });

          // Bounded boot reconcile — never block onboarding on relay latency.
          await Promise.race([
            Promise.all([
              contactsSync.reconcile().catch((e) => console.warn('[contacts-sync] reconcile failed', e)),
              groupsSync.reconcile().catch((e) => console.warn('[groups-sync] reconcile failed', e))
            ]),
            new Promise<void>((resolve) => setTimeout(resolve, 8000))
          ]);

          // Debounced publishers, triggered from mutation sites via the
          // trigger registry (addP2PContact, deleteContacts, GroupAPI).
          const mkDebounced = (fn: () => Promise<void>, tag: string) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            return () => {
              if(timer) clearTimeout(timer);
              timer = setTimeout(() => { fn().catch((e) => console.warn(tag, 'publish failed', e)); }, 2000);
            };
          };
          registerSyncPublisher('contacts', mkDebounced(() => contactsSync.publish(), '[contacts-sync]'));
          registerSyncPublisher('groups', mkDebounced(() => groupsSync.publish(), '[groups-sync]'));
          console.log('[PhantomChatOnboardingIntegration] Contacts+Groups sync wired');
        } catch(err) {
          console.warn('[PhantomChatOnboardingIntegration] Contacts+Groups sync init failed:', err);
        }
      }

      // Trigger initial dialog refresh
      setTimeout(() => {
        rootScope.dispatchEvent('dialogs_multiupdate', new Map());
      }, 1000);

      // --- Initialize presence (#52): honest online / last-seen via the
      // gift-wrapped ping/pong handshake. ---
      try {
        const {initPresence} = await import('@lib/phantomchat/phantomchat-presence');
        await initPresence(identity.publicKey, identity.privateKey);
        console.log('[PhantomChatOnboardingIntegration] presence initialized');
      } catch(err) {
        console.warn('[PhantomChatOnboardingIntegration] presence init failed:', err);
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
            const {fetchOwnKind0} = await import('../lib/phantomchat/nostr-profile');
            const {loadCachedProfile} = await import('../lib/phantomchat/profile-cache');

            const relayResult = await fetchOwnKind0(identity.publicKey).catch((): null => null);
            const cached = loadCachedProfile();

            // If the relay already has a kind 0 and the cache is not newer,
            // there is nothing to publish — the relay is already current.
            if(relayResult && (!cached || cached.created_at <= relayResult.created_at)) {
              console.log('[PhantomChatOnboardingIntegration] kind 0 already on relay, skipping republish');
              return;
            }

            const {finalizeEvent} = await import('nostr-tools/pure');
            const {loadEncryptedIdentity: loadEI, loadBrowserKey: loadBK, decryptKeys: dK} = await import('../lib/phantomchat/key-storage');
            const {importFromStored: iFS} = await import('../lib/phantomchat/nostr-identity');
            const {hexToBytes} = await import('nostr-tools/utils');

            const encRecord = await loadEI();
            const bk = await loadBK();
            if(!encRecord || !bk) throw new Error('No encrypted identity');
            const {seed: s, nsec: ns} = await dK(encRecord.iv, encRecord.encryptedKeys, bk);
            const id = iFS({seed: s, nsec: ns});
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
            console.log('[PhantomChatOnboardingIntegration] kind 0 metadata published:', record.displayName);
          } catch(err) {
            console.warn('[PhantomChatOnboardingIntegration] kind 0 publish failed:', err);
          }
        }, 3000);
      }
    } catch(err) {
      console.error('[PhantomChatOnboardingIntegration] error during identity post-processing:', err);
    }
  };

  onboarding.onIdentityCreated = handleIdentity;

  const handleIdentityFallback = () => handleIdentity();
  window.addEventListener('phantomchat-identity-created', handleIdentityFallback);

  await onboarding.init();

  return {
    onboarding,
    destroy: () => onboarding.destroy()
  };
}
