/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import {logger, LogTypes} from '@lib/logger';
import onStreamFetch, {toggleStreamInUse} from '@lib/serviceWorker/stream';
import {closeAllNotifications, fillPushObject, onPing, onShownNotification, resetPushAccounts} from '@lib/serviceWorker/push';
import CacheStorageController from '@lib/files/cacheStorage';
import {IS_SAFARI} from '@environment/userAgent';
import ServiceMessagePort from '@lib/serviceWorker/serviceMessagePort';
import listenMessagePort from '@helpers/listenMessagePort';
import {getWindowClients} from '@helpers/context';
import {MessageSendPort} from '@lib/superMessagePort';
import handleDownload from '@lib/serviceWorker/download';
import onShareFetch, {checkWindowClientForDeferredShare} from '@lib/serviceWorker/share';
import {onRtmpFetch, onRtmpLeftCall} from '@lib/serviceWorker/rtmp';
import {onHlsQualityFileFetch} from '@lib/hls/onHlsQualityFileFetch';
import {get500ErrorResponse} from '@lib/serviceWorker/errors';
import {onHlsStreamFetch} from '@lib/hls/onHlsStreamFetch';
import {onHlsPlaylistFetch} from '@lib/hls/onHlsPlaylistFetch';
import {setEnvironment} from '@environment/utils';
import cryptoMessagePort from '@lib/crypto/cryptoMessagePort';
import EncryptionKeyStore from '@lib/passcode/keyStore';
import DeferredIsUsingPasscode from '@lib/passcode/deferredIsUsingPasscode';
import {onBackgroundsFetch} from '@lib/serviceWorker/backgrounds';
import {watchMtprotoOnDev} from '@lib/serviceWorker/watchMtprotoOnDev';
import {watchCacheStoragesLifetime} from './clearOldCache';
import '@lib/serviceWorker/nostra-push';
import {requestCacheStrict, unwrapRedirected} from './cache';
import {setActiveVersion, gcOrphans, getActiveVersion} from './shell-cache';
import {handleUpdateApproved} from './signed-update-sw';
import {getBakedPubkey} from '@lib/update/signing/trusted-keys';

// #if MTPROTO_SW
// import '../mtproto/mtproto.worker';
// #endif

export const log = logger('SW', LogTypes.Error | LogTypes.Debug | LogTypes.Log | LogTypes.Warn, true);
const ctx = self as any as ServiceWorkerGlobalScope;

// #if !MTPROTO_SW
let _mtprotoMessagePort: MessagePort;
export const getMtprotoMessagePort = () => _mtprotoMessagePort;

let _cryptoMessagePort: MessagePort;

export const invokeVoidAll: ServiceMessagePort['invokeVoid'] = (...args) => {
  getWindowClients().then((windowClients) => {
    windowClients.forEach((windowClient) => {
      // @ts-ignore
      serviceMessagePort.invokeVoid(...args, windowClient);
    });
  });
};

log('init');

// setTimeout(async() => {
//   const salt = new Uint8Array([1, 2, 3]);
//   const passcode = 'ab';
//   log('hello from sw started encryption');

//   const wrappedPasscode = await crypto.subtle.importKey(
//     'raw', new TextEncoder().encode(passcode), {name: 'PBKDF2'}, false, ['deriveKey']
//   );

//   const key = await crypto.subtle.deriveKey(
//     {name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-256'},
//     wrappedPasscode, {name: 'AES-GCM', length: 256}, true, ['encrypt', 'decrypt']
//   );

//   const enc = await cryptoMessagePort.invokeCryptoNew({
//     method: 'aes-local-encrypt',
//     args: [{data: new Uint8Array([1, 2, 3]), key}]
//   });

//   log('hello from sw data:>>', enc);
// }, 1000);

const sendMessagePort = (source: MessageSendPort) => {
  const channel = new MessageChannel();
  serviceMessagePort.attachPort(_mtprotoMessagePort = channel.port1);
  serviceMessagePort.invokeVoid('port', undefined, source, [channel.port2]);

  const channel2 = new MessageChannel();
  cryptoMessagePort.attachPort(_cryptoMessagePort = channel2.port1);
  serviceMessagePort.invokeVoid('serviceCryptoPort', undefined, source, [channel2.port2]);
};

const sendMessagePortIfNeeded = (source: MessageSendPort) => {
  if(!connectedWindows.size && !_mtprotoMessagePort) {
    log('sending message port for mtproto');
    sendMessagePort(source);
  }
};

