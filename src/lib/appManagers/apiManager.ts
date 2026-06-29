/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 *
 * Originally from:
 * https://github.com/zhukov/webogram
 * Copyright (C) 2014 Igor Zhukov <igor.beatle@gmail.com>
 * https://github.com/zhukov/webogram/blob/master/LICENSE
 */

import type {UserAuth} from '@appManagers/constants';
import type {DcAuthKey, DcId, DcServerSalt, InvokeApiOptions, TrueDcId} from '@types';
import type {MethodDeclMap} from '@layer';
import type TcpObfuscated from '@lib/mtproto/transports/tcpObfuscated';
import sessionStorage from '@lib/sessionStorage';
import MTPNetworker, {MTMessage} from '@lib/mtproto/networker';
import {ConnectionType, constructTelegramWebSocketUrl, DcConfigurator, TransportType} from '@lib/mtproto/dcConfigurator';
import deferredPromise, {CancellablePromise} from '@helpers/cancellablePromise';
import App from '@config/app';
import {MOUNT_CLASS_TO} from '@config/debug';
import {IDB} from '@lib/files/idb';
import CryptoWorker from '@lib/crypto/cryptoMessagePort';
import ctx from '@environment/ctx';
import noop from '@helpers/noop';
import Modes from '@config/modes';
import bytesFromHex from '@helpers/bytes/bytesFromHex';
import bytesToHex from '@helpers/bytes/bytesToHex';
import isObject from '@helpers/object/isObject';
import pause from '@helpers/schedulers/pause';
import {PhantomChatMTProtoServer} from '@lib/phantomchat/virtual-mtproto-server';
import {assertInvariant, validateActionPrefixes, validateBridgeMethods} from '@lib/phantomchat/bridge-invariants';
import MTProtoMessagePort from '@lib/mainWorker/mainMessagePort';
import ApiManagerMethods from '@appManagers/apiManagerMethods';
import {getEnvironment} from '@environment/utils';
import tsNow from '@helpers/tsNow';
import transportController from '@lib/mtproto/transports/controller';
import MTTransport from '@lib/mtproto/transports/transport';
import AccountController from '@lib/accounts/accountController';
import {AppStoragesManager} from '@appManagers/appStoragesManager';
import commonStateStorage from '@lib/commonStateStorage';
import CacheStorageController from '@lib/files/cacheStorage';
import {ActiveAccountNumber} from '@lib/accounts/types';
import makeError from '@helpers/makeError';
import EncryptedStorageLayer from '@lib/encryptedStorageLayer';
import {getCommonDatabaseState} from '@config/databases/state';
import EncryptionKeyStore from '@lib/passcode/keyStore';
import DeferredIsUsingPasscode from '@lib/passcode/deferredIsUsingPasscode';
import {MTAuthKey} from '@lib/mtproto/authKey';
/**
 * To not be used in an ApiManager instance as there is no account number attached to it
 */
import globalRootScope from '@lib/rootScope';
import RepayRequestHandler from '@appManagers/utils/repayRequestHandler';

const PREMIUM_FILE_NETWORKERS_COUNT = 6;
const REGULAR_FILE_NETWORKERS_COUNT = 3;
const DESTROY_NETWORKERS = true;

export class ApiManager extends ApiManagerMethods {
  private static fillTimeManagerOffsetPromise: Promise<void>;

  private cachedNetworkers: {
    [transportType in TransportType]: {
      [connectionType in ConnectionType]: {
        [dcId: DcId]: MTPNetworker[]
      }
    }
  };

  private cachedExportPromise: {[x: number]: Promise<unknown>};
  private gettingNetworkers: {[dcIdAndType: string]: Promise<MTPNetworker>};
  private baseDcId: DcId;
  private phantomchatMTProtoServer: PhantomChatMTProtoServer | null = null;

  private afterMessageTempIds: {
    [tempId: string]: {
      messageId: string,
      promise: Promise<any>
    }
  };

  private transportType: TransportType;

  private loggingOut: boolean;

  constructor() {
    super();
    this.name = 'API';

    this.cachedNetworkers = {} as any;
    this.cachedExportPromise = {};
    this.gettingNetworkers = {};
    this.baseDcId = 0;
    this.afterMessageTempIds = {};

    this.transportType = Modes.transport;

    console.log('[PhantomChat.chat] ApiManager constructor — MTProto intercept active');

    // * Make sure that the used autologin_token is no more than 10000 seconds old
    // * https://core.telegram.org/api/url-authorization
    const REFRESH_CONFIG_INTERVAL = (10000 - 30) * 1000;
    setInterval(() => {
      this.getConfig(true);
    }, REFRESH_CONFIG_INTERVAL);
  }

  protected after() {
    const result = super.after();

    if(import.meta.env.VITE_MTPROTO_AUTO && Modes.multipleTransports) {
      transportController.addEventListener('transport', (transportType) => {
        this.changeTransportType(transportType);
      });
    }

    this.apiUpdatesManager.addMultipleEventsListeners({
      updateConfig: () => {
        this.getConfig(true);
        this.getAppConfig(true);
      }
    });

    this.rootScope.addEventListener('user_auth', () => {
      if(this.config) { // refresh configs if had a config during authorization
        this.apiUpdatesManager.processLocalUpdate({_: 'updateConfig'});
      }
    });

    this.rootScope.addEventListener('premium_toggle', (isPremium) => {
      this.iterateNetworkers(({networker, connectionType, dcId, transportType}) => {
        if(connectionType === 'client' || transportType !== 'websocket') {
          return;
        }

        const transport = networker.transport;
        if(!transport) {
          this.log.error('wow what, no transport?', networker);
          return;
        }

        if((transport as TcpObfuscated).connection) {
          const url = constructTelegramWebSocketUrl(dcId, connectionType, isPremium);
          (transport as TcpObfuscated).changeUrl(url);
        }
      });
    });

    return result;
  }

  private getTransportType(connectionType: ConnectionType) {
    let transportType: TransportType;
    if(import.meta.env.VITE_MTPROTO_HTTP_UPLOAD) {
      transportType = connectionType === 'upload' && getEnvironment().IS_SAFARI ? 'https' : 'websocket';
      // const transportType: TransportType = connectionType !== 'client' ? 'https' : 'websocket';
    } else {
      transportType = this.transportType;
    }

    return transportType;
  }

  private iterateNetworkers(callback: (o: {networker: MTPNetworker, dcId: DcId, connectionType: ConnectionType, transportType: TransportType, index: number, array: MTPNetworker[]}) => void) {
    for(const transportType in this.cachedNetworkers) {
      const connections = this.cachedNetworkers[transportType as TransportType];
      for(const connectionType in connections) {
        const dcs = connections[connectionType as ConnectionType];
        for(const dcId in dcs) {
          const networkers = dcs[dcId as any as DcId];
          networkers.forEach((networker, idx, arr) => {
            callback({
              networker,
              dcId: +dcId as DcId,
              connectionType: connectionType as ConnectionType,
              transportType: transportType as TransportType,
              index: idx,
              array: arr
            });
          });
        }
      }
    }
  }

  private chooseServer(dcId: DcId, connectionType: ConnectionType, transportType: TransportType) {
    return this.dcConfigurator.chooseServer(dcId, connectionType, transportType, connectionType === 'client', this.rootScope.premium);
  }

