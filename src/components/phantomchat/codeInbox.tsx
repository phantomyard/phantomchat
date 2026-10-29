/*
 * Code Mode — the session-first coding inbox (#279).
 *
 * Left column = SESSIONS (not phantoms):
 *
 *   [ the app's own Search field ]     ← the sticky one All Chats/Groups use
 *   Active      — idle sessions, newest first
 *   Archived    — manual archive, newest first
 *   Working     — live turns with the typing indicator, stacked bottom-up
 *
 * A session is a 2-member private group (you + one phantom), so two sessions
 * with the SAME phantom are genuinely independent threads — each one is its own
 * `group:<groupId>` conversation on the phantom side. Opening a session points
 * the ordinary chat pane at that group, which gives the full real transcript
 * with the real composer; nothing about the chat path changes.
 *
 * CREATION IS NOT IN HERE. `New Code Session` lives in the global ✏️ menu
 * (see sidebarLeft.startCodingSession): it opens the bot-filtered contact
 * picker, mints the group, selects Code Mode and opens the pane. This inbox
 * only lists, renames, archives and deletes.
 *
 * The rail is the only thing that renders sessions: session groups are kept out
 * of the chat list (see injectGroupCreateDialog), so All Chats and Groups stay
 * clean.
 *
 * Andrew's spec of record: phantomchat issue #279.
 */
import {createEffect, createMemo, createSignal, For, onCleanup, onMount, Show} from 'solid-js';
import {render} from 'solid-js/web';
import {i18n} from '@lib/langPack';
import I18n from '@lib/langPack';
import type {LangPackKey} from '@lib/langPack';
import {useHotReloadGuard} from '@lib/solidjs/hotReloadGuard';
import SolidJSHotReloadGuardProvider from '@lib/solidjs/hotReloadGuardProvider';
import {
  CODE_MODE_BODY_CLASS,
  CODE_MODE_EVENT,
  CODE_SESSIONS_CHANGED_EVENT,
  type CodeSessionInput,
  type CodeSessionRow,
  type CodeTurnEnd,
  filterSessionsByQuery,
  formatSessionAge,
  groupSessionRows,
  isCodeModeEnabled,
  sessionBadge,
  sessionElapsedLabel
} from '@lib/code-mode';
import {appSettings} from '@stores/appSettings';
import {ensureGroupChatInjected} from '@lib/phantomchat/phantomchat-groups-sync';
import {
  applyFirstPromptTitle,
  deleteSessionEverywhere,
  listSessions,
  renameSession,
  sessionPeerId,
  setSessionArchived
} from '@lib/phantomchat/code-session-service';
import {codeSessionRuntime, attachRuntimeEvents} from '@lib/phantomchat/code-session-runtime';
import type {BroadcastEvents} from '@lib/rootScope';
import {generateCodeSessionAvatar} from '@helpers/generateDicebearAvatar';

/** Backstop re-read for anything that changes sessions without an event. */
const REFRESH_INTERVAL_MS = 15_000;

/** How often the Working counter ticks. */
const CLOCK_INTERVAL_MS = 1000;

/** The sticky search field the rest of the app uses (see sidebarLeft.construct). */
const SEARCH_HEADER_SELECTOR = '#column-left .sidebar-header.main-search-sidebar-header';

type MenuKind = 'active' | 'archived';

interface MenuState {
  groupId: string;
  kind: MenuKind;
  x: number;
  y: number;
}

/** Attribute-safe string form: the `i18n()` helper builds a DOM node. */
const t = (key: LangPackKey): string => I18n.format(key, true);

