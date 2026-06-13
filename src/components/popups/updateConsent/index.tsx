import {createSignal, createMemo, Show} from 'solid-js';
import I18n from '@lib/langPack';

export interface UpdateProgress {
  done: number;
  total: number;
}

export interface UpdateConsentProps {
  currentVersion: string;
  newManifest: {
    version: string;
    gitSha: string;
    published: string;
    signingKeyFingerprint?: string;
    rotation?: null | {newFingerprint: string};
    changelog?: string;
  };
  installedFingerprint: string;
  progress?: UpdateProgress | null;
  onAccept: () => Promise<void>;
  onDecline: () => void;
}

const S = {
  popup: 'max-width:32rem;width:100%;padding:1.5rem;background:var(--body-background-color,#2a2a2a);color:var(--primary-text-color,#fff);border-radius:0.75rem;box-shadow:0 8px 32px rgba(0,0,0,0.4)',
  h2: 'margin:0 0 1rem 0;font-size:1.25rem;font-weight:600',
  details: 'display:grid;grid-template-columns:auto 1fr;gap:0.5rem 1rem;margin-bottom:1rem',
  dt: 'color:var(--secondary-text-color,#999);font-size:0.9rem;margin:0',
  dd: 'margin:0;font-size:0.9rem;word-break:break-all',
  code: 'font-family:ui-monospace,monospace;font-size:0.85rem;padding:0.1rem 0.3rem;background:rgba(255,255,255,0.08);border-radius:0.25rem',
  link: 'color:var(--primary-color,#8774e1);text-decoration:none',
  ok: 'color:var(--green-color,#5cc453);margin-left:0.5rem',
  warn: 'color:var(--warning-color,#ff9500);font-size:0.9rem',
  error: 'color:var(--danger-color,#ff5555);margin:1rem 0;font-size:0.9rem',
  changelogSummary: 'cursor:pointer;color:var(--secondary-text-color,#999);font-size:0.9rem',
  changelogPre: 'white-space:pre-wrap;max-height:10rem;overflow-y:auto;margin:0.5rem 0 0 0;padding:0.75rem;background:rgba(255,255,255,0.05);border-radius:0.5rem;font-size:0.85rem',
  actions: 'display:flex;gap:0.75rem;justify-content:flex-end;margin-top:1.5rem',
  btn: 'padding:0.6rem 1.25rem;border:none;border-radius:0.5rem;font-size:0.95rem;cursor:pointer;background:transparent;color:var(--primary-text-color,#fff)',
  btnPrimary: 'padding:0.6rem 1.25rem;border:none;border-radius:0.5rem;font-size:0.95rem;cursor:pointer;background:var(--primary-color,#8774e1);color:#fff;font-weight:600',
  progressWrap: 'margin:1.25rem 0 0.25rem;padding:1rem 1.1rem;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);border-radius:0.65rem',
  progressHeader: 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.6rem;font-size:0.85rem',
  progressPhase: 'font-weight:600;color:var(--primary-text-color,#fff);letter-spacing:0.01em',
  progressPercent: 'font-variant-numeric:tabular-nums;color:var(--primary-color,#8774e1);font-weight:600',
  progressPercentDone: 'font-variant-numeric:tabular-nums;color:var(--green-color,#5cc453);font-weight:600',
  progressTrack: 'position:relative;height:8px;background:rgba(255,255,255,0.07);border-radius:999px;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,0.04)',
  progressFill: 'position:absolute;inset:0 auto 0 0;border-radius:999px;background:linear-gradient(90deg,var(--primary-color,#8774e1) 0%,#a193ff 50%,var(--primary-color,#8774e1) 100%);background-size:200% 100%;transition:width 320ms cubic-bezier(0.22,1,0.36,1);box-shadow:0 0 12px rgba(135,116,225,0.55);animation:nostra-update-shimmer 1.6s linear infinite',
  progressFillDone: 'position:absolute;inset:0 auto 0 0;border-radius:999px;background:linear-gradient(90deg,var(--green-color,#5cc453),#7fd06f);transition:width 320ms cubic-bezier(0.22,1,0.36,1);box-shadow:0 0 12px rgba(92,196,83,0.55)',
  progressMeta: 'display:flex;justify-content:space-between;align-items:center;margin-top:0.55rem;font-size:0.78rem;color:var(--secondary-text-color,#9d9d9d);font-variant-numeric:tabular-nums'
};

const SHIMMER_KEYFRAMES = '@keyframes nostra-update-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}@keyframes nostra-update-pulse{0%,100%{opacity:0.55}50%{opacity:1}}';

