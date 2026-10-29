/*
 * Code Mode — a thin-client "coding inbox" inside PhantomChat.
 *
 * Andrew's call (2026-10-29): phantomcode is a MODE, not a second app. The
 * phantoms already run their own harnesses and do the work; PhantomChat stays
 * a thin client with no filesystem access and no local spawn, so Code Mode is
 * UI + a contact list — never an engine.
 *
 * This module holds the device-local plumbing only:
 *  - the StateSettings key (`codeModeEnabled`, same category as
 *    `defaultChatFolderId`: this browser's IndexedDB, never published to
 *    Nostr) so the rail selection survives a reload;
 *  - the body class the OpenCode-style skin hangs off;
 *  - the rail entry's label and glyph.
 *
 * Deliberately NOT here: any filter/folder storage. Code Mode is not a
 * `dialogFilter`, so it can never leak into `filter_order` or the FoldersSync
 * snapshot, and it needs no migration.
 */

/** StateSettings key under `settings.` where the Code Mode flag lives. */
export const CODE_MODE_SETTING_KEY = 'codeModeEnabled' as const;

/** Class added to `<body>`, and nothing else, so the whole skin is css-scoped. */
export const CODE_MODE_BODY_CLASS = 'code-mode';

/** Rail glyph. An emoji keeps us off the icomoon font (no asset regen). */
export const CODE_MODE_EMOJI_ICON = '💻';

/** LangPack key for the rail label. */
export const CODE_MODE_LANG_KEY = 'CodeMode' as const;

/**
 * A settings value read back from IndexedDB is untrusted shape: anything that
 * is not literally `true` means "off". Kept pure so the boot decision is
 * testable without a browser.
 */
export function isCodeModeEnabled(value: unknown): boolean {
  return value === true;
}

/**
 * Toggle the skin class on an element (the real one is `document.body`).
 * Returns whether the class is now present, so callers/tests can assert
 * without re-reading the DOM.
 */
export function applyCodeModeClass(element: {classList: Pick<DOMTokenList, 'add' | 'remove'>}, enabled: boolean): boolean {
  if(enabled) {
    element.classList.add(CODE_MODE_BODY_CLASS);
  } else {
    element.classList.remove(CODE_MODE_BODY_CLASS);
  }

  return enabled;
}