const onWindowConnected = (source: WindowClient, from: string) => {
  const _log = log.bindPrefix('windowConnected');
  _log('new', source.id, 'from', from, 'before', connectedWindows.size);

  if(source.frameType === 'none') {
    log.warn('maybe a bugged Safari starting window', source.id);
    return;
  }

  if(connectedWindows.has(source.id)) {
    _log('already connected', source.id);
    return;
  }

  _log('before', Array.from(connectedWindows));
  serviceMessagePort.invokeVoid('hello', undefined, source);
  sendMessagePortIfNeeded(source);
  connectedWindows.set(source.id, source);
  _log('after', Array.from(connectedWindows));

  checkWindowClientForDeferredShare(source);
};

export const serviceMessagePort = new ServiceMessagePort<false>();

serviceMessagePort.addMultipleEventsListeners({
  environment: (environment) => {
    setEnvironment(environment);
  },

  notificationsClear: closeAllNotifications,

  toggleStorages: ({enabled, clearWrite}) => {
    CacheStorageController.toggleStorage(enabled, clearWrite);
  },

  pushPing: (payload, source) => {
    onPing(payload, source);
  },

  hello: (payload, source) => {
    onWindowConnected(source as any as WindowClient, 'hello');
  },

  shownNotification: onShownNotification,
  leaveRtmpCall: onRtmpLeftCall,

  toggleStreamInUse,

  toggleCacheStorage: (enabled) => {
    CacheStorageController.temporarilyToggle(enabled);
  },

  resetEncryptableCacheStorages: () => {
    CacheStorageController.resetOpenEncryptableCacheStorages();
  },

  toggleUsingPasscode: (payload) => {
    DeferredIsUsingPasscode.resolveDeferred(payload.isUsingPasscode);
    EncryptionKeyStore.save(payload.encryptionKey);
  },

  saveEncryptionKey: (payload) => {
    EncryptionKeyStore.save(payload);
  },

  fillPushObject,

  disableCacheStoragesByNames: (names) => {
    CacheStorageController.temporarilyToggleByNames(names, false);
  },

  enableCacheStoragesByNames: (names) => {
    CacheStorageController.temporarilyToggleByNames(names, true);
  },

  resetOpenCacheStoragesByNames: (names) => {
    CacheStorageController.resetOpenStoragesByNames(names);
  }
});

const {
  onDownloadFetch,
  onClosedWindows: onDownloadClosedWindows
} = handleDownload(serviceMessagePort);

// * service worker can be killed, so won't get 'hello' event
async function startupCheck() {
  const windowClients = await getWindowClients();
  const length = windowClients.length;
  log(`got ${length} windows from the start`);
  windowClients.forEach((windowClient) => {
    if(windowClient.frameType === 'none') {
      log.warn('skipping bugged Safari starting window', windowClient.id);
      return;
    }

    log('checking window', windowClient.id);
    try {
      const promise = serviceMessagePort.invoke(
        'hello',
        undefined,
        undefined,
        windowClient
      );

      let timedOut = false;
      const timeout = setTimeout(() => timedOut = true, 5000);
      promise.finally(() => {
        if(!timedOut) {
          clearTimeout(timeout);
          onWindowConnected(windowClient, 'startup check');
        }
      });
    } catch(err) {
      log.error('failed to send hello to window', windowClient.id, err);
    }
  });
}
startupCheck();

const connectedWindows: Map<string, WindowClient> = new Map();
(self as any).connectedWindows = connectedWindows;
listenMessagePort(serviceMessagePort, undefined, (source) => {
  log('something has disconnected', source);
  const isWindowClient = source instanceof WindowClient;
  if(!isWindowClient || !connectedWindows.has(source.id)) {
    log.warn('it is not a window');
    return;
  }

  connectedWindows.delete(source.id);
  log('window disconnected, left', connectedWindows.size);
  if(!connectedWindows.size) {
    log.warn('no windows left');

    if(DeferredIsUsingPasscode.isUsingPasscodeUndeferred()) {
      resetPushAccounts();
    }

    EncryptionKeyStore.resetDeferred();
    DeferredIsUsingPasscode.resetDeferred();

    if(_mtprotoMessagePort) {
      serviceMessagePort.detachPort(_mtprotoMessagePort);
      _mtprotoMessagePort = undefined;
    }
    if(_cryptoMessagePort) {
      cryptoMessagePort.detachPort(_cryptoMessagePort);
      _cryptoMessagePort = undefined;
    }

    onDownloadClosedWindows();
  }
});
// #endif

watchCacheStoragesLifetime({
  onStorageError: async({storageName, error}) => {
    log(`Error clearing old cache in ${storageName}:`, error);
    log(`Clearing cache storage ${storageName}`);

    const windowClients = await getWindowClients();
    if(!windowClients.length) return;

    await serviceMessagePort.invoke('clearCacheStoragesByNames', [storageName], undefined, windowClients[0]);
  }
});

watchMtprotoOnDev({connectedWindows, onWindowConnected});

