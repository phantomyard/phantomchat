import type {AppManagers} from '@lib/managers';
import App from '@config/app';

const NOSTRA_DEV_NPUB = 'npub1zxn3hul7dsaex9l5a8l8scflxzruxh3v9gvvvgcmtdus7aqenmrskmtyqz';
const GITHUB_ISSUE_URL = 'https://github.com/nostra-chat/nostra-chat/issues/new';

function collectDiagnostics(includeNpub: boolean): string {
  const lines: string[] = [];
  lines.push(`App: ${App.versionFull || App.version || 'dev'}`);
  lines.push(`UA: ${navigator.userAgent}`);
  lines.push(`Platform: ${navigator.platform || 'unknown'}`);
  lines.push(`Lang: ${navigator.language}`);
  lines.push(`Viewport: ${window.innerWidth}x${window.innerHeight}`);
  try {
    const pool = (window as any).__nostraPool;
    const relays = pool?.getConnectedRelays?.() || pool?.relays || [];
    const count = Array.isArray(relays) ? relays.length : (relays?.size ?? 0);
    lines.push(`Connected relays: ${count}`);
  } catch{}
  try {
    const t = (window as any).__nostraPrivacyTransport;
    if(t) lines.push(`Privacy: ${t.getState?.() || 'unknown'}`);
  } catch{}
  if(includeNpub) {
    try {
      const id = localStorage.getItem('nostra_identity');
      if(id) {
        const parsed = JSON.parse(id);
        if(parsed?.npub) lines.push(`Reporter npub: ${parsed.npub}`);
      }
    } catch{}
  }
  return lines.join('\n');
}

function buildIssueBody(title: string, description: string, diagnostics: string): string {
  return [
    '### Description',
    description || '_(no description)_',
    '',
    '### Diagnostics',
    '```',
    diagnostics,
    '```',
    '',
    '---',
    '_Reported from nostra.chat in-app bug reporter._'
  ].join('\n');
}

function buildPrivateMessage(title: string, description: string, diagnostics: string): string {
  return [
    '🐛 Bug Report',
    '',
    `Title: ${title || '(untitled)'}`,
    '',
    'Description:',
    description || '(no description)',
    '',
    'Diagnostics:',
    diagnostics
  ].join('\n');
}

async function sendPrivateReport(
  managers: AppManagers,
  title: string,
  description: string
): Promise<void> {
  const body = buildPrivateMessage(title, description, collectDiagnostics(true));

  const {decodePubkey} = await import('@lib/nostra/nostr-identity');
  const {NostraBridge} = await import('@lib/nostra/nostra-bridge');
  const hexPubkey = decodePubkey(NOSTRA_DEV_NPUB);
  const bridge = NostraBridge.getInstance();
  const peerIdLong = await bridge.mapPubkeyToPeerId(hexPubkey);
  await bridge.storePeerMapping(hexPubkey, peerIdLong, 'Nostra Dev');

  const peerId = peerIdLong.toPeerId(false);

  const rootScope = (await import('@lib/rootScope')).default;
  const avatar = bridge.deriveAvatarFromPubkeySync(hexPubkey);
  try {
    await rootScope.managers.appUsersManager.injectP2PUser(hexPubkey, peerIdLong, 'Nostra Dev', avatar);
  } catch(err) {
    console.warn('[ReportBug] injectP2PUser failed', err);
  }

  const {NostraPeerMapper} = await import('@lib/nostra/nostra-peer-mapper');
  const mapper = new NostraPeerMapper();
  const user = mapper.createTwebUser({peerId: peerIdLong, firstName: 'Nostra Dev', pubkey: hexPubkey});
  const {MOUNT_CLASS_TO: MC} = await import('@config/debug');
  const proxyRef = MC.apiManagerProxy;
  if(proxyRef?.mirrors?.peers) proxyRef.mirrors.peers[peerId] = user;
  const {reconcilePeer} = await import('@stores/peers');
  reconcilePeer(peerId, user);

  const chatAPI = (window as any).__nostraChatAPI;
  chatAPI?.connect(hexPubkey).catch((err: any) => console.warn('[ReportBug] chatAPI connect failed', err));

  await rootScope.managers.appMessagesManager.sendText({peerId, text: body});

  const appImManager = (await import('@lib/appImManager')).default;
  appImManager.setInnerPeer({peerId});
}

function openGithubIssue(title: string, description: string): void {
  const body = buildIssueBody(title, description, collectDiagnostics(false));
  const url = GITHUB_ISSUE_URL +
    '?title=' + encodeURIComponent(title || 'Bug report') +
    '&body=' + encodeURIComponent(body) +
    '&labels=' + encodeURIComponent('bug');
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.append(a);
  a.click();
  a.remove();
}

