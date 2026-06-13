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

import type {TransportType} from '@lib/mtproto/dcConfigurator';

const Modes = {
  test: location.search.indexOf('test=1') > 0/*  || true */,
  debug: location.search.indexOf('debug=1') > 0,
  http: false,
  ssl: true, // location.search.indexOf('ssl=1') > 0 || location.protocol === 'https:' && location.search.indexOf('ssl=0') === -1,
  asServiceWorker: !!import.meta.env.VITE_MTPROTO_SW,
  transport: 'websocket' as TransportType,
  noSharedWorker: true, // Nostra.chat: force main-thread managers for API stub interception
  // Skip the Service Worker in `pnpm start` (dev). Vite HMR + cache-only SW
  // fetch handler fight each other: rebuilds don't get picked up until
  // DevTools "Clear site data", and the Phase A update flow false-positives
  // a compromise banner because HMR regenerates the SW hash. For realistic
  // SW behaviour use `pnpm preview` (PROD bundle) — the flag is forced on
  // only when `import.meta.env.PROD === false`.
  noServiceWorker: location.search.indexOf('noServiceWorker=1') > 0 || !import.meta.env.PROD,
  multipleTransports: !!(import.meta.env.VITE_MTPROTO_AUTO && import.meta.env.VITE_MTPROTO_HAS_HTTP && import.meta.env.VITE_MTPROTO_HAS_WS) && location.search.indexOf('noMultipleTransports=1') === -1,
  noPfs: true || location.search.indexOf('noPfs=1') > 0
};

if(import.meta.env.VITE_MTPROTO_HAS_HTTP) {
  const httpOnly = Modes.http = location.search.indexOf('http=1') > 0;
  if(httpOnly) {
    Modes.multipleTransports = false;
  }
}

// * start with HTTP first
if(Modes.multipleTransports) {
  Modes.http = true;
}

if(Modes.http) {
  Modes.transport = 'https';
}

export default Modes;