const onFetch = (event: FetchEvent): void => {
  // Phase A (Task 11): CACHE-ONLY lockdown for all app-shell assets.
  // Navigation requests and shell file extensions are served strictly from cache.
  // Network fallback is intentionally removed — a missing asset means cache corruption.
  // update-manifest.json and .sig are exceptions (probe must reach network).
  // NOTE: no import.meta.env.PROD guard here — Vite's worker build doesn't inject
  // that flag into SW context, so the condition would always tree-shake to false.
  {
    const _url = new URL(event.request.url);
    const isSameOrigin = _url.origin === location.origin;
    const isNavigation = event.request.mode === 'navigate';
    const looksShell = _url.pathname === '/' || /\.(html?|js|css|wasm|json|svg|woff2?|ttf|webmanifest?|ico|png|jpe?g|mp3|tgs)(\?|$)/.test(_url.pathname);
    if(isSameOrigin && (isNavigation || looksShell)) {
      if(_url.pathname === '/update-manifest.json' || _url.pathname === '/update-manifest.json.sig') {
        // let network handle manifest probe requests
      } else {
        return event.respondWith(requestCacheStrict(event));
      }
    }
  }

  if(import.meta.env.DEV && event.request.url.match(/\.([jt]sx?|s?css)?($|\?)/)) {
    return;
  }

  try {
    // const [, url, scope, params] = /http[:s]+\/\/.*?(\/(.*?)(?:$|\/(.*)$))/.exec(event.request.url) || [];
    const [scope, _params] = event.request.url.split('/').slice(-2);
    const [params, search] = _params.split('?');

    // log.debug('[fetch]', event, event.request.url);

    switch(scope) {
      case 'stream': {
        onStreamFetch(event, params, search);
        break;
      }

      case 'd':
      case 'download': {
        onDownloadFetch(event, params);
        break;
      }

      case 'share': {
        onShareFetch(event, params);
        break;
      }

      case 'ping': {
        event.respondWith(new Response('pong'));
        break;
      }

      case 'rtmp': {
        onRtmpFetch(event, params, search);
        break;
      }

      case 'hls': {
        onHlsPlaylistFetch(event, params, search);
        break;
      }

      case 'hls_quality_file': {
        onHlsQualityFileFetch(event, params, search);
        break;
      }

      case 'hls_stream': {
        onHlsStreamFetch(event, params, search);
        break;
      }

      case 'backgrounds': {
        onBackgroundsFetch(event);
        break;
      }

      // default: {
      //   event.respondWith(fetch(event.request));
      //   break;
      // }
    }
  } catch(err) {
    log.error('fetch error', err);
    event.respondWith(get500ErrorResponse());
  }
};

const onChangeState = () => {
  ctx.onfetch = onFetch;
};

// Paths skipped at install-time precache and fetched on-demand instead.
// Currently emoji PNGs: 3700+ tiny images used only when the emoji picker opens.
// Precaching them blocks navigator.serviceWorker.ready for 20-30s on first install,
// and they carry near-zero exploit surface (decoded by native sandboxed image code,
// no script execution). They still appear in manifest.bundleHashes so the Phase A
// integrity model is intact — they're just lazy-loaded. The fetch handler serves
// them from network on first use and CacheStorage caches them automatically.
//
// NOTE: manifest entries are emitted with a leading "./" (e.g. "./assets/img/emoji/…"),
// so we normalize the path before regex-testing. The 0.14.1 build shipped a non-normalized
// filter that never matched anything — all 3788 emojis were still precached.
const SKIP_PRECACHE_PATTERNS: RegExp[] = [
  /^assets\/img\/emoji\//
];

