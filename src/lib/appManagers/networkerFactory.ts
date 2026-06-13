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

import MTPNetworker from '@lib/mtproto/networker';
import App from '@config/app';
// [Nostra.chat] Unused imports kept for D-03 (no file deletion):
// import indexOfAndSplice from '@helpers/array/indexOfAndSplice';
import {AppManager} from '@appManagers/manager';
// import AccountController from '@lib/accounts/accountController';
// import bytesToHex from '@helpers/bytes/bytesToHex';
// import {getEnvironment} from '@environment/utils';

export class NetworkerFactory extends AppManager {
  private networkers: MTPNetworker[] = [];
  public language = navigator.language || App.langPackCode;
  public updatesProcessor: (obj: any) => void = null;
  // public onConnectionStatusChange: (status: ConnectionStatusChange) => void = null;
  public akStopped = false;

  constructor() {
    super();
    this.name = 'NET-FACTORY';
  }

  public removeNetworker(networker: MTPNetworker) {
    /* no-op -- MTProto disabled */
  }

  public setUpdatesProcessor(callback: (obj: any) => void) {
    this.updatesProcessor = callback;
  }

  public getNetworker(options: Omit<
    ConstructorParameters<typeof MTPNetworker>[0],
    'networkerFactory' | 'timeManager' | 'getBaseDcId' | 'updatesProcessor' | 'getInitConnectionParams'
  >): MTPNetworker {
    // [Nostra.chat] MTProto disabled: never create networker instances
    throw new Error('[Nostra.chat] MTProto disabled: cannot create networker');
  }

  public startAll() {
    /* no-op -- MTProto disabled */
  }

  public stopAll() {
    this.akStopped = true;
    /* no-op -- MTProto disabled (flag kept for compatibility) */
  }

  public setLanguage(langCode: string) {
    this.language = langCode;
    /* no-op -- MTProto disabled (language tracking kept) */
  }

  public unsetConnectionInited() {
    /* no-op -- MTProto disabled */
  }

  public forceReconnectTimeout() {
    /* no-op -- MTProto disabled */
  }

  public forceReconnect() {
    /* no-op -- MTProto disabled */
  }
}
