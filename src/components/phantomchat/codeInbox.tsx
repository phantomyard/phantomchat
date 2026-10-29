/*
 * Code Mode inbox.
 *
 * The Code rail entry parks the chat list here: an OpenCode-style inbox of
 * phantoms. Nothing about the chat path changes — a phantom is a contact, so
 * clicking a row opens the ordinary PhantomChat view (`setInnerPeer`), with the
 * ordinary composer, streaming and delivery state.
 *
 * The list itself is derived, never stored:
 *
 *   peer mappings (who is a phantom)  ×  cached dialogs (unread, last activity)
 *
 * so adding an npub from the existing Add Contact popup IS "installing a
 * model", and removing the contact removes the row. `buildCodeModeInbox` in
 * `lib/code-mode` does that merge; this file only renders it.
 *
 * PhantomOps is the one row that is not a Nostr peer, and it renders in its own
 * panel (see codePhantomOpsPanel.tsx).
 */
import {createSignal, For, onCleanup, onMount, Show} from 'solid-js';
import {render} from 'solid-js/web';
import {i18n} from '@lib/langPack';
import {AvatarNewTsx} from '@components/avatarNew';
import {useHotReloadGuard} from '@lib/solidjs/hotReloadGuard';
import SolidJSHotReloadGuardProvider from '@lib/solidjs/hotReloadGuardProvider';
import {getAllMappings} from '@lib/phantomchat/virtual-peers-db';
import {showAddContactPopup} from '@components/popups/addContact';
import {
  CODE_MODE_BODY_CLASS,
  CODE_MODE_EVENT,
  CodeModeEntry,
  buildCodeModeInbox,
  formatCodeModeAge
} from '@lib/code-mode';
import CodePhantomOpsPanel from './codePhantomOpsPanel';

/** Re-read the mapping store + dialog cache while the inbox is on screen. */
const REFRESH_INTERVAL_MS = 10_000;

/** Coalesce the chat-list fan-out into one re-read. */
const REFRESH_DEBOUNCE_MS = 400;

interface CodeRow extends CodeModeEntry {
  title: string;
}

