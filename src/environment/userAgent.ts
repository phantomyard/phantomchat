/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import ctx from '@environment/ctx';

// `navigator` is unavailable in node-pool vitest workers that load this module
// before vitest finishes installing the jsdom globals. Reference it via a
// guarded shim so the bare module evaluation can't throw ReferenceError.
const NAV: Navigator | null = typeof navigator !== 'undefined' ? navigator : null;
const UA = NAV?.userAgent ?? '';

export const USER_AGENT = NAV ? NAV.userAgent : null;
export const IS_APPLE = UA.search(/OS X|iPhone|iPad|iOS/i) !== -1;
export const IS_ANDROID = UA.toLowerCase().indexOf('android') !== -1;
export const IS_CHROMIUM = /Chrome/.test(UA) && /Google Inc/.test(NAV?.vendor ?? '');
export const CHROMIUM_VERSION = (() => {
  try {
    return +UA.match(/Chrom(?:e|ium)\/(.+?)(?:\s|\.)/)[1];
  } catch(err) {
  }
})();

// https://stackoverflow.com/a/58065241
export const IS_APPLE_MOBILE = !!NAV && (/iPad|iPhone|iPod/.test(NAV.platform) ||
  (NAV.platform === 'MacIntel' && NAV.maxTouchPoints > 1)) &&
  !(ctx as any).MSStream;

export const IS_SAFARI = !!('safari' in ctx) || !!(USER_AGENT && (/\b(iPad|iPhone|iPod)\b/.test(USER_AGENT) || (!!USER_AGENT.match('Safari') && !USER_AGENT.match('Chrome'))))/*  || true */;
export const IS_FIREFOX = UA.toLowerCase().indexOf('firefox') > -1;

export const IS_MOBILE_SAFARI = IS_SAFARI && IS_APPLE_MOBILE;

export const IS_MOBILE = !!NAV && (NAV.maxTouchPoints === undefined || NAV.maxTouchPoints > 0) && UA.search(/iOS|iPhone OS|Android|BlackBerry|BB10|Series ?[64]0|J2ME|MIDP|opera mini|opera mobi|mobi.+Gecko|Windows Phone/i) != -1;
