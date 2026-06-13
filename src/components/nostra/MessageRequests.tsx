/**
 * MessageRequests - Solid.js component for message request management
 *
 * Renders at the top of the chat list as a clickable "Richieste" row with
 * a badge count of pending requests. On click, shows individual pending
 * requests with accept/reject buttons.
 *
 * Accept: moves conversation to main chat list via display bridge
 * Reject: blocks the pubkey (future messages ignored)
 */

import {createSignal, createEffect, For, Show, JSX} from 'solid-js';
import rootScope from '@lib/rootScope';
import {getMessageRequestStore, MessageRequest} from '@lib/nostra/message-requests';

/** Logger prefix */
const LOG_PREFIX = '[MessageRequests]';

/**
 * Truncate a string to maxLen chars with ellipsis.
 */
function truncate(s: string, maxLen: number): string {
  if(s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '...';
}

/**
 * Format a Nostr pubkey as a short display name.
 * Shows first 12 chars of the hex pubkey prefixed with "npub:".
 */
function formatPubkey(pubkey: string): string {
  return 'npub:' + pubkey.slice(0, 12);
}

/**
 * Format timestamp to locale date string.
 */
function formatTimestamp(ts: number): string {
  const date = new Date(ts * 1000);
  return date.toLocaleDateString();
}

/**
 * MessageRequestsRow - Collapsed row shown at top of chat list.
 */
export function MessageRequestsRow(props: {
  count: number;
  onClick: () => void;
}): JSX.Element {
  return (
    <Show when={props.count > 0}>
      <div class="message-requests-row" onClick={props.onClick}>
        <div class="message-requests-row__icon">
          <span class="message-requests-row__icon-inner">!</span>
        </div>
        <div class="message-requests-row__text">Richieste</div>
        <div class="message-requests-row__badge">{props.count}</div>
      </div>
    </Show>
  );
}

/**
 * MessageRequestItem - Individual request card with accept/reject.
 */
function MessageRequestItem(props: {
  request: MessageRequest;
  onAccept: (pubkey: string) => void;
  onReject: (pubkey: string) => void;
}): JSX.Element {
  return (
    <div class="message-request-item">
      <div class="message-request-item__avatar">
        <span>{props.request.pubkey.slice(0, 2).toUpperCase()}</span>
      </div>
      <div class="message-request-item__content">
        <div class="message-request-item__sender">
          {formatPubkey(props.request.pubkey)}
        </div>
        <div class="message-request-item__preview">
          {truncate(props.request.firstMessage, 80)}
        </div>
        <div class="message-request-item__timestamp">
          {formatTimestamp(props.request.timestamp)}
        </div>
      </div>
      <div class="message-request-item__actions">
        <button
          class="btn-accept"
          onClick={() => props.onAccept(props.request.pubkey)}
        >
          Accetta
        </button>
        <button
          class="btn-reject"
          onClick={() => props.onReject(props.request.pubkey)}
        >
          Rifiuta
        </button>
      </div>
    </div>
  );
}

/**
 * MessageRequestsList - Full list view of pending requests.
 */
export function MessageRequestsList(props: {
  onBack?: () => void;
}): JSX.Element {
  const [requests, setRequests] = createSignal<MessageRequest[]>([]);
  const store = getMessageRequestStore();

  // Load initial requests
  const loadRequests = async() => {
    try {
      const pending = await store.getRequests();
      setRequests(pending);
    } catch(err) {
      console.error(`${LOG_PREFIX} failed to load requests:`, err);
    }
  };

  // Load on mount
  loadRequests();

  // Listen for new message requests
  createEffect(() => {
    const handler = () => {
      loadRequests();
    };
    rootScope.addEventListener('nostra_message_request', handler);
    return () => {
      rootScope.removeEventListener('nostra_message_request', handler);
    };
  });

  const handleAccept = async(pubkey: string) => {
    try {
      await store.acceptRequest(pubkey);
      console.log(`${LOG_PREFIX} accepted request from:`, pubkey.slice(0, 8) + '...');

      // Trigger synthetic dialog creation via NostraBridge
      try {
        const {NostraBridge} = await import('@lib/nostra/nostra-bridge');
        const bridge = NostraBridge.getInstance();
        const peerId = await bridge.mapPubkeyToPeerId(pubkey);
        rootScope.dispatchEvent('nostra_contact_accepted', {pubkey, peerId});
      } catch(bridgeErr) {
        console.warn(`${LOG_PREFIX} failed to create synthetic dialog:`, bridgeErr);
      }

      // Reload list
      await loadRequests();
    } catch(err) {
      console.error(`${LOG_PREFIX} accept failed:`, err);
    }
  };

  const handleReject = async(pubkey: string) => {
    try {
      await store.rejectRequest(pubkey);
      console.log(`${LOG_PREFIX} rejected request from:`, pubkey.slice(0, 8) + '...');
      // Reload list
      await loadRequests();
    } catch(err) {
      console.error(`${LOG_PREFIX} reject failed:`, err);
    }
  };

  return (
    <div class="message-requests-list">
      <div class="message-requests-list__header">
        <Show when={props.onBack}>
          <button class="message-requests-list__back" onClick={props.onBack}>
            &larr;
          </button>
        </Show>
        <span class="message-requests-list__title">Richieste di messaggi</span>
      </div>
      <Show
        when={requests().length > 0}
        fallback={
          <div class="message-requests-list__empty">
            Nessuna richiesta di messaggi
          </div>
        }
      >
        <For each={requests()}>
          {(request) => (
            <MessageRequestItem
              request={request}
              onAccept={handleAccept}
              onReject={handleReject}
            />
          )}
        </For>
      </Show>
    </div>
  );
}

/**
 * useMessageRequestCount - Hook to get the current pending request count.
 * Reactively updates on nostra_message_request events.
 */
export function useMessageRequestCount(): () => number {
  const [count, setCount] = createSignal(0);
  const store = getMessageRequestStore();

  // Load initial count
  store.getPendingCount().then(setCount).catch(() => {});

  // Listen for updates
  rootScope.addEventListener('nostra_message_request', () => {
    store.getPendingCount().then(setCount).catch(() => {});
  });

  return count;
}
