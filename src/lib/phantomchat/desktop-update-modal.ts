/*
 * PhantomChat desktop — "New Update Notification" modal.
 *
 * The 24h check already exists (electron/updater.ts, #164); this is the
 * user-facing half: when main says an update is actionable (`notifyPending`,
 * decided in electron/updateNotify.ts) the app raises one modal offering
 *
 *   Update now      → the SAME action the Updates tab's button performs
 *                     (restart-and-install once downloaded, otherwise open the
 *                     download page) — one update path, not two,
 *   Remind me later  → silence for 24h, then ask again.
 *
 * Deliberately the smallest thing that works:
 *   - it follows main's pushed state rather than polling, so the launch check,
 *     the 24h timer and a manual "Check now" all reach it the same way;
 *   - the snooze lives in update-settings.json (main), so quitting and
 *     relaunching inside the window does not pop it again;
 *   - it mounts only when the bridge can snooze AND dismiss. An older packaged
 *     build has the update API but not those methods, and a modal there could
 *     not be answered — it would simply reappear on the next state push.
 *
 * Both rings (Stable and Preview) are notified, each about its own feed: the
 * caller's request was explicit that Preview users are told too.
 */
import {
  getDesktopApi,
  hasDesktopUpdateApi,
  hasDesktopUpdateNotificationApi,
  type PhantomChatDesktopApi,
  type UpdateState
} from './desktop-api';
import {describeUpdateNotification, type UpdateNotificationCopy} from './desktop-update-view';

export const UPDATE_NOTIFICATION_CLASS = 'phantomchat-update-notification';

export interface UpdateNotificationDeps {
  /** Injected for tests; defaults to the real preload bridge. */
  api?: PhantomChatDesktopApi | null;
  /** Injected for tests; defaults to the page's document. */
  doc?: Document;
}

/**
 * Build the overlay. Kept separate from the subscription so the DOM contract
 * (what the user sees and which action each button fires) is testable without
 * an Electron runtime or any timers.
 */
export function buildUpdateNotification(
  doc: Document,
  copy: UpdateNotificationCopy,
  handlers: {onUpdate: () => void, onRemind: () => void}
): HTMLElement {
  const overlay = doc.createElement('div');
  overlay.className = UPDATE_NOTIFICATION_CLASS;
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:1000;' +
    'display:flex;align-items:center;justify-content:center;padding:16px;';

  const dialog = doc.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.style.cssText = 'background:#000;border:1px solid rgba(255,255,255,.12);border-radius:16px;' +
    'padding:28px 24px;width:380px;max-width:92vw;max-height:90vh;overflow-y:auto;' +
    'box-shadow:0 20px 60px rgba(0,0,0,.6);text-align:center;';

  const title = doc.createElement('h3');
  title.textContent = copy.title;
  title.id = `${UPDATE_NOTIFICATION_CLASS}-title`;
  title.style.cssText = 'margin:0 0 8px;font-size:19px;font-weight:600;color:#fff;';
  dialog.setAttribute('aria-labelledby', title.id);

  const body = doc.createElement('p');
  body.textContent = copy.body;
  body.style.cssText = 'margin:0 0 22px;font-size:14px;line-height:1.5;color:rgba(255,255,255,.6);';

  const btnRow = doc.createElement('div');
  btnRow.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

  const updateBtn = doc.createElement('button');
  updateBtn.type = 'button';
  updateBtn.textContent = copy.updateLabel;
  updateBtn.classList.add('btn-primary', 'btn-color-primary');
  updateBtn.style.cssText = 'width:100%;padding:13px 16px;border:none;border-radius:10px;cursor:pointer;' +
    'font-size:15px;font-weight:600;font-family:inherit;color:#fff;' +
    'background:var(--primary-color, #1f9bdf);';

  const remindBtn = doc.createElement('button');
  remindBtn.type = 'button';
  remindBtn.textContent = copy.remindLabel;
  remindBtn.style.cssText = 'width:100%;padding:13px 16px;border:none;border-radius:10px;cursor:pointer;' +
    'font-size:14px;font-weight:500;font-family:inherit;background:transparent;color:rgba(255,255,255,.6);';

  updateBtn.addEventListener('click', () => handlers.onUpdate());
  remindBtn.addEventListener('click', () => handlers.onRemind());

  btnRow.append(updateBtn, remindBtn);
  dialog.append(title, body, btnRow);
  overlay.append(dialog);

  return overlay;
}

/**
 * Subscribe to the main process's update state and raise/dismiss the modal.
 * Returns an unsubscribe function (which also removes the modal); a no-op on
 * the PWA and on desktop builds too old to answer the modal.
 */
export function mountUpdateNotification(deps: UpdateNotificationDeps = {}): () => void {
  const doc = deps.doc ?? document;
  const api = deps.api ?? (
    hasDesktopUpdateApi() && hasDesktopUpdateNotificationApi() ? getDesktopApi() : null
  );
  if(!api) return () => {};

  let overlay: HTMLElement | null = null;
  /** state key of the modal on screen, so a re-push does not rebuild it. */
  let shownKey: string | null = null;
  let detachKeys: (() => void) | null = null;
  let disposed = false;

  const remove = () => {
    overlay?.remove();
    overlay = null;
    shownKey = null;
    detachKeys?.();
    detachKeys = null;
  };

  const answer = (action: 'update' | 'remind') => {
    // Close first: both actions are fire-and-forget from the user's point of
    // view, and main immediately pushes `notifyPending: false` back.
    remove();
    const call = action === 'update' ?
      () => api.installUpdate().then(() => api.dismissUpdateNotification?.()) :
      () => api.remindLaterUpdate?.();
    Promise.resolve()
    .then(call)
    .catch(() => {
      // Best effort: the Updates tab in Settings still shows the update and
      // the next check will offer it again.
    });
  };

  const render = (state: UpdateState) => {
    if(disposed) return;
    const copy = state.notifyPending === true ? describeUpdateNotification(state) : null;
    if(!copy) {
      remove();
      return;
    }
    const key = `${state.status}:${state.availableVersion}`;
    if(overlay && shownKey === key) return;

    remove();
    shownKey = key;
    overlay = buildUpdateNotification(doc, copy, {
      onUpdate: () => answer('update'),
      onRemind: () => answer('remind')
    });
    // Escape is the quiet answer, never "update": a stray key must not
    // restart the app. Backdrop clicks do nothing at all.
    const onKeydown = (event: KeyboardEvent) => {
      if(event.key !== 'Escape') return;
      answer('remind');
    };
    detachKeys = () => doc.removeEventListener('keydown', onKeydown);
    doc.addEventListener('keydown', onKeydown);
    doc.body.append(overlay);
  };

  const unsubscribe = api.onUpdateState(render);
  Promise.resolve(api.getUpdateState()).then(render).catch(() => {});

  return () => {
    disposed = true;
    remove();
    unsubscribe?.();
  };
}