function CodeInbox() {
  const {rootScope, appImManager} = useHotReloadGuard();

  const [sessions, setSessions] = createSignal<CodeSessionInput[]>([]);
  const [runtimeTick, setRuntimeTick] = createSignal(0);
  const [query, setQuery] = createSignal('');
  const [openGroupId, setOpenGroupId] = createSignal<string | null>(null);
  // Mirror the selection into the turn tracker: a turn that finishes on the row
  // the user is looking at is already read, so it must not paint a Done badge.
  createEffect(() => codeSessionRuntime.setOpenGroup(openGroupId()));
  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal('');
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [error, setError] = createSignal<string | null>(null);

  // The body class IS the mode; the event payload lands a tick earlier.
  let active = document.body.classList.contains(CODE_MODE_BODY_CLASS) ||
    isCodeModeEnabled(appSettings['codeModeEnabled']);
  const isActive = (): boolean => active || document.body.classList.contains(CODE_MODE_BODY_CLASS);

  const runtime = () => {
    // Re-read the tracker on every tick so rows re-derive from live turn state.
    runtimeTick();
    return codeSessionRuntime.snapshot();
  };

  const refresh = async() => {
    try {
      const records = await listSessions();
      setSessions(records.map((record) => ({
        groupId: record.groupId,
        // Empty until the first message names it — the row falls back to the
        // `New session` label (Andrew: "Use New Session until the first
        // message — then <10 chars>…").
        title: record.title,
        archived: record.archived,
        createdAt: record.createdAt,
        hasPrompt: record.hasPrompt !== false
      })));

      const peers = await Promise.all(records.map(async(record) => ({
        groupId: record.groupId,
        peerId: await sessionPeerId(record.groupId)
      })));
      codeSessionRuntime.setSessionPeers(peers);

      // Whatever is open in the real pane decides which row is selected and
      // read — this is how a session opened from the ✏️ menu (which never
      // goes through this component) still lands highlighted. The key is
      // resolved through the tracker because the pane reports the group's
      // CHAT peer id while the records carry the user one.
      const openGroup = codeSessionRuntime.groupIdForPeer(openChatPeerId());
      if(openGroup) {
        if(openGroupId() !== openGroup) setOpenGroupId(openGroup);
        codeSessionRuntime.markRead(openGroup);
      }

      setRuntimeTick((n) => n + 1);
    } catch(err) {
      console.warn('[CodeMode] refresh failed', err);
      setSessions([]);
    }
  };

  /** Peer id of the chat currently open in the right pane, 0 when none. */
  const openChatPeerId = (): number => {
    try {
      const peerId = (appImManager.chat as {peerId?: PeerId})?.peerId;
      return peerId ? +peerId : 0;
    } catch{
      return 0;
    }
  };

  const grouped = createMemo(() => groupSessionRows(sessions(), runtime(), now()));

  const filtered = createMemo(() => {
    const q = query();
    return {
      active: filterSessionsByQuery(grouped().active, q),
      archived: filterSessionsByQuery(grouped().archived, q),
      working: filterSessionsByQuery(grouped().working, q)
    };
  });

  // ─── actions ────────────────────────────────────────────────────

  const openSession = async(row: {groupId: string}) => {
    setMenu(null);
    setOpenGroupId(row.groupId);
    codeSessionRuntime.markRead(row.groupId);
    setRuntimeTick((n) => n + 1);

    try {
      const peerId = await sessionPeerId(row.groupId);

      // The chat/peer entries are normally injected by injectGroupCreateDialog,
      // which deliberately skips session groups. Opening a session is the one
      // place that must materialise them.
      await ensureGroupChatInjected(row.groupId, peerId);
      await appImManager.setInnerPeer({peerId: peerId.toPeerId(true)});
    } catch(err) {
      console.warn('[CodeMode] openSession failed', err);
      setError('Could not open this session.');
    }
  };

  const doRename = async(groupId: string) => {
    const value = renameValue().trim();
    setRenaming(null);
    setMenu(null);
    if(!value) return;
    await renameSession(groupId, value);
    void refresh();
  };

  const doArchive = async(groupId: string, archived: boolean) => {
    setMenu(null);
    await setSessionArchived(groupId, archived);
    if(archived && openGroupId() === groupId) setOpenGroupId(null);
    void refresh();
  };

  const doDelete = async(groupId: string) => {
    setMenu(null);
    setConfirmDelete(null);
    await deleteSessionEverywhere(groupId);
    codeSessionRuntime.forget(groupId);
    if(openGroupId() === groupId) setOpenGroupId(null);
    void refresh();
  };

  const openMenu = (event: MouseEvent, row: CodeSessionRow, kind: MenuKind) => {
    event.preventDefault();
    setConfirmDelete(null);
    setMenu({groupId: row.groupId, kind, x: event.clientX, y: event.clientY});
  };

  // ─── the app's own search field ─────────────────────────────────
  //
  // The inbox no longer carries a search box of its own: the sticky
  // `.main-search-sidebar-header` field that All Chats and Groups use is shown
  // in Code Mode too, and while the mode is on its value filters SESSION NAMES
  // instead of opening the global search overlay.

  let detachSearch: (() => void) | undefined;

  const attachSearchWidget = () => {
    const header = document.querySelector<HTMLElement>(SEARCH_HEADER_SELECTOR);
    const input = header?.querySelector<HTMLInputElement>('input.input-search-input');
    if(!header || !input || detachSearch) return;

    const previousPlaceholder = input.placeholder;

    // The overlay is NOT blocked here: sidebarLeft's own `focus` listener skips
    // `initSearch()` while Code Mode is on, so the field is a plain text input
    // owned by this component. Blocking mousedown/focus here would stop the
    // user from typing at all.
    const onInput = () => {
      if(!isActive()) return;
      setQuery(input.value);
    };

    const clearBtn = header.querySelector<HTMLElement>('.input-search-clear');
    const onClear = () => {
      if(!isActive()) return;
      setQuery('');
    };

    input.addEventListener('input', onInput);
    clearBtn?.addEventListener('click', onClear);

    detachSearch = () => {
      input.removeEventListener('input', onInput);
      clearBtn?.removeEventListener('click', onClear);
      input.placeholder = previousPlaceholder;
      detachSearch = undefined;
    };
  };

  /** Code Mode is the only place that search field filters sessions. */
  const syncSearchPlaceholder = (enabled: boolean) => {
    const input = document.querySelector<HTMLInputElement>(SEARCH_HEADER_SELECTOR + ' input.input-search-input');
    if(!input) return;
    input.placeholder = enabled ? t('CodeModeSearchHint') : ' ';
  };

  // ─── lifecycle ──────────────────────────────────────────────────

  onMount(() => {
    void codeSessionRuntime.hydrate().then(refresh);
    const detach = attachRuntimeEvents(rootScope);
    const unsubscribe = codeSessionRuntime.subscribe((groupId) => {
      // A turn that ends while the session is on screen is already read.
      if(groupId === openGroupId()) codeSessionRuntime.markRead(groupId);
      setRuntimeTick((n) => n + 1);
    });

    const onMode = (enabled?: boolean) => {
      if(typeof enabled === 'boolean') active = enabled;
      syncSearchPlaceholder(isActive());
      if(!isActive()) {
        // Leaving Code Mode must not leave a stale session filter behind in a
        // field the rest of the app then uses for real search.
        setQuery('');
        const input = document.querySelector<HTMLInputElement>(SEARCH_HEADER_SELECTOR + ' input.input-search-input');
        if(input) input.value = '';
        return;
      }
      void refresh();
    };

    const onSessionsChanged = (): void => { void refresh(); };

    // The first message NAMES the session (`<10 chars>…`). The composer is the
    // app's own, so the send path is observed rather than called.
    const onMessageSent = ({message}: BroadcastEvents['message_sent']) => {
      // Only outgoing plain messages: a service message never carries a prompt.
      if(!('message' in message) || !message.pFlags.out) return;
      const groupId = codeSessionRuntime.groupIdForPeer(+message.peerId);
      if(!groupId) return;

      codeSessionRuntime.markSent(groupId);
      const text = typeof message.message === 'string' ? message.message : '';
      if(text.trim()) {
        void applyFirstPromptTitle(groupId, text).then((title) => {
          if(title) void refresh();
        });
      }
      setRuntimeTick((n) => n + 1);
    };

    rootScope.addEventListener(CODE_MODE_EVENT, onMode);
    rootScope.addEventListener(CODE_SESSIONS_CHANGED_EVENT, onSessionsChanged);
    rootScope.addEventListener('message_sent', onMessageSent);
    // A new phantom contact must land in the picker without a reload.
    rootScope.addEventListener('dialogs_multiupdate', onSessionsChanged);

    const clock = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    const backstop = setInterval(() => {
      if(isActive()) void refresh();
    }, REFRESH_INTERVAL_MS);

    const closeMenu = () => setMenu(null);
    document.addEventListener('pointerdown', closeMenu);

    attachSearchWidget();
    onMode();

    onCleanup(() => {
      detach();
      unsubscribe();
      detachSearch?.();
      rootScope.removeEventListener(CODE_MODE_EVENT, onMode);
      rootScope.removeEventListener(CODE_SESSIONS_CHANGED_EVENT, onSessionsChanged);
      rootScope.removeEventListener('message_sent', onMessageSent);
      rootScope.removeEventListener('dialogs_multiupdate', onSessionsChanged);
      clearInterval(clock);
      clearInterval(backstop);
      document.removeEventListener('pointerdown', closeMenu);
    });
  });

  // ─── rendering ──────────────────────────────────────────────────

  const badgeOf = (groupId: string): CodeTurnEnd | null =>
    sessionBadge(codeSessionRuntime.get(groupId), now());

  const metaOf = (row: CodeSessionRow) => {
    const rt = codeSessionRuntime.get(row.groupId);
    const elapsed = sessionElapsedLabel(rt, now());
    if(elapsed) return elapsed;
    return formatSessionAge(row.lastActiveAt, now());
  };

  /** A session with no message yet is labelled, not titled. */
  const titleOf = (row: CodeSessionRow): string => row.title || t('CodeModeNewSession');

  const SessionRow = (props: {
    row: CodeSessionRow;
    kind: MenuKind;
    working?: boolean;
  }) => {
    const badge = () => props.working ? null : badgeOf(props.row.groupId);
    return (
      <Show
        when={renaming() === props.row.groupId}
        fallback={
          <div
            class="code-session"
            classList={{
              'code-session--selected': openGroupId() === props.row.groupId,
              'code-session--working': !!props.working,
              'code-session--pending': props.row.pending
            }}
            onContextMenu={(event) => openMenu(event, props.row, props.kind)}
            onClick={() => void openSession(props.row)}
          >
            <img
              class="code-session__avatar"
              src={generateCodeSessionAvatar()}
              alt=""
              draggable={false}
            />
            <div class="code-session__body">
              <div class="code-session__title">{titleOf(props.row)}</div>
            </div>
            <div class="code-session__meta">
              <span class="code-session__age">{metaOf(props.row)}</span>
              <Show when={badge() === 'done'}>
                <span class="code-session__badge code-session__badge--done" title={t('CodeModeDone')} />
              </Show>
              <Show when={badge() === 'interrupted'}>
                <span class="code-session__badge code-session__badge--interrupted" title={t('CodeModeInterrupted')} />
              </Show>
            </div>
          </div>
        }
      >
        <div class="code-session code-session--renaming">
          <input
            class="code-session__rename-input"
            value={renameValue()}
            autofocus
            onInput={(event) => setRenameValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if(event.key === 'Enter') void doRename(props.row.groupId);
              if(event.key === 'Escape') setRenaming(null);
            }}
            onBlur={() => void doRename(props.row.groupId)}
          />
        </div>
      </Show>
    );
  };

  const menuRow = createMemo(() => {
    const state = menu();
    if(!state) return null;
    const all = [...grouped().active, ...grouped().archived, ...grouped().working];
    return {state, row: all.find((row) => row.groupId === state.groupId)};
  });

  return (
    <div class="code-inbox">
      <div class="code-inbox__scroll">
        <For each={filtered().active}>{(row) => <SessionRow row={row} kind="active" />}</For>

        <Show when={filtered().archived.length}>
          <div class="code-inbox__group-title">{i18n('CodeModeArchived')}</div>
          <For each={filtered().archived}>{(row) => <SessionRow row={row} kind="archived" />}</For>
        </Show>

        <Show when={!sessions().length}>
          {/* Same placeholder component the empty chat list uses. */}
          <div class="empty-placeholder empty-placeholder-dialogs visible code-inbox__empty">
            <img class="empty-placeholder-dialogs-icon" src="assets/img/EmptyChats.svg" alt="" />
            <div class="empty-placeholder-header">{i18n('CodeModeEmptySessionsTitle')}</div>
            <div class="empty-placeholder-subtitle">{i18n('CodeModeEmptySessionsHint')}</div>
          </div>
        </Show>

        <div class="code-inbox__spacer" />

        <Show when={filtered().working.length}>
          <div class="code-inbox__group-title code-inbox__group-title--working">
            {i18n('CodeModeWorking')}
          </div>
          <For each={filtered().working}>{(row) => <SessionRow row={row} kind="active" working />}</For>
        </Show>
      </div>

      <Show when={menuRow()}>
        {(resolved) => (
          <div
            class="code-menu"
            style={{left: resolved().state.x + 'px', top: resolved().state.y + 'px'}}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Show when={confirmDelete() === resolved().state.groupId} fallback={
              <>
                <button
                  class="code-menu__item"
                  type="button"
                  onClick={() => {
                    setRenameValue(resolved().row?.title || '');
                    setRenaming(resolved().state.groupId);
                    setMenu(null);
                  }}
                >
                  {i18n('CodeModeRename')}
                </button>
                <Show when={resolved().state.kind === 'archived'} fallback={
                  <button
                    class="code-menu__item"
                    type="button"
                    onClick={() => void doArchive(resolved().state.groupId, true)}
                  >
                    {i18n('CodeModeArchive')}
                  </button>
                }>
                  <button
                    class="code-menu__item"
                    type="button"
                    onClick={() => void doArchive(resolved().state.groupId, false)}
                  >
                    {i18n('CodeModeUnarchive')}
                  </button>
                </Show>
                <button
                  class="code-menu__item code-menu__item--danger"
                  type="button"
                  onClick={() => setConfirmDelete(resolved().state.groupId)}
                >
                  {i18n('CodeModeDelete')}
                </button>
              </>
            }>
              <div class="code-menu__label">{i18n('CodeModeDeleteConfirm')}</div>
              <button
                class="code-menu__item code-menu__item--danger"
                type="button"
                onClick={() => void doDelete(resolved().state.groupId)}
              >
                {i18n('CodeModeDelete')}
              </button>
            </Show>
          </div>
        )}
      </Show>

      <Show when={error()}>
        <div class="code-inbox__error">{error()}</div>
      </Show>
    </div>
  );
}

/**
 * Mount the inbox into the chat list column. Called once, lazily, from the
 * folders sidebar — the CSS keeps it hidden (`body:not(.code-mode)`) so the
 * normal chat list is completely untouched when Code Mode is off.
 */
let mounted = false;

export function mountCodeMode(): void {
  if(mounted) return;
  const container = document.getElementById('chatlist-container');
  if(!container) return;

  mounted = true;
  const element = document.createElement('div');
  element.className = 'code-mode-root';
  container.append(element);

  render(() => (
    <SolidJSHotReloadGuardProvider>
      <CodeInbox />
    </SolidJSHotReloadGuardProvider>
  ), element);
}