  public changeTransportType(transportType: TransportType) {
    const oldTransportType = this.transportType;
    if(oldTransportType === transportType) {
      return;
    }

    this.log('changing transport from', oldTransportType, 'to', transportType);

    const oldObject = this.cachedNetworkers[oldTransportType];
    const newObject = this.cachedNetworkers[transportType];
    this.cachedNetworkers[transportType] = oldObject;
    this.cachedNetworkers[oldTransportType] = newObject;

    this.transportType = transportType;

    for(const oldGetKey in this.gettingNetworkers) {
      const promise = this.gettingNetworkers[oldGetKey];
      delete this.gettingNetworkers[oldGetKey];

      const newGetKey = oldGetKey.replace(oldTransportType, transportType);
      this.gettingNetworkers[newGetKey] = promise;

      this.log('changed networker getKey from', oldGetKey, 'to', newGetKey)
    }

    this.iterateNetworkers((info) => {
      const transportType = this.getTransportType(info.connectionType);
      const transport = this.chooseServer(info.dcId, info.connectionType, transportType);
      this.changeNetworkerTransport(info.networker, transport);
    });
  }

  public async getBaseDcId() {
    if(this.baseDcId) {
      return this.baseDcId as TrueDcId;
    }

    const accountData = await AccountController.get(this.getAccountNumber());
    const baseDcId = accountData.dcId;
    if(!this.baseDcId) {
      if(!baseDcId) {
        this.setBaseDcId(App.baseDcId);
      } else {
        this.baseDcId = baseDcId;
      }
    }

    return this.baseDcId as TrueDcId;
  }

  public async setUserAuth(userAuth: UserAuth | UserId) {
    if(typeof(userAuth) === 'string' || typeof(userAuth) === 'number') {
      userAuth = {dcID: 0, date: tsNow(true), id: userAuth.toPeerId(false)};
    }

    this.rootScope.dispatchEvent('user_auth', userAuth);

    if(!userAuth.dcID) {
      const baseDcId = await this.getBaseDcId();
      userAuth.dcID = baseDcId;
    }

    AccountController.update(this.getAccountNumber(), {
      date: (userAuth as UserAuth).date,
      userId: (userAuth as UserAuth).id,
      dcId: (userAuth as UserAuth).dcID as TrueDcId
    });
  }

  public setBaseDcId(dcId: DcId) {
    const wasDcId = this.baseDcId;
    if(wasDcId && wasDcId === dcId) {
      return;
    }

    if(wasDcId) { // if migrated set ondrain
      this.getNetworker(wasDcId).then((networker) => {
        this.setOnDrainIfNeeded(networker);
      });
    }

    this.baseDcId = dcId;

    AccountController.update(this.getAccountNumber(), {
      dcId: this.baseDcId as TrueDcId
    });
  }

  public async logOut(
    migrateAccountTo?: ActiveAccountNumber,
    opts?: {keepPhantomChatIdentity?: boolean}
  ) {
    if(this.loggingOut) {
      return;
    }

    this.loggingOut = true;

    const totalAccounts = await AccountController.getTotalAccounts();
    const accountNumber = this.getAccountNumber();
    const accountData = await AccountController.get(accountNumber);

    const logoutPromises: Promise<any>[] = [];

    for(let dcId = 1; dcId <= 5; dcId++) {
      const key = `dc${dcId as TrueDcId}_auth_key` as const;
      if(accountData[key]) {
        logoutPromises.push(this.invokeApi('auth.logOut', {}, {dcId, ignoreErrors: true}));
      }
    }

    let wasCleared = false; // Prevent double logout 2 accounts in a row
    const clear = async() => {
      if(wasCleared) return;
      wasCleared = true;

      this.baseDcId = undefined;
      // * totalAccounts can be 0 somehow
      if(totalAccounts <= 1 && accountNumber === 1 && !migrateAccountTo) {
        await Promise.all([
          (async() => {
            const keys: Parameters<typeof sessionStorage['delete']>[0][] = [
              'account1',
              'dc',
              'server_time_offset',
              'xt_instance',
              'user_auth',
              // 'state_id',
              'k_build',
              'auth_key_fingerprint'
            ];
            for(let i = 1; i <= 5; ++i) {
              keys.push(`dc${i as TrueDcId}_server_salt`);
              keys.push(`dc${i as TrueDcId}_auth_key`);
              keys.push(`dc${i as TrueDcId}_hash`); // only for WebA
            }

            return Promise.all(keys.map((key) => sessionStorage.delete(key)));
          })(),
          AppStoragesManager.clearAllStoresForAccount(1),
          AppStoragesManager.clearSessionStores(),
          commonStateStorage.clear(),
          EncryptedStorageLayer.getInstance(getCommonDatabaseState(), 'localStorage__encrypted').clear(),
          CacheStorageController.deleteAllStorages()
        ]);
      } else {
        await AccountController.shiftAccounts(accountNumber);
        await AppStoragesManager.shiftStorages(accountNumber);

        if(await DeferredIsUsingPasscode.isUsingPasscode()) {
          // Keep the screen unlocked even if the user logs out
          await sessionStorage.set({
            encryption_key: await EncryptionKeyStore.getAsBase64()
          });
        }
      }
      // [PhantomChat.chat] Clear Nostr identity key in Worker context (skipped by Reset Local Data)
      if(!opts?.keepPhantomChatIdentity) {
        try {
          const {deleteEncryptedIdentity} = await import('../phantomchat/key-storage');
          await deleteEncryptedIdentity();
        } catch(err) {
          console.warn('[PhantomChat.chat] failed to clear identity on logout:', err);
        }
      }

      IDB.closeDatabases();
      this.rootScope.dispatchEvent('logging_out', {accountNumber, migrateTo: migrateAccountTo});
    };

    setTimeout(clear, 1e3);

    // return;

    return Promise.all(logoutPromises).catch((error) => {
      error.handled = true;
    }).finally(clear)/* .then(() => {
      location.pathname = '/';
    }) */;
  }

  public static async forceLogOutAll() {
    const clearAllStoresPromises = ([1, 2, 3, 4] as ActiveAccountNumber[])
    .map(accountNumber => AppStoragesManager.clearAllStoresForAccount(accountNumber));

    await Promise.all([
      sessionStorage.localStorageProxy('clear'),
      commonStateStorage.clear(),
      EncryptedStorageLayer.getInstance(getCommonDatabaseState(), 'localStorage__encrypted').clear(),
      ...clearAllStoresPromises,
      CacheStorageController.deleteAllStorages()
    ]);

    IDB.closeDatabases();
    globalRootScope.dispatchEvent('logging_out', {});
  }

  private generateNetworkerGetKey(dcId: DcId, transportType: TransportType, connectionType: ConnectionType) {
    return [dcId, transportType, connectionType].join('-');
  }

  public async getAuthKeyFromHex(authKeyHex: string) {
    const authKey = bytesFromHex(authKeyHex);
    return new MTAuthKey(authKey, (await CryptoWorker.invokeCrypto('sha1', authKey)).slice(-8));
  }

