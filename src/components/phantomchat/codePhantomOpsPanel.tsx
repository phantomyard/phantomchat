/*
 * Code Mode → PhantomOps thread.
 *
 * PhantomOps is the one Code entry that is not a Nostr peer, so it gets its own
 * panel instead of the chat view: paste a PhantomOps API key, then a plain
 * streaming thread against `/api/chat/*`.
 *
 * This is still a THIN client — no local engine, no tools, no filesystem. The
 * phantom on the other side runs whatever harness it likes; all this panel can
 * do is send text, stream the answer back, and approve or deny a gate.
 */
import {createSignal, For, onCleanup, onMount, Show} from 'solid-js';
import {Portal} from 'solid-js/web';
import {i18n} from '@lib/langPack';
import PhantomOpsClient, {PhantomOpsState} from '@lib/phantomchat/code-mode-phantomops';

/** One session per app run: closing the panel must not drop the thread. */
let client: PhantomOpsClient | null = null;

export function getPhantomOpsClient(): PhantomOpsClient {
  if(!client) client = new PhantomOpsClient();
  return client;
}

function CodePhantomOpsPanel(props: {onClose: () => void}) {
  const ops = getPhantomOpsClient();
  const [state, setState] = createSignal<PhantomOpsState>(ops.state);
  const [draft, setDraft] = createSignal('');
  const [apiToken, setApiToken] = createSignal('');
  const [secretValue, setSecretValue] = createSignal('');
  const [connecting, setConnecting] = createSignal(false);

  let listEl: HTMLDivElement | undefined;
  let inputEl: HTMLTextAreaElement | undefined;

  const scrollToEnd = () => {
    if(!listEl) return;
    listEl.scrollTop = listEl.scrollHeight;
  };

  const connect = async() => {
    const token = apiToken().trim();
    if(!token) return;
    setConnecting(true);
    try {
      await ops.connect(token);
      // the key is a secret: never keep it in component state after it works
      setApiToken('');
    } catch{
      // `connect` already put a readable reason in state.error
    } finally {
      setConnecting(false);
    }
  };

  const submit = () => {
    const text = draft().trim();
    if(!text || state().busy) return;
    setDraft('');
    void ops.send(text);
  };

  onMount(() => {
    const unsubscribe = ops.subscribe((next) => {
      setState(next);
      queueMicrotask(scrollToEnd);
    });

    if(ops.isSignedIn()) void ops.loadHistory().catch(() => {});
    queueMicrotask(scrollToEnd);
    inputEl?.focus();

    onCleanup(unsubscribe);
  });

  return (
    <Portal mount={document.body}>
      <div class="code-ops">
        <div class="code-ops__topbar">
          <button class="code-ops__back" type="button" onClick={props.onClose} title={i18n('CodeModeBack').textContent}>
            ←
          </button>
          <div class="code-ops__title">
            <span class="code-ops__name">{i18n('CodeModePhantomOps')}</span>
            <Show when={state().signedIn}>
              <span class="code-ops__status">{state().activity || i18n('CodeModeConnected')}</span>
              <span class="code-ops__key" title={i18n('CodeModePhantomOps').textContent}>{ops.tokenHint()}</span>
            </Show>
          </div>
          <Show when={state().signedIn}>
            <button
              class="code-ops__signout"
              type="button"
              onClick={() => void ops.logout()}
            >
              {i18n('CodeModeDisconnect')}
            </button>
          </Show>
        </div>

        <Show when={state().error}>
          <div class="code-ops__error">{state().error}</div>
        </Show>

        <Show
          when={state().signedIn}
          fallback={(
            <div class="code-ops__signin">
              <div class="code-ops__signin-title">{i18n('CodeModePhantomOps')}</div>
              <div class="code-ops__signin-hint">{i18n('CodeModePhantomOpsSignInHint')}</div>
              <input
                class="code-ops__keyinput"
                type="password"
                autocomplete="off"
                spellcheck={false}
                placeholder="pok_…"
                value={apiToken()}
                onInput={(e) => setApiToken(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if(e.key === 'Enter') {
                    e.preventDefault();
                    void connect();
                  }
                }}
              />
              <button
                class="code-ops__signin-btn"
                type="button"
                disabled={connecting() || !apiToken().trim()}
                onClick={() => void connect()}
              >
                {connecting() ? i18n('CodeModeConnecting') : i18n('CodeModeConnect')}
              </button>
            </div>
          )}
        >
          <div class="code-ops__list" ref={listEl}>
            <For each={state().messages}>{(message) => (
              <div class={`code-ops__bubble code-ops__bubble--${message.role}`}>
                {message.text}
              </div>
            )}</For>
            <Show when={state().busy && !state().messages.length}>
              <div class="code-ops__bubble code-ops__bubble--assistant">{state().activity}</div>
            </Show>
          </div>

          <Show when={state().gate}>
            {(gate) => (
              <div class="code-ops__gate">
                <Show
                  when={gate().kind === 'secret'}
                  fallback={(
                    <>
                      <div class="code-ops__gate-title">{gate().tool}</div>
                      <div class="code-ops__gate-summary">{gate().summary || gate().rationale}</div>
                      <div class="code-ops__gate-actions">
                        <button type="button" onClick={() => void ops.confirmGate('approve')}>{i18n('CodeModeApprove')}</button>
                        <button type="button" onClick={() => void ops.confirmGate('deny')}>{i18n('CodeModeDeny')}</button>
                      </div>
                    </>
                  )}
                >
                  <div class="code-ops__gate-title">{i18n('CodeModeSecretNeeded')} {gate().name}</div>
                  <Show when={gate().rationale}>
                    <div class="code-ops__gate-summary">{gate().rationale}</div>
                  </Show>
                  <input
                    class="code-ops__keyinput"
                    type="password"
                    autocomplete="off"
                    value={secretValue()}
                    onInput={(e) => setSecretValue(e.currentTarget.value)}
                  />
                  <div class="code-ops__gate-actions">
                    <button
                      type="button"
                      disabled={!secretValue().trim()}
                      onClick={() => {
                        const value = secretValue();
                        setSecretValue('');
                        void ops.answerSecret(value);
                      }}
                    >
                      {i18n('CodeModeSubmit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSecretValue('');
                        void ops.answerSecret(null);
                      }}
                    >
                      {i18n('CodeModeDeny')}
                    </button>
                  </div>
                </Show>
              </div>
            )}
          </Show>

          <div class="code-ops__composer">
            <textarea
              ref={inputEl}
              class="code-ops__input"
              rows={2}
              placeholder={i18n('CodeModeComposerHint').textContent}
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if(e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <Show
              when={!state().busy}
              fallback={(
                <button class="code-ops__send code-ops__send--stop" type="button" onClick={() => void ops.stop()}>
                  {i18n('CodeModeStop')}
                </button>
              )}
            >
              <button class="code-ops__send" type="button" onClick={submit}>↑</button>
            </Show>
          </div>
        </Show>
      </div>
    </Portal>
  );
}

export default CodePhantomOpsPanel;
