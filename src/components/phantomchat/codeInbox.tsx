/*
 * Code Mode — the session-first coding inbox (#279).
 *
 * Left column = SESSIONS (not phantoms):
 *
 *   [ Search sessions ]      [ New session ]
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
import {getAllMappings} from '@lib/phantomchat/virtual-peers-db';
import {showAddContactPopup} from '@components/popups/addContact';
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
  createSession,
  deleteSessionEverywhere,
  listSessions,
  renameSession,
  sessionPeerId,
  setSessionArchived,
  switchSessionPeer
} from '@lib/phantomchat/code-session-service';
import {codeSessionRuntime, attachRuntimeEvents} from '@lib/phantomchat/code-session-runtime';

/** Backstop re-read for anything that changes sessions without an event. */
const REFRESH_INTERVAL_MS = 15_000;

/** How often the Working counter ticks. */
const CLOCK_INTERVAL_MS = 1000;

interface PhantomOption {
  pubkey: string;
  peerId: number;
  title: string;
}

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
  const managers = rootScope.managers;

  const [sessions, setSessions] = createSignal<CodeSessionInput[]>([]);
  const [runtimeTick, setRuntimeTick] = createSignal(0);
  const [query, setQuery] = createSignal('');
  const [openGroupId, setOpenGroupId] = createSignal<string | null>(null);
  const [newSessionOpen, setNewSessionOpen] = createSignal(false);
  const [newPrompt, setNewPrompt] = createSignal('');
  const [newPeer, setNewPeer] = createSignal('');
  const [phantoms, setPhantoms] = createSignal<PhantomOption[]>([]);
  const [menu, setMenu] = createSignal<MenuState | null>(null);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal('');
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  /** Phantom of the open session, so the switcher can show it. */
  const [openPeerPubkey, setOpenPeerPubkey] = createSignal('');

  createEffect(() => {
    const groupId = openGroupId();
    if(!groupId) {
      setOpenPeerPubkey('');
      return;
    }
    void import('@lib/phantomchat/group-store').then(async({getGroupStore}) => {
      const group = await getGroupStore().get(groupId);
      const own = (window as any).__phantomchatOwnPubkey || '';
      setOpenPeerPubkey((group?.members || []).find((member) => member !== own) || '');
    }).catch(() => setOpenPeerPubkey(''));
  });

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
        title: record.title,
        archived: record.archived,
        createdAt: record.createdAt,
        // A session exists in the rail only once its first prompt landed. The
        // record is created by that send, so a record IS a prompted session.
        hasPrompt: true
      })));

      codeSessionRuntime.setSessionPeers(await Promise.all(records.map(async(record) => ({
        groupId: record.groupId,
        peerId: await sessionPeerId(record.groupId)
      }))));

      setRuntimeTick((n) => n + 1);
    } catch(err) {
      console.warn('[CodeMode] refresh failed', err);
      setSessions([]);
    }
  };

  /** Phantom contacts available as a session peer. */
  const loadPhantoms = async() => {
    try {
      const own = (window as any).__phantomchatOwnPubkey || '';
      const mappings = await getAllMappings();
      const options = await Promise.all(mappings
      .filter((m) => m.pubkey && m.pubkey !== own)
      .map(async(mapping): Promise<PhantomOption> => {
        let title = mapping.displayName || '';
        try {
          const user = await managers.appUsersManager.getUser(mapping.peerId);
          const fullName = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') : '';
          title = fullName || title;
        } catch{ /* fall back to the stored display name */ }
        return {pubkey: mapping.pubkey, peerId: mapping.peerId, title: title || mapping.pubkey.slice(0, 8)};
      }));

      options.sort((a, b) => a.title.localeCompare(b.title));
      setPhantoms(options);
    } catch(err) {
      console.warn('[CodeMode] loadPhantoms failed', err);
      setPhantoms([]);
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
    setNewSessionOpen(false);
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

  const startNewSession = () => {
    setMenu(null);
    setRenaming(null);
    setConfirmDelete(null);
    setError(null);
    setOpenGroupId(null);
    setNewSessionOpen(true);
    setNewPrompt('');
    void loadPhantoms().then(() => {
      const first = phantoms()[0];
      if(first && !newPeer()) setNewPeer(first.pubkey);
    });
  };

  const submitNewSession = async() => {
    const text = newPrompt().trim();
    const pubkey = newPeer();
    if(!text || !pubkey || busy()) return;

    setBusy(true);
    setError(null);
    try {
      const created = await createSession(pubkey, text);
      codeSessionRuntime.markSent(created.groupId);
      setRuntimeTick((n) => n + 1);
      setNewSessionOpen(false);
      setNewPrompt('');
      setOpenGroupId(created.groupId);

      await appImManager.setInnerPeer({peerId: created.peerId.toPeerId(true)});
      // Send the first prompt through the ordinary send path so the phantom
      // sees exactly what any other chat send produces.
      await managers.appMessagesManager.sendText({peerId: created.peerId.toPeerId(true), text});
      void refresh();
    } catch(err) {
      console.warn('[CodeMode] create session failed', err);
      setError('Could not start the session.');
    } finally {
      setBusy(false);
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

  // ─── lifecycle ──────────────────────────────────────────────────

  onMount(() => {
    void codeSessionRuntime.hydrate().then(refresh);
    const detach = attachRuntimeEvents(rootScope);
    const unsubscribe = codeSessionRuntime.subscribe(() => setRuntimeTick((n) => n + 1));

    const onMode = (enabled?: boolean) => {
      if(typeof enabled === 'boolean') active = enabled;
      if(!isActive()) return;
      void refresh();
    };

    const onSessionsChanged = (): void => { void refresh(); };

    rootScope.addEventListener(CODE_MODE_EVENT, onMode);
    rootScope.addEventListener(CODE_SESSIONS_CHANGED_EVENT as any, onSessionsChanged);
    // A new phantom contact must land in the picker without a reload.
    rootScope.addEventListener('dialogs_multiupdate', onSessionsChanged);

    const clock = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    const backstop = setInterval(() => {
      if(isActive()) void refresh();
    }, REFRESH_INTERVAL_MS);

    const closeMenu = () => setMenu(null);
    document.addEventListener('pointerdown', closeMenu);

    onMode();
    void loadPhantoms();

    onCleanup(() => {
      detach();
      unsubscribe();
      rootScope.removeEventListener(CODE_MODE_EVENT, onMode);
      rootScope.removeEventListener(CODE_SESSIONS_CHANGED_EVENT as any, onSessionsChanged);
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
              'code-session--working': !!props.working
            }}
            onContextMenu={(event) => openMenu(event, props.row, props.kind)}
            onClick={() => void openSession(props.row)}
          >
            <div class="code-session__body">
              <div class="code-session__title">{props.row.title}</div>
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
      <div class="code-inbox__top">
        <input
          class="code-inbox__search"
          type="search"
          placeholder={t('CodeModeSearchSessions')}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <button class="code-inbox__new" type="button" onClick={startNewSession}>
          {i18n('CodeModeNewSession')}
        </button>
      </div>

      <div class="code-inbox__scroll">
        <For each={filtered().active}>{(row) => <SessionRow row={row} kind="active" />}</For>

        <Show when={filtered().archived.length}>
          <div class="code-inbox__group-title">{i18n('CodeModeArchived')}</div>
          <For each={filtered().archived}>{(row) => <SessionRow row={row} kind="archived" />}</For>
        </Show>

        <Show when={!sessions().length}>
          <div class="code-inbox__empty">
            <div class="code-inbox__empty-title">{i18n('CodeModeEmptySessionsTitle')}</div>
            <div class="code-inbox__empty-hint">{i18n('CodeModeEmptySessionsHint')}</div>
            <button class="code-inbox__empty-btn" type="button" onClick={startNewSession}>
              {i18n('CodeModeNewSession')}
            </button>
            <button
              class="code-inbox__empty-btn code-inbox__empty-btn--ghost"
              type="button"
              onClick={() => showAddContactPopup({managers, onContactAdded: () => void loadPhantoms()})}
            >
              {i18n('CodeModeAddPhantom')}
            </button>
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

      <Show when={newSessionOpen()}>
        <div class="code-new">
          <div class="code-new__card">
            <textarea
              class="code-new__prompt"
              placeholder={t('CodeModeComposerHint')}
              value={newPrompt()}
              rows={4}
              onInput={(event) => setNewPrompt(event.currentTarget.value)}
              onKeyDown={(event) => {
                if(event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void submitNewSession();
                }
              }}
            />
            <div class="code-new__actions">
              <select
                class="code-new__peer"
                value={newPeer()}
                onChange={(event) => setNewPeer(event.currentTarget.value)}
              >
                <Show when={!phantoms().length}>
                  <option value="">{i18n('CodeModeNoPhantoms')}</option>
                </Show>
                <For each={phantoms()}>{(phantom) => (
                  <option value={phantom.pubkey}>{phantom.title}</option>
                )}</For>
              </select>
              <div class="code-new__buttons">
                <button
                  class="code-new__cancel"
                  type="button"
                  onClick={() => setNewSessionOpen(false)}
                >
                  {i18n('CodeModeCancel')}
                </button>
                <button
                  class="code-new__send"
                  type="button"
                  disabled={busy() || !newPrompt().trim() || !newPeer()}
                  onClick={() => void submitNewSession()}
                >
                  {i18n('CodeModeSend')}
                </button>
              </div>
            </div>
            <Show when={error()}>
              <div class="code-new__error">{error()}</div>
            </Show>
          </div>
        </div>
      </Show>

      {/*
        * Switching the phantom of an OPEN session (Andrew: "switchable mid
        * session"). Kept next to the composer of a live session rather than in
        * the context menu, because it only makes sense while one is open.
        */}
      <Show when={openGroupId() && phantoms().length > 1}>
        <div class="code-inbox__peer-switch">
          <select
            class="code-inbox__peer-select"
            value={phantoms().find((p) => p.pubkey === openPeerPubkey())?.pubkey || ''}
            onChange={(event) => {
              const groupId = openGroupId();
              const pubkey = event.currentTarget.value;
              if(!groupId || !pubkey) return;
              void switchSessionPeer(groupId, pubkey).then(() => {
                void refresh();
                void openSession({groupId});
              });
            }}
          >
            <option value="">{i18n('CodeModeSwitchPhantom')}</option>
            <For each={phantoms()}>{(phantom) => (
              <option value={phantom.pubkey}>{phantom.title}</option>
            )}</For>
          </select>
        </div>
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