  public getNetworker(dcId: DcId, options: InvokeApiOptions = {}): Promise<MTPNetworker> {
    const connectionType: ConnectionType = options.fileDownload ? 'download' : (options.fileUpload ? 'upload' : 'client');
    // const connectionType: ConnectionType = 'client';

    const transportType = this.getTransportType(connectionType);
    if(!this.cachedNetworkers[transportType]) {
      this.cachedNetworkers[transportType] = {
        client: {},
        download: {},
        upload: {}
      };
    }

    const cache = this.cachedNetworkers[transportType][connectionType];
    if(!(dcId in cache)) {
      cache[dcId] = [];
    }

    const networkers = cache[dcId];
    const maxNetworkers = connectionType === 'client' || transportType === 'https' ?
      1 :
      (this.rootScope.premium ? PREMIUM_FILE_NETWORKERS_COUNT : REGULAR_FILE_NETWORKERS_COUNT);
    if(networkers.length) {
      let networker = networkers[0];
      if(maxNetworkers > 1) {
        let onlineRequests = Infinity, onlineNetworker: MTPNetworker;
        let minRequests = Infinity, minNetworker: MTPNetworker;
        for(const networker of networkers) {
          const {activeRequests, isOnline} = networker;
          if(activeRequests < onlineRequests && isOnline) {
            onlineRequests = activeRequests;
            onlineNetworker = networker;
          }

          if(activeRequests < minRequests) {
            minRequests = activeRequests;
            minNetworker = networker;
          }
        }

        if(networkers.length < maxNetworkers && onlineRequests) { // * if all instances are busy and can create a new one
          networker = undefined;
        } else if(onlineNetworker) {
          networker = onlineNetworker;
        } else { // * if all instances are offline
          networker = minNetworker;
        }
      }

      if(networker) {
        return Promise.resolve(networker);
      }
    }

    let getKey = this.generateNetworkerGetKey(dcId, transportType, connectionType);
    if(this.gettingNetworkers[getKey]) {
      return this.gettingNetworkers[getKey];
    }

    const ak: DcAuthKey = `dc${dcId}_auth_key` as any;
    const ss: DcServerSalt = `dc${dcId}_server_salt` as any;

    if(!ApiManager.fillTimeManagerOffsetPromise) {
      ApiManager.fillTimeManagerOffsetPromise = sessionStorage.get('server_time_offset').then((timeOffset) => {
        if(timeOffset) {
          this.timeManager.timeOffset = timeOffset;
        }
      }, () => {});

      this.timeManager.onTimeOffsetChange = (timeOffset) => {
        sessionStorage.set({
          server_time_offset: timeOffset
        });
      };
    }

    let transport = this.chooseServer(dcId, connectionType, transportType);
    return this.gettingNetworkers[getKey] = AccountController
    .get(this.getAccountNumber())
    .then((accountData) => [accountData[ak], accountData[ss]] as const)
    .then(async([authKeyHex, serverSaltHex]) => {
      await ApiManager.fillTimeManagerOffsetPromise;

      let networker: MTPNetworker, error: any, onTransport: () => Promise<any>;
      let permanent: {authKey?: MTAuthKey, serverSalt?: Uint8Array}, temporary: typeof permanent;
      if(authKeyHex?.length === 512) {
        if(serverSaltHex?.length !== 16) {
          serverSaltHex = 'AAAAAAAAAAAAAAAA';
        }

        permanent = {
          authKey: await this.getAuthKeyFromHex(authKeyHex),
          serverSalt: bytesFromHex(serverSaltHex)
        };

        temporary = await this.authorizer.auth(dcId, true);
      } else {
        try { // if no saved state
          [permanent, temporary] = await Promise.all([this.authorizer.auth(dcId, false), this.authorizer.auth(dcId, true)]);

          authKeyHex = bytesToHex(permanent.authKey.key);
          serverSaltHex = bytesToHex(permanent.serverSalt);

          AccountController.update(this.getAccountNumber(), {
            [ak]: authKeyHex,
            [ss]: serverSaltHex
          });
        } catch(_error) {
          error = _error;
        }
      }

      if(!error) {
        const auth = temporary ?? permanent;
        networker = this.networkerFactory.getNetworker({
          dcId,
          permAuthKey: permanent.authKey,
          authKey: auth.authKey,
          serverSalt: auth.serverSalt,
          isFileDownload: connectionType === 'download',
          isFileUpload: connectionType === 'upload'
        });

        if(temporary) onTransport = async() => {
          await networker.wrapBindAuthKeyCall(temporary.authKey.expiresAt);
          // await networker.wrapApiCall('help.getConfig', {});
          // await pause(1000000);
        };
      }

      // ! cannot get it before this promise because simultaneous changeTransport will change nothing
      const newTransportType = this.getTransportType(connectionType);
      if(newTransportType !== transportType) {
        getKey = this.generateNetworkerGetKey(dcId, newTransportType, connectionType);
        transport.destroy();
        DcConfigurator.removeTransport(this.dcConfigurator.chosenServers, transport);

        if(networker) {
          transport = this.chooseServer(dcId, connectionType, newTransportType);
        }

        this.log('transport has been changed during authorization from', transportType, 'to', newTransportType);
      }

      /* networker.onConnectionStatusChange = (online) => {
        console.log('status:', online);
      }; */

      delete this.gettingNetworkers[getKey];

      if(error) {
        this.log('get networker error', error, (error as Error).stack);
        throw error;
      }

      this.changeNetworkerTransport(networker, transport);
      // onTransport && await onTransport?.();
      networkers.unshift(networker);
      this.setOnDrainIfNeeded(networker);
      return networker;
    });
  }

  public getNetworkerVoid(dcId: DcId) {
    return this.getNetworker(dcId).then(noop, noop);
  }

  private changeNetworkerTransport(networker: MTPNetworker, transport?: MTTransport) {
    const oldTransport = networker.transport;
    if(oldTransport) {
      DcConfigurator.removeTransport(this.dcConfigurator.chosenServers, oldTransport);
    }

    networker.changeTransport(transport);
  }

  private onNetworkerDrain(networker: MTPNetworker) {
    this.log('networker drain', networker.dcId);
    networker.onDrain = undefined;
    this.changeNetworkerTransport(networker);
    networker.destroy();
    this.networkerFactory.removeNetworker(networker);
    DcConfigurator.removeTransport(this.cachedNetworkers, networker);
  }

  public setOnDrainIfNeeded(networker: MTPNetworker) {
    if(!DESTROY_NETWORKERS || networker.onDrain) {
      return;
    }

    const checkPromise: Promise<boolean> = networker.isFileNetworker ?
      Promise.resolve(true) :
      this.getBaseDcId().then((baseDcId) => networker.dcId !== baseDcId);
    checkPromise.then((canRelease) => {
      if(networker.onDrain) {
        return;
      }

      if(canRelease) {
        networker.onDrain = () => this.onNetworkerDrain(networker);
        networker.setDrainTimeout();
      }
    });
  }

  public setUpdatesProcessor(callback: (obj: any) => void) {
    this.networkerFactory.setUpdatesProcessor(callback);
  }

  public setPhantomChatMTProtoServer(server: PhantomChatMTProtoServer) {
    this.phantomchatMTProtoServer = server;
  }