let shimmerInjected = false;
function injectShimmerStyle() {
  if(shimmerInjected || typeof document === 'undefined') return;
  shimmerInjected = true;
  const style = document.createElement('style');
  style.setAttribute('data-nostra-update-shimmer', '');
  style.textContent = SHIMMER_KEYFRAMES;
  document.head.appendChild(style);
}

export function UpdateConsent(props: UpdateConsentProps) {
  injectShimmerStyle();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>('');

  const progressData = createMemo(() => props.progress ?? null);
  const percent = createMemo(() => {
    const p = progressData();
    if(!p || p.total <= 0) return 0;
    return Math.min(100, Math.round((p.done / p.total) * 100));
  });
  const isComplete = createMemo(() => {
    const p = progressData();
    return !!p && p.total > 0 && p.done >= p.total;
  });
  const phaseLabel = createMemo(() => {
    if(!progressData()) return '';
    if(isComplete()) return I18n.format('Update.Consent.PhaseInstalling', true);
    return I18n.format('Update.Consent.PhaseDownloading', true);
  });

  const keyMatches = () =>
    !!props.newManifest.signingKeyFingerprint &&
    props.newManifest.signingKeyFingerprint === props.installedFingerprint;
  const isRotation = () => props.newManifest.rotation != null;

  async function accept() {
    setBusy(true);
    setError('');
    try {
      await props.onAccept();
    } catch(e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div style={S.popup}>
      <h2 style={S.h2}>{I18n.format('Update.Consent.Title', true)}</h2>
      <dl style={S.details}>
        <dt style={S.dt}>{I18n.format('Update.Consent.FieldVersion', true)}</dt>
        <dd style={S.dd}>{props.currentVersion} → {props.newManifest.version}</dd>
        <dt style={S.dt}>{I18n.format('Update.Consent.FieldCommit', true)}</dt>
        <dd style={S.dd}><a style={S.link} href={`https://github.com/nostra-chat/nostra-chat/commit/${props.newManifest.gitSha}`} target='_blank' rel='noopener'>{props.newManifest.gitSha.slice(0, 7)}</a></dd>
        <dt style={S.dt}>{I18n.format('Update.Consent.FieldDate', true)}</dt>
        <dd style={S.dd}>{new Date(props.newManifest.published).toLocaleDateString()}</dd>
        <dt style={S.dt}>{I18n.format('Update.Consent.FieldSigningKey', true)}</dt>
        <dd style={S.dd}>
          <code style={S.code}>{props.newManifest.signingKeyFingerprint}</code>
          <Show when={keyMatches()}><span style={S.ok}> {I18n.format('Update.Consent.SameAsInstalled', true)}</span></Show>
        </dd>
        <Show when={isRotation()}>
          <dt style={S.dt}>{I18n.format('Update.Consent.FieldRotation', true)}</dt>
          <dd style={S.warn}>{I18n.format('Update.Consent.RotatesTo', true)} <code style={S.code}>{props.newManifest.rotation!.newFingerprint}</code></dd>
        </Show>
      </dl>
      <Show when={props.newManifest.changelog}>
        <details>
          <summary style={S.changelogSummary}>{I18n.format('Update.Consent.ReleaseNotes', true)}</summary>
          <pre style={S.changelogPre}>{props.newManifest.changelog}</pre>
        </details>
      </Show>
      <Show when={progressData()}>
        <div style={S.progressWrap} role='status' aria-live='polite'>
          <div style={S.progressHeader}>
            <span style={S.progressPhase}>{phaseLabel()}</span>
            <span style={isComplete() ? S.progressPercentDone : S.progressPercent}>{percent()}%</span>
          </div>
          <div
            style={S.progressTrack}
            role='progressbar'
            aria-valuenow={progressData()!.done}
            aria-valuemin='0'
            aria-valuemax={progressData()!.total}
          >
            <div style={`${isComplete() ? S.progressFillDone : S.progressFill};width:${percent()}%`} />
          </div>
          <div style={S.progressMeta}>
            <span>{I18n.format('Update.Consent.ChunksVerified', true, [progressData()!.done, progressData()!.total])}</span>
            <Show when={isComplete()}>
              <span style='color:var(--green-color,#5cc453);font-weight:600'>{I18n.format('Update.Consent.PhaseFinalizing', true)}</span>
            </Show>
          </div>
        </div>
      </Show>
      <Show when={error()}>
        <p style={S.error}>{error()}</p>
      </Show>
      <div style={S.actions}>
        <button style={S.btn} disabled={busy()} onClick={() => props.onDecline()}>{I18n.format('Update.Consent.Ignore', true)}</button>
        <button style={S.btnPrimary} disabled={busy()} onClick={accept}>{busy() ? I18n.format('Update.Consent.Applying', true) : I18n.format('Update.Consent.Accept', true)}</button>
      </div>
    </div>
  );
}