function normalizeManifestPath(p: string): string {
  return p.replace(/^\.?\//, '');
}

ctx.addEventListener('install', (event) => {
  log('installing');
  event.waitUntil((async() => {
    try {
      const manifestRes = await fetch('/update-manifest.json', {cache: 'no-cache'});
      if(!manifestRes.ok) throw new Error(`manifest fetch ${manifestRes.status}`);
      const manifest = await manifestRes.json();
      const version = manifest.version as string;
      const bundleHashes = manifest.bundleHashes as Record<string, string>;
      const cacheName = `shell-v${version}`;
      const cache = await caches.open(cacheName);
      const allPaths = Object.keys(bundleHashes);
      const paths = allPaths.filter((p) => {
        const n = normalizeManifestPath(p);
        return !SKIP_PRECACHE_PATTERNS.some((re) => re.test(n));
      });
      const skippedCount = allPaths.length - paths.length;
      // First install is TOFU — no signature verification possible (no baked pubkey yet
      // on fresh machines, OR the manifest is the same-origin bundle that served us the SW).
      // Parallel fetch in batches to avoid the 30s install timeout. Each path is
      // retried with exponential backoff to tolerate transient CDN/network failures.
      // After retries, ANY missing path fails the install — emoji PNGs are already
      // excluded via SKIP_PRECACHE_PATTERNS, so every remaining path is load-bearing.
      // A partial precache would leave CACHE-ONLY fetches returning 404 at runtime,
      // which the 0.14.1 field report surfaced as a broken Settings → App Updates tab.
      const BATCH_SIZE = 32;
      const RETRY_DELAYS_MS = [200, 500, 1000];
      const failedPaths: string[] = [];
      let successCount = 0;
      for(let i = 0; i < paths.length; i += BATCH_SIZE) {
        const batch = paths.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async(p) => {
          // Encode URL-reserved chars (`#`, `?`) that fetch would treat as
          // fragment/query separators and silently strip.
          const encoded = p.replace(/#/g, '%23').replace(/\?/g, '%3F');
          const url = new URL(encoded, self.location.href).href;
          let lastErr: string = 'unknown';
          for(let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
            try {
              const res = await fetch(url, {cache: 'no-cache', redirect: 'follow'});
              if(res.ok) {
                // Strip the `redirected` flag before storing. Without this, a
                // navigation request served from this cache entry is aborted
                // by the browser with ERR_FAILED (Cloudflare Pages 301's
                // /index.html → / during install).
                await cache.put(p, await unwrapRedirected(res));
                successCount++;
                return;
              }
              lastErr = `HTTP ${res.status}`;
            } catch(err) {
              lastErr = err instanceof Error ? err.message : String(err);
            }
            if(attempt < RETRY_DELAYS_MS.length) {
              await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
            }
          }
          failedPaths.push(`${p} (${lastErr})`);
        }));
      }
      if(failedPaths.length > 0) {
        console.error('[sw] install: incomplete precache —', failedPaths.length, 'of', paths.length, 'paths missing:', failedPaths);
        throw new Error(`[sw] install: incomplete precache (${failedPaths.length}/${paths.length} failed)`);
      }
      // Persist version+fingerprint directly here in install — activate handler
      // cannot rely on self.__INSTALL_* globals because some browsers recycle
      // the worker scope between install and activate.
      try {
        await setActiveVersion(version, manifest.signingKeyFingerprint || 'ed25519:unset');
      } catch(err) {
        console.error('[sw] setActiveVersion during install failed:', err);
      }
      log('pre-cached shell for version', version, paths.length, 'files (skipped', skippedCount, 'on-demand)');
    } catch(e) {
      console.error('[sw] install failed:', e);
      throw e;
    }
    // NO skipWaiting() — new SW stays in waiting until user consent via main-thread SKIP_WAITING message.
  })());
});

ctx.addEventListener('activate', (event) => {
  log('activating', ctx);
  event.waitUntil((async() => {
    // setActiveVersion was called during install; activate just GCs orphan caches.
    try {
      await gcOrphans();
    } catch(err) {
      console.error('[sw] gcOrphans failed:', err);
    }
    // NO clients.claim() — reload is handled by main thread via controllerchange listener.
  })());
});

// Phase A: main thread sends {type: 'SKIP_WAITING'} after user consent.
// This is the ONLY path that promotes a waiting SW to active (no skipWaiting in install).
ctx.addEventListener('message', (event) => {
  if(event.data && event.data.type === 'SKIP_WAITING') {
    log('received SKIP_WAITING message, promoting this SW to active');
    ctx.skipWaiting();
  }
});

ctx.addEventListener('message', (event) => {
  if((event as any).data?.type !== 'UPDATE_APPROVED') return;
  const port = (event as any).ports[0] as MessagePort | undefined;
  // Bundle download + verify can take tens of seconds; without waitUntil the SW
  // may be terminated before UPDATE_RESULT posts back, leaving the popup
  // stuck on "Applying..." forever.
  (event as ExtendableMessageEvent).waitUntil((async() => {
    try {
      const active = await getActiveVersion();
      const pubkey = active?.installedPubkey || getBakedPubkey();
      const res = await handleUpdateApproved(
        (event as any).data.manifest,
        (event as any).data.signature,
        pubkey,
        (done: number, total: number) => port?.postMessage({type: 'UPDATE_PROGRESS', done, total}),
        (event as any).data.manifestText
      );
      port?.postMessage({type: 'UPDATE_RESULT', outcome: res.outcome, reason: res.reason, chunk: res.chunk, expected: res.expected, actual: res.actual});
    } catch(e) {
      port?.postMessage({type: 'UPDATE_RESULT', outcome: 'swap-failed', reason: String(e)});
    }
  })());
});

// ctx.onerror = (error) => {
//   log.error('error:', error);
// };

// ctx.onunhandledrejection = (error) => {
//   log.error('onunhandledrejection:', error);
// };

ctx.onoffline = ctx.ononline = onChangeState;

onChangeState();