export default function showReportBugPopup(managers: AppManagers): void {
  const overlay = document.createElement('div');
  overlay.classList.add('popup-report-bug-overlay');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:1000;display:flex;align-items:center;justify-content:center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:var(--surface-color);border-radius:12px;padding:24px;width:420px;max-width:92vw;max-height:90vh;overflow-y:auto;';

  const title = document.createElement('h3');
  title.textContent = 'Report a Bug';
  title.style.cssText = 'margin:0 0 8px;font-size:18px;color:var(--primary-text-color);';

  const desc = document.createElement('p');
  desc.textContent = 'Describe what went wrong, then choose how to send it.';
  desc.style.cssText = 'margin:0 0 16px;font-size:13px;color:var(--secondary-text-color);';

  const inputStyle = 'width:100%;padding:12px;border:1px solid var(--border-color);border-radius:8px;font-size:14px;box-sizing:border-box;background:var(--surface-color);color:var(--primary-text-color);margin-bottom:10px;font-family:inherit;';

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Short summary (e.g. "Chat list empty after reload")';
  titleInput.maxLength = 120;
  titleInput.style.cssText = inputStyle;

  const descInput = document.createElement('textarea');
  descInput.placeholder = 'Steps to reproduce, what you expected, what happened instead…';
  descInput.rows = 6;
  descInput.style.cssText = inputStyle + 'resize:vertical;min-height:120px;';

  const errorEl = document.createElement('div');
  errorEl.style.cssText = 'color:var(--danger-color);font-size:12px;margin-top:4px;min-height:18px;';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:16px;';

  const btnBaseStyle = 'width:100%;padding:12px 16px;border:none;border-radius:10px;cursor:pointer;font-size:14px;font-weight:500;text-align:left;display:flex;flex-direction:row;align-items:center;gap:12px;line-height:1.3;box-sizing:border-box;font-family:inherit;';
  const iconStyle = 'flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;font-size:18px;line-height:1;';
  const textBlockStyle = 'display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto;text-align:left;';

  const makeOptionButton = (iconText: string, titleText: string, subText: string): {
    btn: HTMLButtonElement;
    titleEl: HTMLSpanElement;
  } => {
    const btn = document.createElement('button');
    const icon = document.createElement('span');
    icon.textContent = iconText;
    icon.style.cssText = iconStyle;
    const textBlock = document.createElement('span');
    textBlock.style.cssText = textBlockStyle;
    const titleEl = document.createElement('span');
    titleEl.textContent = titleText;
    titleEl.style.cssText = 'font-weight:600;';
    const subEl = document.createElement('span');
    subEl.textContent = subText;
    subEl.style.cssText = 'font-size:11px;opacity:.85;';
    textBlock.append(titleEl, subEl);
    btn.append(icon, textBlock);
    return {btn, titleEl};
  };

  const github = makeOptionButton('🌐', 'Open public GitHub issue', 'Requires a GitHub account. Visible to everyone.');
  const githubBtn = github.btn;
  const githubTitle = github.titleEl;
  githubBtn.classList.add('btn-primary', 'btn-color-primary');
  githubBtn.style.cssText = btnBaseStyle + 'color:#fff;';

  const priv = makeOptionButton('🔒', 'Send private report to Nostra Dev', 'Uses your Nostra identity. End-to-end encrypted.');
  const privateBtn = priv.btn;
  const privateTitle = priv.titleEl;
  privateBtn.classList.add('btn-primary', 'btn-transparent');
  privateBtn.style.cssText = btnBaseStyle + 'border:1px solid var(--border-color);color:var(--primary-text-color);background:transparent;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.classList.add('btn-primary', 'btn-transparent');
  cancelBtn.style.cssText = 'width:100%;padding:12px 16px;border:none;border-radius:10px;cursor:pointer;font-size:14px;font-weight:500;margin-top:4px;color:var(--secondary-text-color);background:transparent;display:flex;align-items:center;justify-content:center;line-height:1.3;box-sizing:border-box;font-family:inherit;';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const validate = (): boolean => {
    const t = titleInput.value.trim();
    const d = descInput.value.trim();
    if(!t && !d) {
      errorEl.textContent = 'Add a title or description first';
      return false;
    }
    errorEl.textContent = '';
    return true;
  };

  githubBtn.addEventListener('click', () => {
    if(!validate()) return;
    openGithubIssue(titleInput.value.trim(), descInput.value.trim());
    overlay.remove();
  });

  privateBtn.addEventListener('click', async() => {
    if(!validate()) return;
    privateBtn.disabled = true;
    githubBtn.disabled = true;
    privateTitle.textContent = 'Sending…';
    try {
      await sendPrivateReport(managers, titleInput.value.trim(), descInput.value.trim());
      overlay.remove();
      const {toast} = await import('@components/toast');
      toast('Bug report sent to Nostra Dev');
    } catch(err) {
      console.error('[ReportBug] private send failed', err);
      errorEl.textContent = 'Failed to send. Try GitHub instead.';
      privateBtn.disabled = false;
      githubBtn.disabled = false;
      privateTitle.textContent = 'Send private report to Nostra Dev';
    }
  });

  overlay.addEventListener('click', (e) => {
    if(e.target === overlay) overlay.remove();
  });

  btnRow.append(githubBtn, privateBtn, cancelBtn);
  dialog.append(title, desc, titleInput, descInput, errorEl, btnRow);
  overlay.append(dialog);
  document.body.append(overlay);
  titleInput.focus();
}
