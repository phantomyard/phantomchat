import {createSignal, Show} from 'solid-js';

export interface FirstInstallInfoProps {
  fingerprint: string;
  version: string;
  onDismiss: () => void;
}

const S = {
  popup: 'max-width:30rem;width:100%;padding:1.75rem 1.75rem 1.5rem;background:var(--body-background-color,#1f1f1f);color:var(--primary-text-color,#fff);border-radius:1rem;box-shadow:0 12px 48px rgba(0,0,0,0.45);text-align:center',
  iconWrap: 'width:64px;height:64px;margin:0 auto 1rem;border-radius:50%;background:rgba(92,196,83,0.14);display:flex;align-items:center;justify-content:center',
  iconSvg: 'width:32px;height:32px;color:#5cc453',
  h2: 'margin:0 0 0.25rem;font-size:1.35rem;font-weight:600;letter-spacing:-0.01em',
  subtitle: 'margin:0 0 1.5rem;font-size:0.95rem;color:var(--secondary-text-color,#9d9d9d)',
  list: 'text-align:left;margin:0 0 1.25rem;padding:0;list-style:none',
  item: 'display:flex;gap:0.65rem;margin:0 0 0.6rem;font-size:0.9rem;line-height:1.5',
  itemIcon: 'flex-shrink:0;width:18px;height:18px;color:#8774e1;margin-top:1px',
  itemStrong: 'font-weight:600;color:var(--primary-text-color,#fff)',
  itemMuted: 'color:var(--secondary-text-color,#9d9d9d)',
  divider: 'width:3rem;height:1px;background:currentColor;opacity:0.12;margin:0 auto 1rem',
  fingerprintBox: 'text-align:left;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:0.5rem;padding:0.65rem 0.85rem;margin:0 0 1rem',
  fingerprintLabel: 'font-size:0.75rem;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--secondary-text-color,#9d9d9d);margin:0 0 0.25rem',
  fingerprintCode: 'font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:0.8rem;word-break:break-all;color:var(--primary-text-color,#fff)',
  toggle: 'background:transparent;color:var(--primary-color,#8774e1);border:none;padding:0.25rem 0.5rem;font-size:0.85rem;cursor:pointer;font-weight:500',
  details: 'font-size:0.85rem;color:var(--secondary-text-color,#9d9d9d);line-height:1.55;text-align:left;margin:0.5rem 0 1rem',
  link: 'color:var(--primary-color,#8774e1);text-decoration:none',
  actions: 'display:flex;justify-content:center;margin-top:1.25rem',
  btnPrimary: 'padding:0.7rem 1.75rem;border:none;border-radius:0.6rem;font-size:0.95rem;cursor:pointer;background:var(--primary-color,#8774e1);color:#fff;font-weight:600'
};

export function FirstInstallInfo(props: FirstInstallInfoProps) {
  const [expanded, setExpanded] = createSignal(false);

  return (
    <div style={S.popup}>
      <div style={S.iconWrap}>
        <svg style={S.iconSvg} viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='3' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'>
          <path d='M4 13l5 5 11-11' />
        </svg>
      </div>
      <h2 style={S.h2}>You're all set</h2>
      <p style={S.subtitle}>Nostra.chat v{props.version} is installed and verified.</p>

      <ul style={S.list}>
        <li style={S.item}>
          <svg style={S.itemIcon} viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'>
            <path d='M12 2l8 4v6c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-4z' />
            <path d='M9 12l2 2 4-4' />
          </svg>
          <span><span style={S.itemStrong}>Pinned to this version.</span> <span style={S.itemMuted}>Your browser won't silently fetch new code.</span></span>
        </li>
        <li style={S.item}>
          <svg style={S.itemIcon} viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'>
            <circle cx='12' cy='12' r='10' />
            <path d='M12 8v4' />
            <path d='M12 16h.01' />
          </svg>
          <span><span style={S.itemStrong}>Updates need your approval.</span> <span style={S.itemMuted}>A consent popup will surface when a new signed release is published.</span></span>
        </li>
        <li style={S.item}>
          <svg style={S.itemIcon} viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'>
            <rect x='3' y='11' width='18' height='10' rx='2' />
            <path d='M7 11V7a5 5 0 0 1 10 0v4' />
          </svg>
          <span><span style={S.itemStrong}>Verified by Ed25519 signature.</span> <span style={S.itemMuted}>Only releases signed by the project key are offered.</span></span>
        </li>
      </ul>

      <div style={S.divider} aria-hidden='true' />

      <div style={S.fingerprintBox}>
        <div style={S.fingerprintLabel}>Signing key fingerprint</div>
        <div style={S.fingerprintCode}>{props.fingerprint}</div>
      </div>

      <button type='button' style={S.toggle} onClick={() => setExpanded(!expanded())}>
        {expanded() ? 'Hide technical details' : 'Show technical details'}
      </button>
      <Show when={expanded()}>
        <p style={S.details}>
          Your copy of Nostra.chat is locked to v{props.version}. The browser won't fetch a newer bundle until you explicitly accept an update. Cross-check the fingerprint above against the <a style={S.link} href='https://github.com/nostra-chat/nostra-chat' target='_blank' rel='noopener'>GitHub repository</a> to confirm no one has tampered with your install.
        </p>
      </Show>

      <div style={S.actions}>
        <button type='button' style={S.btnPrimary} onClick={() => props.onDismiss()}>Got it</button>
      </div>
    </div>
  );
}

const FIRST_INSTALL_SEEN = 'nostra.update.first-install-seen';

export function shouldShowFirstInstall(): boolean {
  return !localStorage.getItem(FIRST_INSTALL_SEEN);
}

export function markFirstInstallSeen(): void {
  localStorage.setItem(FIRST_INSTALL_SEEN, '1');
}