  // Static response shapes for methods that don't need real data.
  // Dynamic methods (getHistory, search, etc.) go through the MessagePort bridge.
  private static readonly PHANTOMCHAT_STATIC: Record<string, any> = {
    'messages.getSearchCounters': [],
    'messages.getSavedDialogs': {_: 'messages.savedDialogs', dialogs: [], messages: [], chats: [], users: []},
    'messages.getPinnedSavedDialogs': {_: 'messages.savedDialogs', dialogs: [], messages: [], chats: [], users: []},
    'messages.getDialogFilters': {_: 'messages.dialogFilters', pFlags: {}, filters: []},
    'messages.getSuggestedDialogFilters': [],
    'messages.updateDialogFilter': true,
    'messages.updateDialogFiltersOrder': true,
    'messages.getPeerDialogs': {_: 'messages.peerDialogs', dialogs: [], messages: [], chats: [], users: [], state: {_: 'updates.state', pts: 1, qts: 0, date: 0, seq: 1, unread_count: 0}},
    'messages.getStickers': {_: 'messages.stickers', hash: 0, stickers: []},
    'messages.getAllStickers': {_: 'messages.allStickers', hash: 0, sets: []},
    'messages.getEmojiKeywordsDifference': {_: 'emojiKeywordsDifference', lang_code: 'en', from_version: 0, version: 1, keywords: []},
    // PhantomChat mode: the sticker/lottie catalog doesn't exist P2P-side, so the
    // `static_icon`/`appear_animation`/`select_animation`/etc. Document fields
    // are intentionally undefined. `reactionsMenu.ts` + `reaction.ts` have
    // guards to fall back to plain emoji text rendering when the docs are
    // missing. Populating `reaction` + `title` gives the UI enough metadata
    // to show the picker and wire clicks through to the NIP-25 send path.
    'messages.getAvailableReactions': {_: 'messages.availableReactions', hash: 0, reactions: [
      {_: 'availableReaction', pFlags: {}, reaction: '\u{1F44D}', title: '\u{1F44D}', static_icon: undefined, appear_animation: undefined, select_animation: undefined, activate_animation: undefined, effect_animation: undefined, around_animation: undefined, center_icon: undefined},
      {_: 'availableReaction', pFlags: {}, reaction: '\u2764\uFE0F', title: '\u2764\uFE0F', static_icon: undefined, appear_animation: undefined, select_animation: undefined, activate_animation: undefined, effect_animation: undefined, around_animation: undefined, center_icon: undefined},
      {_: 'availableReaction', pFlags: {}, reaction: '\u{1F602}', title: '\u{1F602}', static_icon: undefined, appear_animation: undefined, select_animation: undefined, activate_animation: undefined, effect_animation: undefined, around_animation: undefined, center_icon: undefined},
      {_: 'availableReaction', pFlags: {}, reaction: '\u{1F525}', title: '\u{1F525}', static_icon: undefined, appear_animation: undefined, select_animation: undefined, activate_animation: undefined, effect_animation: undefined, around_animation: undefined, center_icon: undefined},
      {_: 'availableReaction', pFlags: {}, reaction: '\u{1F389}', title: '\u{1F389}', static_icon: undefined, appear_animation: undefined, select_animation: undefined, activate_animation: undefined, effect_animation: undefined, around_animation: undefined, center_icon: undefined},
      {_: 'availableReaction', pFlags: {}, reaction: '\u{1F622}', title: '\u{1F622}', static_icon: undefined, appear_animation: undefined, select_animation: undefined, activate_animation: undefined, effect_animation: undefined, around_animation: undefined, center_icon: undefined},
      {_: 'availableReaction', pFlags: {}, reaction: '\u{1F621}', title: '\u{1F621}', static_icon: undefined, appear_animation: undefined, select_animation: undefined, activate_animation: undefined, effect_animation: undefined, around_animation: undefined, center_icon: undefined},
      {_: 'availableReaction', pFlags: {}, reaction: '\u{1F914}', title: '\u{1F914}', static_icon: undefined, appear_animation: undefined, select_animation: undefined, activate_animation: undefined, effect_animation: undefined, around_animation: undefined, center_icon: undefined}
    ]},
    // Found by fuzzer (FIND-5c45981a): chat-open fires getMessageReactionsList +
    // getAvailableEffects + getPeerSettings, all of which crashed downstream
    // processResult calls on the `{pFlags:{}}` fallback. Ship properly-shaped
    // static responses so the chat-open path is noiseless in PhantomChat mode.
    'messages.getMessageReactionsList': {_: 'messages.messageReactionsList', count: 0, reactions: [], chats: [], users: [], next_offset: ''},
    'messages.getAvailableEffects': {_: 'messages.availableEffects', hash: 0, effects: [], documents: []},
    'messages.getPeerSettings': {_: 'messages.peerSettings', settings: {_: 'peerSettings', pFlags: {}}, chats: [], users: []},
    'messages.getEmojiKeywords': {_: 'emojiKeywordsDifference', lang_code: 'en', from_version: 0, version: 1, keywords: []},
    'messages.getEmojiStickers': {_: 'messages.allStickers', hash: 0, sets: []},
    // PhantomChat mode: peer reactions menu is rendered from getTopReactions, so
    // it MUST mirror the getAvailableReactions catalog — else the picker
    // renders 0 entries even when the catalog is populated.
    'messages.getTopReactions': {_: 'messages.reactions', hash: 0, reactions: [
      {_: 'reactionEmoji', emoticon: '\u{1F44D}'},
      {_: 'reactionEmoji', emoticon: '\u2764\uFE0F'},
      {_: 'reactionEmoji', emoticon: '\u{1F602}'},
      {_: 'reactionEmoji', emoticon: '\u{1F525}'},
      {_: 'reactionEmoji', emoticon: '\u{1F389}'},
      {_: 'reactionEmoji', emoticon: '\u{1F622}'},
      {_: 'reactionEmoji', emoticon: '\u{1F621}'},
      {_: 'reactionEmoji', emoticon: '\u{1F914}'}
    ]},
    'messages.getRecentReactions': {_: 'messages.reactions', hash: 0, reactions: []},
    'messages.getPaidReactionPrivacy': {_: 'updates', updates: [{_: 'updatePaidReactionPrivacy', private: false}], users: [], chats: [], date: 0, seq: 0},
    'messages.getCustomEmojiDocuments': [],
    'messages.getFeaturedStickers': {_: 'messages.featuredStickers', hash: 0, sets: [], count: 0, unread: []},
    'messages.getArchivedStickers': {_: 'messages.archivedStickers', sets: [], count: 0},
    'messages.getMaskStickers': {_: 'messages.allStickers', hash: 0, sets: []},
    'messages.getFavedStickers': {_: 'messages.favedStickers', hash: 0, packs: [], stickers: []},
    'messages.getRecentStickers': {_: 'messages.recentStickers', hash: 0, packs: [], stickers: [], dates: []},
    'messages.getSavedGifs': {_: 'messages.savedGifs', hash: 0, gifs: []},
    'messages.getOldFeaturedStickers': {_: 'messages.featuredStickers', hash: 0, sets: [], count: 0, unread: []},
    'payments.getPremiumGiftCodeOptions': [],
    'contacts.getTopPeers': {_: 'contacts.topPeersDisabled'},
    'updates.getState': {_: 'updates.state', pts: 1, qts: 0, date: Math.floor(Date.now() / 1000), seq: 1, unread_count: 0},
    'updates.getDifference': {_: 'updates.differenceEmpty', date: Math.floor(Date.now() / 1000), seq: 1},
    'photos.getUserPhotos': {_: 'photos.photos', photos: [], users: []},
    'stories.getAllStories': {_: 'stories.allStories', pFlags: {}, count: 0, state: '', peer_stories: [], chats: [], users: [], stealth_mode: {_: 'storiesStealthMode', pFlags: {}}},
    'stories.getPeerStories': {_: 'stories.peerStories', stories: {_: 'peerStories', pFlags: {}, peer: {_: 'peerUser', user_id: 0}, stories: []}, chats: [], users: []},
    'account.getContentSettings': {_: 'account.contentSettings', pFlags: {}},
    'account.getNotifySettings': {_: 'peerNotifySettings', pFlags: {}, flags: 0},
    'account.getPassword': {_: 'account.password', pFlags: {has_password: false}, new_algo: {_: 'passwordKdfAlgoUnknown'}, new_secure_algo: {_: 'securePasswordKdfAlgoUnknown'}, secure_random: new Uint8Array(0)},
    // 'account.getPrivacy' moved to PHANTOMCHAT_BRIDGE_METHODS — VMT now reads
    // it from localStorage so the user's setPrivacy choice round-trips
    // across reload (was: hardcoded allowAll regardless of what setPrivacy
    // last stored). See virtual-mtproto-server.ts getPrivacy/setPrivacy.
    'help.getConfig': {_: 'config', date: Math.floor(Date.now() / 1000), expires: Math.floor(Date.now() / 1000) + 3600, test_mode: false, this_dc: 1, dc_options: [], dc_txt_domain_name: '', chat_size_max: 200, megagroup_size_max: 200000, forwarded_count_max: 100, online_update_period_ms: 210000, offline_blur_timeout_ms: 5000, offline_idle_timeout_ms: 30000, online_cloud_timeout_ms: 300000, notify_cloud_delay_ms: 30000, notify_default_delay_ms: 1500, push_chat_period_ms: 60000, push_chat_limit: 2, edit_time_limit: 172800, revoke_time_limit: 172800, revoke_pm_time_limit: 2147483647, rating_e_decay: 2419200, stickers_recent_limit: 15, caption_length_max: 1024, message_length_max: 4096, webfile_dc_id: 1, pFlags: {}},
    'help.getPeerColors': {_: 'help.peerColors', hash: 0, colors: []},
    'help.getPeerProfileColors': {_: 'help.peerColors', hash: 0, colors: []},
    'help.getAppConfig': {_: 'help.appConfig', hash: 0, config: {_: 'jsonObject', value: []}},
    'langpack.getDifference': {_: 'langPackDifference', lang_code: 'en', from_version: 0, version: 1, strings: []},

    // ─── P1: Core messaging / contacts / groups ───────────────────────
    'messages.getMessages': {_: 'messages.messages', messages: [], users: [], chats: []},
    'messages.getMessagesViews': {_: 'messages.messagesViews', views: [], chats: [], users: []},
    'messages.getOnlines': {_: 'chatOnlines', onlines: 0},
    'messages.getAllDrafts': {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0},
    'messages.getDefaultHistoryTTL': {_: 'defaultHistoryTTL', period: 0},
    'messages.getScheduledHistory': {_: 'messages.messages', messages: [], users: [], chats: [], count: 0},
    'messages.getForumTopics': {_: 'messages.forumTopics', topics: [], messages: [], chats: [], users: [], count: 0, pts: 1},
    'messages.getForumTopicsByID': {_: 'messages.forumTopics', topics: [], messages: [], chats: [], users: [], count: 0, pts: 1},
    'messages.getDhConfig': {_: 'messages.dhConfigNotModified', random: new Uint8Array(256)},
    'messages.getSavedHistory': {_: 'messages.messages', messages: [], users: [], chats: [], count: 0},
    'messages.createForumTopic': {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0},
    'messages.migrateChat': {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0},
    'messages.receivedMessages': [],
    'channels.getChannels': {_: 'messages.chats', chats: []},
    'channels.getMessages': {_: 'messages.messages', messages: [], users: [], chats: []},
    'channels.getParticipant': {_: 'channels.channelParticipant', participant: {_: 'channelParticipant', user_id: 0, date: 0}, chats: [], users: []},
    'channels.getParticipants': {_: 'channels.channelParticipants', count: 0, participants: [], chats: [], users: []},
    'channels.getSendAs': {_: 'channels.sendAsPeers', peers: [], chats: [], users: []},
    'contacts.getBlocked': {_: 'contacts.blocked', blocked: [], chats: [], users: [], count: 0},
    'contacts.search': {_: 'contacts.found', my_results: [], results: [], chats: [], users: []},
    'contacts.importContacts': {_: 'contacts.importedContacts', imported: [], popular_invites: [], retry_contacts: [], users: []},
    'contacts.resolvePhone': {_: 'contacts.resolvedPeer', peer: {_: 'peerUser', user_id: 0}, chats: [], users: []},
    'updates.getChannelDifference': {_: 'updates.channelDifferenceEmpty', pFlags: {final: true}, pts: 1, timeout: 0},

    // ─── P2: Settings / account / langpack ────────────────────────────
    'account.getAuthorizations': {_: 'account.authorizations', authorization_ttl_days: 180, authorizations: []},
    'account.getWebAuthorizations': {_: 'account.webAuthorizations', authorizations: [], users: []},
    'account.getGlobalPrivacySettings': {_: 'globalPrivacySettings', pFlags: {}},
    'account.getContactSignUpNotification': false,
    'account.getNotifyExceptions': {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0},
    'account.getPaidMessagesRevenue': {_: 'account.paidMessagesRevenue', pFlags: {}, starsAmount: 0},
    'account.getPasskeys': {_: 'account.passkeys', passkeys: []},
    'account.getTmpPassword': {_: 'account.tmpPassword', tmp_password: new Uint8Array(0), valid_until: 0},
    'account.checkUsername': {_: 'boolTrue'},
    'account.registerDevice': true,
    'account.unregisterDevice': true,
    'account.uploadWallPaper': {_: 'wallPaperNoFile', id: 0, pFlags: {}, settings: {_: 'wallPaperSettings', pFlags: {}}},
    // Downstream callers (appThemesManager / appDialogsManager) do
    // `result.wallpapers.filter(...)` / `result.themes.filter(...)`, so the
    // `{pFlags:{}}` fallback crashes with "Cannot read properties of undefined".
    // Return the empty-but-valid `account.wallPapers` / `account.themes`
    // variants (not the *NotModified forms) so the arrays exist.
    'account.getWallPapers': {_: 'account.wallPapers', hash: 0, wallpapers: []},
    'account.getThemes': {_: 'account.themes', hash: 0, themes: []},
    'account.verifyEmail': {_: 'account.emailVerified', email: ''},
    'account.resendPasswordEmail': true,
    'account.initPasskeyRegistration': {_: 'account.passkeyRegistrationOptions', options: ''},
    'account.registerPasskey': {_: 'boolFalse'},
    'account.declinePasswordReset': true,
    'help.getCountriesList': {_: 'help.countriesList', countries: [], hash: 0},
    'help.getNearestDc': {_: 'nearestDc', country: 'US', this_dc: 1, nearest_dc: 1},
    'help.getPromoData': {_: 'help.promoDataEmpty', expires: Math.floor(Date.now() / 1000) + 86400},
    'help.getTimezonesList': {_: 'help.timezonesList', timezones: [], hash: 0},
    'langpack.getLangPack': {_: 'langPackDifference', lang_code: 'en', from_version: 0, version: 1, strings: []},
    'langpack.getLanguages': [],
    'langpack.getStrings': {_: 'langPackDifference', lang_code: 'en', from_version: 0, version: 1, strings: []},
    'users.getRequirementsToContact': {_: 'users.requirementsToContact', pFlags: {}},
    'users.getSavedMusic': {_: 'messages.messages', messages: [], users: [], chats: [], count: 0},

    // ─── P3: Telegram-only (payments, bots, premium, calls, etc.) ─────
    'auth.checkPassword': {_: 'auth.authorization', pFlags: {}, user: {_: 'user', id: 0, pFlags: {}}},
    'auth.exportAuthorization': {_: 'auth.exportedAuthorization', id: 0, bytes: new Uint8Array(0)},
    'auth.importAuthorization': {_: 'auth.authorization', pFlags: {}, user: {_: 'user', id: 0, pFlags: {}}},
    'auth.logOut': {_: 'auth.loggedOut', pFlags: {}},
    'auth.exportLoginToken': {_: 'auth.loginToken', expires: 0, token: new Uint8Array(0)},
    'auth.importLoginToken': {_: 'auth.loginToken', expires: 0, token: new Uint8Array(0)},
    'auth.importWebTokenAuthorization': {_: 'auth.authorization', pFlags: {}, user: {_: 'user', id: 0, pFlags: {}}},
    'auth.signIn': {_: 'auth.authorization', pFlags: {}, user: {_: 'user', id: 0, pFlags: {}}},
    'auth.signUp': {_: 'auth.authorization', pFlags: {}, user: {_: 'user', id: 0, pFlags: {}}},
    'auth.initPasskeyLogin': {_: 'auth.passkeyLoginOptions', options: ''},
    'auth.finishPasskeyLogin': {_: 'auth.authorization', pFlags: {}, user: {_: 'user', id: 0, pFlags: {}}},
    'auth.recoverPassword': {_: 'auth.authorization', pFlags: {}, user: {_: 'user', id: 0, pFlags: {}}},
    'auth.requestPasswordRecovery': {_: 'auth.passwordRecovery', email_pattern: ''},
    'bots.getBotInfo': {_: 'bots.botInfo', pFlags: {}},
    'bots.invokeWebViewCustomMethod': {_: 'dataJSON', data: '{}'},
    'bots.checkDownloadFileParams': {_: 'boolTrue'},
    'channels.checkUsername': {_: 'boolTrue'},
    'channels.checkSearchPostsFlood': {_: 'boolFalse'},
    'channels.getGroupsForDiscussion': {_: 'messages.chats', chats: []},
    // Downstream caller (appChatsManager.getChannelRecommendations) does
    // `messagesChats.chats` — fallback `{pFlags:{}}` crashes processResult.
    'channels.getChannelRecommendations': {_: 'messages.chats', chats: []},
    // Downstream caller (appProfileManager.getChatFull) accesses
    // `result.full_chat.chat_photo`, `result.full_chat.call`,
    // `result.full_chat.notify_settings`, `result.chats`, `result.users`.
    // `getParticipants` later reads `chatFull.participants._` to dispatch
    // on chatParticipants vs chatParticipantsForbidden. PhantomChat has no
    // Telegram-style full-chat data (groups are P2P via GroupAPI), so a
    // minimal chatParticipantsForbidden stub satisfies every consumer.
    'messages.getFullChat': {
      _: 'messages.chatFull',
      full_chat: {
        _: 'chatFull',
        pFlags: {},
        id: 0,
        about: '',
        participants: {_: 'chatParticipantsForbidden', chat_id: 0},
        notify_settings: {_: 'peerNotifySettings', flags: 0}
      },
      chats: [],
      users: []
    },
    'channels.deactivateAllUsernames': true,
    // channels.createChannel, channels.inviteToChannel → routed through BRIDGE
    'chatlists.getLeaveChatlistSuggestions': [],
    'contacts.getLocated': {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0},
    'messages.checkChatInvite': {_: 'chatInviteAlready', chat: {_: 'chat', id: 0, title: '', date: 0, pFlags: {}}},
    'messages.importChatInvite': {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0},
    'messages.exportChatInvite': {_: 'chatInviteExported', pFlags: {}, link: '', admin_id: 0, date: 0},
    'messages.getAdminsWithInvites': {_: 'messages.chatAdminsWithInvites', admins: [], users: []},
    'messages.getChatInviteImporters': {_: 'messages.chatInviteImporters', count: 0, importers: [], users: []},
    'messages.getExportedChatInvites': {_: 'messages.exportedChatInvites', count: 0, invites: [], users: []},
    'messages.getAttachMenuBots': {_: 'messages.attachMenuBots', hash: 0, bots: [], users: []},
    'messages.getBotCallbackAnswer': {_: 'messages.botCallbackAnswer', pFlags: {}},
    'messages.getInlineBotResults': {_: 'messages.botResults', pFlags: {}, query_id: '0', results: [], users: []},
    'messages.getDiscussionMessage': {_: 'messages.discussionMessage', messages: [], max_id: 0, read_inbox_max_id: 0, read_outbox_max_id: 0, unread_count: 0, chats: [], users: []},
    'messages.getExtendedMedia': {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0},
    'messages.getFactCheck': [],
    'messages.getMessageReadParticipants': [],
    'messages.getOutboxReadDate': {_: 'outboxReadDate', date: 0},
    'messages.getPollResults': {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0},
    'messages.getPollVotes': {_: 'messages.votesList', count: 0, votes: [], chats: [], users: []},
    'messages.getSavedReactionTags': {_: 'messages.savedReactionTags', tags: [], hash: 0},
    'messages.getSponsoredMessages': {_: 'messages.sponsoredMessages', pFlags: {}, messages: [], chats: [], users: []},
    'messages.getStickerSet': {_: 'messages.stickerSet', set: {_: 'stickerSet', pFlags: {}, id: '0', access_hash: '0', title: '', short_name: '', count: 0, hash: 0}, packs: [], keywords: [], documents: []},
    'messages.clickSponsoredMessage': true,
    'messages.viewSponsoredMessage': true,
    'messages.faveSticker': true,
    'messages.requestUrlAuth': {_: 'urlAuthResultAccepted', url: ''},
    'messages.startBot': {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0},
    'messages.summarizeText': {_: 'textWithEntities', text: '', entities: []},
    'messages.translateText': {_: 'messages.translateResult', result: []},
    'messages.uploadMedia': {_: 'messageMediaEmpty'},
    // messages.createChat → routed through BRIDGE for Nostr group creation
    'payments.getPaymentForm': {_: 'payments.paymentForm', pFlags: {}, form_id: '0', bot_id: 0, title: '', description: '', invoice: {_: 'invoice', pFlags: {}, currency: 'USD'}, provider_id: 0},
    'payments.getPaymentReceipt': {_: 'payments.paymentReceipt', pFlags: {}, date: 0, bot_id: 0, title: '', description: '', invoice: {_: 'invoice', pFlags: {}, currency: 'USD'}, currency: 'USD', total_amount: 0},
    'payments.getResaleStarGifts': {_: 'payments.starGifts', hash: 0, gifts: []},
    'payments.getSavedStarGift': {_: 'payments.savedStarGift', pFlags: {}},
    'payments.getStarGiftCollections': {_: 'payments.starGiftCollections', hash: 0, collections: []},
    'payments.getStarGiftUpgradePreview': {_: 'payments.starGiftUpgradePreview', sample_attributes: []},
    'payments.getStarGiftWithdrawalUrl': {_: 'payments.starGiftWithdrawalUrl', url: ''},
    'payments.getStarsGiftOptions': [],
    'payments.getStarsGiveawayOptions': [],
    'payments.getStarsStatus': {_: 'payments.starsStatus', pFlags: {}, balance: 0, history: [], chats: [], users: []},
    'payments.getStarsTopupOptions': [],
    'payments.getStarsTransactionsByID': {_: 'payments.starsStatus', pFlags: {}, balance: 0, history: [], chats: [], users: []},
    'payments.getUniqueStarGift': {_: 'payments.uniqueStarGift', gift: {_: 'starGift', id: '0', pFlags: {}, sticker: {_: 'documentEmpty', id: '0'}, stars: 0, convert_stars: 0}},
    'payments.getUniqueStarGiftValueInfo': {_: 'payments.uniqueStarGiftValueInfo', pFlags: {}},
    'payments.checkCanSendGift': {_: 'boolTrue'},
    'payments.convertStarGift': true,
    'payments.createStarGiftCollection': {_: 'payments.starGiftCollection', id: '0', title: ''},
    'payments.transferStarGift': true,
    'payments.validateRequestedInfo': {_: 'payments.validatedRequestedInfo', pFlags: {}},
    'phone.getGroupCallStreamChannels': {_: 'phone.groupCallStreamChannels', channels: []},
    'phone.getGroupCallStreamRtmpUrl': {_: 'phone.groupCallStreamRtmpUrl', url: '', key: ''},
    'phone.createGroupCall': {_: 'updates', updates: [], users: [], chats: [], date: 0, seq: 0},
    'phone.requestCall': {_: 'phone.phoneCall', phone_call: {_: 'phoneCallDiscarded', pFlags: {}, id: '0'}, users: []},
    'photos.uploadProfilePhoto': {_: 'photos.photo', photo: {_: 'photoEmpty', id: '0'}, users: []},
    'premium.getBoostsList': {_: 'premium.boostsList', count: 0, boosts: [], users: []},
    'stories.getStoriesByID': {_: 'stories.stories', count: 0, stories: [], chats: [], users: []},
    'stories.getPinnedStories': {_: 'stories.stories', count: 0, stories: [], chats: [], users: [], pinned_to_top: []},
    'stories.getStoriesArchive': {_: 'stories.stories', count: 0, stories: [], chats: [], users: []},
    'upload.getFile': {_: 'upload.file', type: {_: 'storage.fileUnknown'}, mtime: 0, bytes: new Uint8Array(0)},
    'upload.getWebFile': {_: 'upload.webFile', size: 0, mime_type: '', file_type: {_: 'storage.fileUnknown'}, mtime: 0, bytes: new Uint8Array(0)}
  };

