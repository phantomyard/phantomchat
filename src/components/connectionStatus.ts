/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import DEBUG from '@config/debug';
import {LangPackKey, i18n} from '@lib/langPack';
import {logger} from '@lib/logger';
import rootScope from '@lib/rootScope';
import cancelEvent from '@helpers/dom/cancelEvent';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {AppManagers} from '@lib/managers';
import singleInstance from '@lib/singleInstance';
import InputSearch from '@components/inputSearch';

const NO_STATUS = false;
const TEST_DBLCLICK = false;
const HAVE_RECONNECT_BUTTON = false;

export default class ConnectionStatusComponent {
  public static CHANGE_STATE_DELAY = 400;
  public static INITIAL_DELAY = 2000;
  public static ANIMATION_DURATION = 250;

  // private statusContainer: HTMLElement;
  // private statusEl: HTMLElement;

  private hadConnect = false;
  private retryAt: number;
  private connecting = false;
  private timedOut = false;
  private updating = false;
  private relayStates: Map<string, boolean> = new Map();

  private log: ReturnType<typeof logger>;

  private setFirstConnectionTimeout: number;
  private setStateTimeout: number;

  private managers: AppManagers;
  private inputSearch: InputSearch;
  private rAF: number;

  public construct(
    managers: AppManagers,
    chatsContainer: HTMLElement,
    inputSearch: InputSearch
  ) {
    this.managers = managers;
    this.inputSearch = inputSearch;
    this.log = logger('CS', undefined, undefined);
    // this.statusContainer = document.createElement('div');
    // this.statusContainer.classList.add('connection-status'/* , 'hide' */);

    // this.statusEl = Button('btn-primary bg-warning connection-status-button', {noRipple: true});
    // this.statusContainer.append(this.statusEl);
    this.inputSearch.setPlaceholder('Search');

    // chatsContainer.prepend(this.statusContainer);

    rootScope.addEventListener('nostra_relay_state', (relayState) => {
      this.relayStates.set(relayState.url, relayState.connected);
      this.setRelayConnectionStatus();
    });

    rootScope.addEventListener('state_synchronizing', () => {
      this.updating = true;
      DEBUG && this.log('updating', this.updating);
      this.setState();
    });

    rootScope.addEventListener('state_synchronized', () => {
      DEBUG && this.log('state_synchronized');
      this.updating = false;
      DEBUG && this.log('updating', this.updating);
      this.setState();
    });

    this.setFirstConnectionTimeout = window.setTimeout(
      this.setRelayConnectionStatus,
      ConnectionStatusComponent.INITIAL_DELAY
    );

    if(TEST_DBLCLICK) {
      let bool = true;
      document.addEventListener('dblclick', () => {
        this.connecting = bool ? (bool = false, true) : (bool = true, this.updating = false, false);
        this.setState();
      });
    }
  }

  private setRelayConnectionStatus = () => {
    if(this.setFirstConnectionTimeout) {
      clearTimeout(this.setFirstConnectionTimeout);
      this.setFirstConnectionTimeout = 0;
    }

    // Per D-05: connected if ANY relay is connected
    // If no relay events received yet, assume not connecting (avoid false "Waiting for network...")
    if(this.relayStates.size === 0) {
      this.connecting = false;
      this.setState();
      return;
    }

    const anyConnected = Array.from(this.relayStates.values()).some((c) => c === true);

    if(anyConnected && !this.hadConnect) {
      this.hadConnect = true;
    }

    // Do NOT call forceGetDifference — no MTProto updates to fetch
    this.connecting = !anyConnected;
    this.timedOut = false;
    this.retryAt = undefined;
    DEBUG && this.log('connecting', this.connecting);
    this.setState();
  };

  private wrapSetStatusText = (...args: Parameters<InputSearch['setPlaceholder']>) => {
    return () => {
      return this.inputSearch.setPlaceholder(...args);
    };
  };

  private getA(langPackKey: LangPackKey, callback: () => void) {
    const a = document.createElement('a');
    a.classList.add('force-reconnect');
    a.append(i18n(langPackKey));
    attachClickEvent(a, (e) => {
      cancelEvent(e);
      callback();
    });

    return a;
  }

  private setState = () => {
    if(singleInstance.deactivatedReason) {
      return;
    }

    let setText: () => void;
    if(this.connecting) {
      if(this.timedOut) {
        // const a = this.getA('ConnectionStatus.ForceReconnect', () => this.managers.networkerFactory.forceReconnect());
        // setText = this.wrapSetStatusText('ConnectionStatus.TimedOut', [a]);
        setText = this.wrapSetStatusText('Updating');
      } else if(this.hadConnect) {
        if(this.retryAt !== undefined) {
          const timerSpan = document.createElement('span');
          const retryAt = this.retryAt;
          const setTime = () => {
            const now = Date.now();
            timerSpan.innerText = '' + Math.max(0, Math.round((retryAt - now) / 1000));
            if(now > retryAt) {
              clearInterval(interval);
            }
          };
          const interval = setInterval(setTime, 1e3);
          setTime();

          if(HAVE_RECONNECT_BUTTON) {
            const a = this.getA('ConnectionStatus.Reconnect', () => this.managers.networkerFactory.forceReconnectTimeout());
            setText = this.wrapSetStatusText('ConnectionStatus.ReconnectIn', [timerSpan, a]);
          } else {
            setText = this.wrapSetStatusText('ConnectionStatus.ReconnectInPlain', [timerSpan]);
          }
        } else {
          setText = this.wrapSetStatusText('ConnectionStatus.Reconnecting');
        }
      } else {
        setText = this.wrapSetStatusText('ConnectionStatus.Waiting');
      }
    } else if(this.updating) {
      setText = this.wrapSetStatusText('Updating');
    } else {
      setText = this.wrapSetStatusText('Search');
    }

    DEBUG && this.log('setState', this.connecting || this.updating);
    if(this.rAF) window.cancelAnimationFrame(this.rAF);
    this.rAF = window.requestAnimationFrame(() => {
      this.rAF = 0;
      if(this.setStateTimeout) clearTimeout(this.setStateTimeout);

      const wasVisible = this.inputSearch.isLoading();
      const cb = () => {
        if(NO_STATUS) {
          return;
        }

        setText();
        const isConnecting = this.connecting || this.updating;
        this.inputSearch.toggleLoading(isConnecting);
        this.setStateTimeout = 0;
        DEBUG && this.log('setState: isShown:', isConnecting);
      };

      if(wasVisible) {
        cb();
      } else {
        this.setStateTimeout = window.setTimeout(cb, ConnectionStatusComponent.CHANGE_STATE_DELAY);
      }
    });
  };
}
