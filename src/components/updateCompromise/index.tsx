import {createSignal, Show} from 'solid-js';
import {render} from 'solid-js/web';
import type {CompromiseReason} from '@lib/update/types';
import I18n from '@lib/langPack';
import {BUILD_VERSION} from '@lib/update/build-version';
import styles from './index.module.scss';

const GITHUB_URL = 'https://github.com/nostra-chat/nostra-chat';

const UPDATE_LS_KEYS = [
  'nostra.update.installedVersion',
  'nostra.update.installedSwUrl',
  'nostra.update.lastAcceptedVersion',
  'nostra.update.lastIntegrityCheck',
  'nostra.update.lastIntegrityResult',
  'nostra.update.lastIntegrityDetails',
  'nostra.update.pendingFinalization',
  'nostra.update.pendingManifest'
];

function CompromiseAlertView(props: {reason: CompromiseReason}) {
  const [expanded, setExpanded] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [copyStatus, setCopyStatus] = createSignal<'' | 'ok' | 'fail'>('');
  const onClose = () => {
    try { window.close(); } catch{}
    window.location.href = 'about:blank';
  };
  const onResetBaseline = () => {
    if(!confirming()) { setConfirming(true); return; }
    for(const k of UPDATE_LS_KEYS) localStorage.removeItem(k);
    window.location.reload();
  };
  const onCopyDiagnostics = async() => {
    const payload = {
      buildVersion: BUILD_VERSION,
      installedVersion: localStorage.getItem('nostra.update.installedVersion'),
      installedSwUrl: localStorage.getItem('nostra.update.installedSwUrl'),
      lastIntegrityResult: localStorage.getItem('nostra.update.lastIntegrityResult'),
      reason: props.reason,
      userAgent: navigator.userAgent,
      timestamp: new Date().toISOString()
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopyStatus('ok');
    } catch{
      setCopyStatus('fail');
    }
    setTimeout(() => setCopyStatus(''), 2500);
  };
  return (
    <div class={styles.overlay} role="alertdialog" aria-live="assertive">
      <div class={styles.content}>
        <div class={styles.icon}>\u26a0\ufe0f</div>
        <h1 class={styles.title}>{I18n.format('Update.Compromise.Title', true)}</h1>
        <p class={styles.body}>{I18n.format('Update.Compromise.Body', true)}</p>
        <div class={styles.details}>
          <div class={styles.detailsToggle} onClick={() => setExpanded(!expanded())}>
            {expanded() ? '\u25be' : '\u25b8'} {I18n.format(expanded() ? 'Update.Compromise.HideDetails' : 'Update.Compromise.ShowDetails', true)}
          </div>
          <Show when={expanded()}>
            <pre class={styles.detailsContent}>{JSON.stringify(props.reason, null, 2)}</pre>
          </Show>
        </div>
        <ul class={styles.todoList}>
          <li>{I18n.format('Update.Compromise.Todo1', true)}</li>
          <li>
            {I18n.format('Update.Compromise.Todo2', true)}
            {' — '}
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">{GITHUB_URL}</a>
          </li>
          <li>{I18n.format('Update.Compromise.Todo3', true)}</li>
        </ul>
        <button class={styles.copyButton} onClick={onCopyDiagnostics}>
          {copyStatus() === 'ok' ?
            I18n.format('Update.Compromise.DiagnosticsCopied', true) :
            copyStatus() === 'fail' ?
              I18n.format('Update.Compromise.DiagnosticsCopyFailed', true) :
              I18n.format('Update.Compromise.CopyDiagnostics', true)}
        </button>
        <button class={styles.closeButton} onClick={onClose} ref={(el) => setTimeout(() => el?.focus(), 0)}>
          {I18n.format('Update.Compromise.CloseButton', true)}
        </button>
        <div class={styles.recovery}>
          <div class={styles.recoveryNote}>{I18n.format('Update.Compromise.Recovery.Note', true)}</div>
          <button class={styles.resetButton} onClick={onResetBaseline}>
            {I18n.format(confirming() ? 'Update.Compromise.Recovery.ConfirmButton' : 'Update.Compromise.Recovery.Button', true)}
          </button>
        </div>
      </div>
    </div>
  );
}

export function mountCompromiseAlert(reason: CompromiseReason): void {
  document.body.innerHTML = '';
  render(() => <CompromiseAlertView reason={reason} />, document.body);
}