  private static readonly PHANTOMCHAT_ACTION_PREFIXES = [
    '.set', '.save', '.delete', '.read', '.mark',
    '.toggle', '.send', '.block', '.unblock', '.join', '.leave',
    '.report', '.update', '.install', '.add', '.remove',
    '.accept', '.discard', '.confirm', '.cancel', '.clear',
    '.pin', '.unpin', '.reset', '.reorder', '.edit',
    '.hide'
  ];

  // Methods that require real data from PhantomChatMTProtoServer via MessagePort bridge
  private static readonly PHANTOMCHAT_BRIDGE_METHODS = new Set([
    'messages.getHistory',
    'messages.getDialogs',
    'messages.getPinnedDialogs',
    'messages.search',
    'messages.readHistory',
    'messages.deleteMessages',
    'messages.sendMessage',
    'messages.sendMedia',
    'messages.editMessage',
    'messages.sendReaction',
    'messages.createChat',
    'channels.createChannel',
    'channels.inviteToChannel',
    'contacts.getContacts',
    'users.getUsers',
    'users.getFullUser',
    'phantomchatSendFile',
    // Privacy rules: VMT persists via localStorage so the round-trip works
    // across reload. Worker → bridge → VMT for both read/write.
    'account.getPrivacy',
    'account.setPrivacy',
    // Typing / recording indicators: VMT (main thread) publishes the kind-20001
    // ephemeral over the relay layer. Without this the call hits the worker's
    // `.set` action-prefix no-op and the indicator never reaches the peer.
    'messages.setTyping'
  ]);