function CodeInbox() {
  const {rootScope, appImManager} = useHotReloadGuard();
  const managers = rootScope.managers;

  const [rows, setRows] = createSignal<CodeRow[]>([]);
  const [loaded, setLoaded] = createSignal(false);
  const [opsOpen, setOpsOpen] = createSignal(false);

  const openAddContact = () => {
    showAddContactPopup({
      managers,
      onContactAdded: () => void refresh()
    });
  };

  /**
   * Is the mode actually on screen? The body class IS the mode (nothing else
   * reads it), so it is the cheapest honest answer. A mounted inbox that keeps
   * re-reading the mapping store and the dialog cache for a list nobody is
   * looking at is a poll that outlives its purpose.
   */
  // The body class is the mode, but it is applied by an effect that can land a
  // tick after CODE_MODE_EVENT, so the event's own payload is the earlier
  // truth. Either one saying "on" is enough to keep the list live.
  let active = document.body.classList.contains(CODE_MODE_BODY_CLASS);
  const isActive = (): boolean => active || document.body.classList.contains(CODE_MODE_BODY_CLASS);

  const refresh = async() => {
    if(!isActive()) return;
    try {
      const [mappings, dialogs] = await Promise.all([
        getAllMappings(),
        managers.dialogsStorage.getCachedDialogs(true) as Promise<any[]>
      ]);

      const entries = buildCodeModeInbox(
        mappings.map((m) => ({pubkey: m.pubkey, peerId: m.peerId, displayName: m.displayName, addedAt: m.addedAt})),
        dialogs.map((d) => ({
          peerId: +(d.peerId as unknown as number),
          sortIndex: d['index_0'],
          unread: d.unread_count
        })),
        {excludePubkeys: [(window as any).__phantomchatOwnPubkey].filter(Boolean)}
      );

      // The live tweb user record is authoritative for the display name (kind 0
      // upgrades, manual renames) — the mapping only carries what it last saw.
      const titled: CodeRow[] = await Promise.all(entries.map(async(entry) => {
        const user = await managers.appUsersManager.getUser(entry.peerId);
        const fullName = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') : '';
        return {...entry, title: fullName || entry.title};
      }));

      setRows(titled);
    } catch{
      setRows([]);
    } finally {
      setLoaded(true);
    }
  };

  const openPeer = (peerId: number) => {
    setOpsOpen(false);
    void appImManager.setInnerPeer({peerId: peerId.toPeerId(false)});
  };

  onMount(() => {
    /**
     * A freshly added phantom has to show up immediately, so the list also
     * reacts to the chat-list fan-out (`dialogs_multiupdate`) — coalesced,
     * because it fires per message. The interval is the backstop for anything
     * that changes the mapping store without a dialog update, and it only runs
     * while the mode is on.
     */
    let pending: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;

    const scheduleRefresh = (): void => {
      if(pending || !isActive()) return;
      pending = setTimeout(() => {
        pending = undefined;
        void refresh();
      }, REFRESH_DEBOUNCE_MS);
    };

    const stopPolling = (): void => {
      if(!interval) return;
      clearInterval(interval);
      interval = undefined;
      if(pending) clearTimeout(pending);
      pending = undefined;
    };

    const startPolling = (): void => {
      if(interval) return;
      interval = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    };

    const onMode = (enabled?: boolean): void => {
      if(typeof enabled === 'boolean') active = enabled;
      if(!isActive()) {
        stopPolling();
        return;
      }

      startPolling();
      void refresh();
    };

    rootScope.addEventListener(CODE_MODE_EVENT, onMode);
    rootScope.addEventListener('dialogs_multiupdate', scheduleRefresh);
    // The mount is triggered by entering the mode, but the module import may
    // resolve after the switch, so cover both orders.
    onMode();

    onCleanup(() => {
      rootScope.removeEventListener(CODE_MODE_EVENT, onMode);
      rootScope.removeEventListener('dialogs_multiupdate', scheduleRefresh);
      stopPolling();
    });
  });

  const age = (row: CodeRow) => formatCodeModeAge(row.lastActivity, Math.floor(Date.now() / 1000));

  return (
    <div class="code-inbox">
      <div class="code-inbox__header">
        <span class="code-inbox__title">{i18n('CodeMode')}</span>
        <button
          class="code-inbox__add"
          type="button"
          onClick={openAddContact}
        >
          +
        </button>
      </div>

      <div class="code-inbox__list">
        <div
          class="code-row code-row--ops"
          onClick={() => setOpsOpen(true)}
        >
          <div class="code-row__avatar code-row__avatar--ops">◈</div>
          <div class="code-row__body">
            <div class="code-row__title">{i18n('CodeModePhantomOps')}</div>
            <div class="code-row__subtitle">{i18n('CodeModePhantomOpsHint')}</div>
          </div>
        </div>

        <For each={rows()}>{(row) => (
          <div class="code-row" onClick={() => openPeer(row.peerId)}>
            <AvatarNewTsx peerId={row.peerId.toPeerId(false)} size={48} />
            <div class="code-row__body">
              <div class="code-row__title">{row.title}</div>
              <div class="code-row__subtitle">{row.pubkey.slice(0, 12)}…</div>
            </div>
            <div class="code-row__meta">
              <span class="code-row__age">{age(row)}</span>
              <Show when={row.unread > 0}>
                <span class="code-row__unread">{row.unread}</span>
              </Show>
            </div>
          </div>
        )}</For>

        <Show when={loaded() && !rows().length}>
          <div class="code-inbox__empty">
            <div class="code-inbox__empty-title">{i18n('CodeModeEmptyTitle')}</div>
            <div class="code-inbox__empty-hint">{i18n('CodeModeEmptyHint')}</div>
            <button class="code-inbox__empty-btn" type="button" onClick={openAddContact}>
              {i18n('CodeModeAddPhantom')}
            </button>
          </div>
        </Show>
      </div>

      <Show when={opsOpen()}>
        <CodePhantomOpsPanel onClose={() => setOpsOpen(false)} />
      </Show>
    </div>
  );
}

export default CodeInbox;

let mounted = false;

/**
 * Mount the inbox into the chat list column. Called once, lazily, from the
 * folders sidebar — the CSS keeps it hidden (`body:not(.code-mode)`) so the
 * normal chat list is completely untouched when Code Mode is off.
 */
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