  private static _invariantsChecked = false;
  private static _loggedFallback: Set<string> | undefined;

  private phantomchatIntercept(method: string, params: any): any {
    // Validate static intercept config once at first call (see
    // src/lib/phantomchat/bridge-invariants.ts — rules 2 and 15).
    if(!ApiManager._invariantsChecked) {
      ApiManager._invariantsChecked = true;
      assertInvariant('PHANTOMCHAT_ACTION_PREFIXES', validateActionPrefixes(ApiManager.PHANTOMCHAT_ACTION_PREFIXES));
      assertInvariant('PHANTOMCHAT_BRIDGE_METHODS', validateBridgeMethods(ApiManager.PHANTOMCHAT_BRIDGE_METHODS));
    }

    // Main thread: use local server directly (unchanged)
    if(this.phantomchatMTProtoServer) {
      return this.phantomchatMTProtoServer.handleMethod(method, params);
    }

    // Worker: static methods stay local (no round-trip)
    const staticResponse = ApiManager.PHANTOMCHAT_STATIC[method];
    if(staticResponse !== undefined) return staticResponse;

    // Worker: dynamic methods go through MessagePort bridge
    if(ApiManager.PHANTOMCHAT_BRIDGE_METHODS.has(method)) {
      return MTProtoMessagePort.getInstance<false>()
      .invoke('phantomchatBridge', {method, params});
    }

    // Action methods → true
    if(ApiManager.PHANTOMCHAT_ACTION_PREFIXES.some((p) => method.includes(p))) return true;

    // Default fallback — log once per method so fuzzer/E2E can see which
    // un-mapped method fell through (commonly the root cause of processResult
    // crashes that expect arrays on the response).
    if(!ApiManager._loggedFallback) ApiManager._loggedFallback = new Set();
    if(!ApiManager._loggedFallback.has(method)) {
      ApiManager._loggedFallback.add(method);
      // Use console.log not .warn — INV-console-clean treats warn as error, and
      // this is diagnostic info for the fuzzer, not a regression.
      console.log('[PhantomChatVMT] fallback {pFlags:{}} for un-mapped method:', method);
    }
    return {pFlags: {}};
  }

  public invokeApi<T extends keyof MethodDeclMap>(method: T, params: MethodDeclMap[T]['req'] = {}, options: InvokeApiOptions = {}): CancellablePromise<MethodDeclMap[T]['res']> {
    // [PhantomChat.chat] Intercept MTProto calls and return empty results
    // This runs in the Worker context where the stub can't easily patch
    const phantomchatResult = this.phantomchatIntercept(method, params);
    if(phantomchatResult !== undefined) {
      const d = deferredPromise<any>();
      if(phantomchatResult instanceof Promise) {
        phantomchatResult.then((r) => d.resolve(r)).catch((e) => d.reject(e));
      } else {
        d.resolve(phantomchatResult);
      }
      return d;
    }

    const deferred = deferredPromise<MethodDeclMap[T]['res']>();

    let {afterMessageId, prepareTempMessageId} = options;
    if(prepareTempMessageId) {
      deferred.then(() => {
        delete this.afterMessageTempIds[prepareTempMessageId];
      });
    }

    if(MOUNT_CLASS_TO) {
      const startTime = Date.now();
      const interval = ctx.setInterval(() => {
        if(!cachedNetworker || !cachedNetworker.isStopped()) {
          this.log.error('Request is still processing:', method, params, options, 'time:', (Date.now() - startTime) / 1000);
        }
        // this.cachedUploadNetworkers[2].requestMessageStatus();
      }, 5e3);

      deferred.catch(noop).finally(() => {
        clearInterval(interval);
      });
    }

    const rejectPromise = async(error: ApiError) => {
      if(!error) {
        error = makeError('ERROR_EMPTY');
      } else if(!isObject(error)) {
        error = makeError(undefined, error);
      }

      if((error.code === 401 && error.type === 'SESSION_REVOKED') ||
        (error.code === 406 && error.type === 'AUTH_KEY_DUPLICATED')) {
        this.logOut();
      }

      if(options.ignoreErrors) {
        throw error;
      }

      if(error.code === 406) {
        error.handled = true;
      }

      if(!options.noErrorBox) {
        // error.stack = stack || (error.originalError && error.originalError.stack) || error.stack || (new Error()).stack;
        setTimeout(() => {
          if(!error.handled) {
            if(error.code === 401) {
              this.logOut();
            } else {
              // ErrorService.show({error: error}); // WARNING
            }

            error.handled = true;
          }
        }, 100);
      }

      throw error;
    };

    let dcId: DcId;

    let cachedNetworker: MTPNetworker;
    // const stack = (new Error()).stack || 'empty stack';
    const performRequest = (): Promise<any> => {
      if(afterMessageId) {
        const after = this.afterMessageTempIds[afterMessageId];
        if(after) {
          options.afterMessageId = after.messageId;
        }
      }

      const promise = cachedNetworker.wrapApiCall(method, params, options);

      if(prepareTempMessageId) {
        this.afterMessageTempIds[prepareTempMessageId] = {
          messageId: (options as MTMessage).messageId,
          promise: deferred
        };
      }

      return promise.catch((error: ApiError) => {
        // if(!options.ignoreErrors) {
        if(error.type !== 'FILE_REFERENCE_EXPIRED' && error.type !== 'FILE_REFERENCE_INVALID'/*  && error.type !== 'MSG_WAIT_FAILED' */) {
          this.log.error('Error', error.code, error.type, this.baseDcId, dcId, method, params);
        }

        if(error.code === 401 && this.baseDcId === dcId) {
          if(error.type !== 'SESSION_PASSWORD_NEEDED') {
            AccountController.update(this.getAccountNumber(), {
              dcId: undefined
            });
          }
          throw error;
        } else if(error.code === 401 && this.baseDcId && dcId !== this.baseDcId) {
          if(this.cachedExportPromise[dcId] === undefined) {
            const promise = new Promise((exportResolve, exportReject) => {
              this.invokeApi('auth.exportAuthorization', {dc_id: dcId}, {noErrorBox: true}).then((exportedAuth) => {
                this.invokeApi('auth.importAuthorization', {
                  id: exportedAuth.id,
                  bytes: exportedAuth.bytes
                }, {dcId, noErrorBox: true}).then(exportResolve, exportReject);
              }, exportReject);
            });

            this.cachedExportPromise[dcId] = promise;
          }

          return this.cachedExportPromise[dcId].then(() => performRequest());
        } else if(error.code === 303) {
          const newDcId = +error.type.match(/^(PHONE_MIGRATE_|NETWORK_MIGRATE_|USER_MIGRATE_|STATS_MIGRATE_)(\d+)/)[2] as DcId;
          if(newDcId !== dcId) {
            if(options.dcId) {
              options.dcId = newDcId;
            } else {
              this.setBaseDcId(newDcId);
            }

            return this.invokeApi(method, params, options);
          }
        } else if(error.code === 400 && error.type.indexOf('FILE_MIGRATE') === 0) {
          const newDcId = +error.type.match(/^(FILE_MIGRATE_)(\d+)/)[2] as DcId;
          if(newDcId !== dcId) {
            options.dcId = newDcId;
            return this.invokeApi(method, params, options);
          } else {
            throw error;
          }
        } else if(error.code === 400 && error.type === 'CONNECTION_NOT_INITED') {
          this.networkerFactory.unsetConnectionInited();
          return performRequest();
        } else if(!options.rawError && error.code === 420 && !error.type.includes('SLOWMODE_WAIT') && error.type !== 'FROZEN_METHOD_INVALID') {
          const match = error.type.match(/^FLOOD_WAIT_(\d+)/) || error.type.match(/_(\d+)_?/);
          let waitTime: number;
          if(match) {
            waitTime = +match[1];
          }

          if(error.type.includes('FLOOD_PREMIUM_WAIT')) {
            Promise.all([
              this.getAppConfig(),
              this.appStateManager.getState()
            ]).then(([appConfig, state]) => {
              const timestamp = tsNow(true);
              const shouldShowToast = (timestamp - (state.shownUploadSpeedTimestamp || 0)) >= appConfig.upload_premium_speedup_notify_period;
              if(!shouldShowToast) {
                return;
              }

              this.appStateManager.pushToState('shownUploadSpeedTimestamp', timestamp);
              this.rootScope.dispatchEvent('file_speed_limited', {
                increaseTimes: (options.fileUpload ? appConfig.upload_premium_speedup_upload : appConfig.upload_premium_speedup_download) || 10,
                isUpload: !!options.fileUpload
              });
            });
          }

          waitTime ||= 1;

          if(waitTime > (options.floodMaxTimeout ?? 60) && !options.prepareTempMessageId) {
            throw error;
          }

          return pause(waitTime/* (waitTime + 5) */ * 1000).then(() => performRequest());
        } else if(!options.rawError && ['MSG_WAIT_FAILED', 'MSG_WAIT_TIMEOUT'].includes(error.type)) {
          const after = this.afterMessageTempIds[afterMessageId];

          afterMessageId = undefined;
          delete options.afterMessageId;

          if(after) return after.promise.then(() => performRequest());
          else return performRequest();
        } else if(!options.rawError && error.code === 500) {
          const now = Date.now();
          if(options.stopTime) {
            if(now >= options.stopTime) {
              throw error;
            }
          }

          options.waitTime = options.waitTime ? Math.min(60, options.waitTime * 1.5) : 1;
          return pause(options.waitTime * 1000).then(() => performRequest());
        } else if(error.type === 'UNKNOWN' || error.type === 'MTPROTO_CLUSTER_INVALID') { // cluster invalid - request from regular user to premium endpoint
          return pause(1000).then(() => performRequest());
        } else {
          if(RepayRequestHandler.canHandleError(error))
            error = RepayRequestHandler.attachInvokeArgsToError(error, [method, params, options]);

          throw error;
        }
      });
    }

    let p: Promise<MTPNetworker>;
    if(dcId = (options.dcId || this.baseDcId)) {
      p = this.getNetworker(dcId, options);
    } else {
      p = this.getBaseDcId().then((baseDcId) => this.getNetworker(dcId = baseDcId, options));
    }

    p.then((networker) => {
      cachedNetworker = networker;
      const promise = performRequest();
      cachedNetworker.attachPromise(deferred, options as MTMessage);
      return promise;
    })
    .then(deferred.resolve.bind(deferred))
    .catch(rejectPromise)
    .catch(deferred.reject.bind(deferred));

    return deferred;
  }
}
