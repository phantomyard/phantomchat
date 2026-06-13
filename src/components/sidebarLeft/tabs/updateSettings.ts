/*
 * App Update Settings tab — user-facing controls for the update and integrity
 * subsystem, plus a Diagnostics block for support/debugging and the Reset
 * baseline recovery action. Opened from the main Settings tab.
 */

import {SliderSuperTab} from '@components/slider';
import SettingSection from '@components/settingSection';
import Row from '@components/row';
import Button from '@components/button';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import {toast} from '@components/toast';
import confirmationPopup from '@components/confirmationPopup';
import I18n from '@lib/langPack';
import {runNetworkChecks} from '@lib/update';
import {
  getUpdateStateSnapshot,
  resetBaseline,
  type UpdateStateSnapshot,
  type IntegritySourceDetail
} from '@lib/update/update-baseline';
import {MANIFEST_SOURCES} from '@lib/update/manifest-verifier';
import {getSnoozeInfo, clearSnooze, probeForManualInstall} from '@lib/update/update-popup-controller';

function formatAbsoluteDateTime(tsMs: number): string {
  try {
    return new Date(tsMs).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  } catch{
    return new Date(tsMs).toISOString();
  }
}

function formatRelativeTime(tsMs: number): string {
  const diff = Date.now() - tsMs;
  const sec = Math.floor(diff / 1000);
  if(sec < 60) return I18n.format('Update.RelativeTime.JustNow', true);
  const min = Math.floor(sec / 60);
  if(min < 60) return I18n.format('Update.RelativeTime.MinutesAgo', true, [min]);
  const hr = Math.floor(min / 60);
  if(hr < 24) return I18n.format('Update.RelativeTime.HoursAgo', true, [hr]);
  const d = Math.floor(hr / 24);
  return I18n.format('Update.RelativeTime.DaysAgo', true, [d]);
}

function verdictLabel(verdict: string): string {
  if(verdict === 'verified') return I18n.format('Update.Verdict.Verified', true);
  if(verdict === 'verified-partial') return I18n.format('Update.Verdict.VerifiedPartial', true);
  if(verdict === 'conflict') return I18n.format('Update.Verdict.Conflict', true);
  if(verdict === 'insufficient') return I18n.format('Update.Verdict.Insufficient', true);
  if(verdict === 'offline') return I18n.format('Update.Verdict.Offline', true);
  if(verdict === 'error') return I18n.format('Update.Verdict.Error', true);
  return verdict;
}

function pickLatestVersion(snap: UpdateStateSnapshot): string | null {
  if(snap.pendingManifest?.version) return snap.pendingManifest.version;
  const okSource = snap.lastIntegrityDetails?.find((d) => d.status === 'ok' && d.version);
  return okSource?.version ?? null;
}

function latestVersionSubtitle(snap: UpdateStateSnapshot): string {
  const latest = pickLatestVersion(snap);
  if(!latest) return I18n.format('Update.Value.NotCheckedYet', true);
  if(snap.installedVersion && latest !== snap.installedVersion) {
    return I18n.format('Update.Value.UpdateAvailable', true, [latest]);
  }
  return I18n.format('Update.Value.UpToDate', true, [latest]);
}

function shortFingerprint(fp: string): string {
  if(!fp) return '';
  const clean = fp.replace(/\s/g, '');
  if(clean.length <= 20) return clean;
  return `${clean.slice(0, 8)}…${clean.slice(-8)}`;
}

function buildSignatureBlock(manifest: any, installedFingerprint: string | null): HTMLDivElement {
  const block = document.createElement('div');
  block.className = 'update-signature-block';
  block.style.cssText = 'display:flex;flex-direction:column;gap:0.375rem;padding:0.25rem 1.5rem 0.75rem 4.5rem;font-size:0.875rem;color:var(--secondary-text-color)';

  const fp: string | undefined = manifest?.signingKeyFingerprint;
  const rotation: {newFingerprint?: string; effectiveAt?: string} | null = manifest?.rotation ?? null;

  const makeRow = (icon: string, text: string): HTMLDivElement => {
    const r = document.createElement('div');
    r.style.cssText = 'display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;word-break:break-all';
    r.textContent = `${icon} ${text}`;
    return r;
  };

  if(fp) {
    const matches = installedFingerprint && fp === installedFingerprint;
    const icon = matches ? '✅' : (rotation ? '⚠️' : '🔑');
    const suffix = matches ?
      I18n.format('Update.Signature.MatchesInstalled', true) :
      (installedFingerprint ? I18n.format('Update.Signature.DifferentFromInstalled', true) : '');
    block.appendChild(makeRow(icon, `${I18n.format('Update.Signature.Fingerprint', true)}: ${shortFingerprint(fp)}${suffix ? ' — ' + suffix : ''}`));
  } else {
    block.appendChild(makeRow('ℹ️', I18n.format('Update.Signature.NoFingerprint', true)));
  }

  if(rotation?.newFingerprint) {
    block.appendChild(makeRow('🔄', `${I18n.format('Update.Signature.Rotation', true)}: ${shortFingerprint(rotation.newFingerprint)}${rotation.effectiveAt ? ' (' + rotation.effectiveAt + ')' : ''}`));
  }

  return block;
}

function buildIntegrityDetailsBlock(details: IntegritySourceDetail[]): HTMLDivElement {
  const urlByName = new Map(MANIFEST_SOURCES.map((s) => [s.name, s.url]));
  const block = document.createElement('div');
  block.className = 'update-integrity-details';
  block.style.cssText = 'display:flex;flex-direction:column;gap:0.375rem;padding:0.25rem 1.5rem 0.75rem 4.5rem;font-size:0.875rem';

  // Flag fields that disagree across the `ok` sources. The cross-source
  // verdict keys on {version, gitSha, swUrl} — on localhost all three rows
  // can look green with the same version yet the overall verdict is
  // `conflict` because gitSha/swUrl differ (your dev build vs prod).
  // Showing the disagreeing fields inline is what makes the conflict legible.
  const okSources = details.filter((s) => s.status === 'ok');
  const disagrees = (pick: (s: IntegritySourceDetail) => string | undefined): boolean => {
    if(okSources.length < 2) return false;
    const seen = new Set<string>();
    for(const s of okSources) { const v = pick(s); if(v) seen.add(v); }
    return seen.size > 1;
  };
  const versionConflict = disagrees((s) => s.version);
  const shaConflict = disagrees((s) => s.gitSha);
  const swConflict = disagrees((s) => s.swUrl);
  const shortSha = (sha?: string) => sha ? sha.slice(0, 8) : '';

  for(const s of details) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap';
    const icon = s.status === 'ok' ? '✅' : s.status === 'error' ? '❌' : '⚠️';
    const label = document.createElement('span');
    const parts: string[] = [`${icon} ${s.name}: ${s.status}`];
    if(s.version) parts.push(`${versionConflict ? '⚠ ' : ''}v${s.version}`);
    if(s.gitSha) parts.push(`${shaConflict ? '⚠ ' : ''}@${shortSha(s.gitSha)}`);
    if(s.swUrl && swConflict) parts.push(`sw=${s.swUrl}`);
    if(s.error) parts.push(`— ${s.error}`);
    label.textContent = parts.join(' ');
    label.style.cssText = 'flex:1;min-width:0;word-break:break-word;color:var(--secondary-text-color)';
    row.appendChild(label);
    const url = urlByName.get(s.name);
    if(url) {
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = I18n.format('Update.Sources.OpenInTab', true);
      link.style.cssText = 'color:var(--primary-color);text-decoration:underline;flex-shrink:0';
      row.appendChild(link);
    }
    block.appendChild(row);
  }
  return block;
}

function applyFullUrlStyle(row: Row): void {
  row.subtitle.style.wordBreak = 'break-all';
  row.subtitle.style.whiteSpace = 'normal';
}

export default class AppUpdateSettingsTab extends SliderSuperTab {
  public async init() {
    this.container.classList.add('update-settings');
    this.setTitle('Update.Tab.Title');

    const snap: UpdateStateSnapshot = await getUpdateStateSnapshot();

    // ── Installed ────────────────────────────────────────────────────────
    // High-signal rows only: what you have and whether there's something newer.
    // The Service Worker URLs that used to live here are under Diagnostics now.
    const infoSection = new SettingSection({name: 'Update.Section.Installed'});

    const versionRow = new Row({
      titleLangKey: 'Update.Row.CurrentVersion',
      subtitle: snap.installedVersion || I18n.format('Update.Value.Unknown', true),
      clickable: false
    });
    infoSection.content.append(versionRow.container);

    const latestVersionRow = new Row({
      titleLangKey: 'Update.Row.LatestVersion',
      subtitle: latestVersionSubtitle(snap),
      clickable: false
    });
    infoSection.content.append(latestVersionRow.container);

    // ── Integrity ────────────────────────────────────────────────────────
    // User-facing verdict + when it was last computed + signature of any
    // pending update. Per-source breakdown + waiting-SW plumbing lives in
    // Diagnostics so the main view stays readable.
    const integritySection = new SettingSection({name: 'Update.Section.Integrity'});

    const lastCheckText = snap.lastIntegrityCheck && snap.lastIntegrityCheck > 0 ?
      formatRelativeTime(snap.lastIntegrityCheck) :
      I18n.format('Update.Value.Never', true);
    const lastCheckRow = new Row({
      titleLangKey: 'Update.Row.LastCheck',
      subtitle: lastCheckText,
      clickable: false
    });
    integritySection.content.append(lastCheckRow.container);

    const integrityRow = new Row({
      titleLangKey: 'Update.Row.IntegrityStatus',
      subtitle: snap.lastIntegrityResult ? verdictLabel(snap.lastIntegrityResult) : I18n.format('Update.Value.NotCheckedYet', true),
      clickable: false
    });
    integritySection.content.append(integrityRow.container);

    // Signature block — only when a signed update is stashed in memory
    // (populated by `update-popup-controller` after a successful probe).
    let signatureRow: Row | null = null;
    let signatureBlock: HTMLDivElement | null = null;
    const renderSignatureBlock = async() => {
      signatureBlock?.remove();
      signatureBlock = null;
      signatureRow?.container.remove();
      signatureRow = null;
      const stash = (window as any).__nostraPendingUpdate;
      const manifest = stash?.manifest;
      if(!manifest) return;
      const {getActiveVersion} = await import('@lib/serviceWorker/shell-cache');
      const active = await getActiveVersion().catch((): null => null);
      signatureRow = new Row({
        titleLangKey: 'Update.Row.PendingSignature',
        subtitle: I18n.format('Update.Value.PendingSignatureFor', true, [manifest.version ?? '—']),
        clickable: false
      });
      integritySection.content.append(signatureRow.container);
      signatureBlock = buildSignatureBlock(manifest, active?.keyFingerprint ?? null);
      signatureRow.container.after(signatureBlock);
    };
    renderSignatureBlock();

    // ── Notifications (snooze state) ────────────────────────────────────
    const notificationsSection = new SettingSection({name: 'Update.Section.Notifications'});

    const snoozeSubtitle = () => {
      const info = getSnoozeInfo();
      return info ?
        I18n.format('Update.Value.SnoozeActive', true, [info.version, formatAbsoluteDateTime(info.until)]) :
        I18n.format('Update.Value.SnoozeInactive', true);
    };
    const snoozeRow = new Row({
      titleLangKey: 'Update.Row.SnoozeStatus',
      subtitle: snoozeSubtitle(),
      clickable: false
    });
    snoozeRow.subtitle.style.whiteSpace = 'normal';
    notificationsSection.content.append(snoozeRow.container);

    const clearSnoozeBtn = Button('btn-primary btn-color-primary');
    clearSnoozeBtn.textContent = I18n.format('Update.Action.ClearSnooze', true);
    clearSnoozeBtn.style.marginTop = '0.5rem';
    const refreshSnoozeUI = () => {
      const info = getSnoozeInfo();
      snoozeRow.subtitle.textContent = snoozeSubtitle();
      clearSnoozeBtn.style.display = info ? '' : 'none';
    };
    refreshSnoozeUI();
    attachClickEvent(clearSnoozeBtn, async() => {
      try {
        await confirmationPopup({
          titleLangKey: 'Update.Confirm.ClearSnoozeTitle',
          descriptionLangKey: 'Update.Confirm.ClearSnoozeDescription',
          button: {text: document.createTextNode(I18n.format('Update.Action.ClearSnooze', true))}
        });
      } catch{
        return;
      }
      clearSnooze();
      refreshSnoozeUI();
      toast(I18n.format('Update.Action.SnoozeCleared', true));
    }, {listenerSetter: this.listenerSetter});
    notificationsSection.content.append(clearSnoozeBtn);

    // ── Actions ──────────────────────────────────────────────────────────
    const actionsSection = new SettingSection({name: 'Update.Section.Actions'});

    const installBtn = Button('btn-primary btn-color-primary');
    installBtn.textContent = I18n.format('Update.Action.InstallNow', true);
    installBtn.style.marginBottom = '0.5rem';
    const hasKnownUpdate = (s: UpdateStateSnapshot): boolean => {
      const latest = pickLatestVersion(s);
      return !!(latest && s.installedVersion && latest !== s.installedVersion);
    };
    const refreshInstallBtn = (s?: UpdateStateSnapshot) => {
      const stash = (window as any).__nostraPendingUpdate;
      const hasStash = !!(stash && stash.manifest && stash.signature);
      const hasSnap = !!(s && hasKnownUpdate(s));
      installBtn.style.display = hasStash || hasSnap ? '' : 'none';
    };
    refreshInstallBtn(snap);
    attachClickEvent(installBtn, async() => {
      let stash = (window as any).__nostraPendingUpdate;
      // If snooze suppressed the probe dispatch, the stash is empty even though
      // an update is known — rehydrate it via a fresh signed probe. Clicking
      // "Install update now" is explicit user intent; it bypasses snooze.
      if(!stash || !stash.manifest || !stash.signature) {
        try {
          stash = await probeForManualInstall();
        } catch(err) {
          toast(I18n.format('Update.Action.InstallFailed', true, [err instanceof Error ? err.message : String(err)]));
          return;
        }
      }
      if(!stash || !stash.manifest || !stash.signature) {
        toast(I18n.format('Update.Action.InstallNoneAvailable', true));
        refreshInstallBtn();
        return;
      }
      try {
        const {showUpdateConsentPopup} = await import('@components/popups/updateConsent/mount');
        await showUpdateConsentPopup(stash.manifest, stash.signature, stash.manifestText);
      } catch(err) {
        toast(I18n.format('Update.Action.InstallFailed', true, [err instanceof Error ? err.message : String(err)]));
      }
    }, {listenerSetter: this.listenerSetter});
    actionsSection.content.append(installBtn);

    const checkBtnLabel = I18n.format('Update.Action.CheckForUpdates', true);
    const checkBtn = Button('btn-primary btn-color-primary');
    checkBtn.textContent = checkBtnLabel;
    attachClickEvent(checkBtn, async() => {
      checkBtn.disabled = true;
      checkBtn.textContent = I18n.format('Update.Action.Checking', true);
      try {
        await runNetworkChecks({force: true});
        const {runProbeIfDue} = await import('@lib/update/update-popup-controller');
        await runProbeIfDue(true).catch((e) => console.warn('[update] probe failed', e));
        const latest = await getUpdateStateSnapshot();
        if(latest.lastIntegrityCheck) {
          lastCheckRow.subtitle.textContent = formatRelativeTime(latest.lastIntegrityCheck);
        }
        if(latest.lastIntegrityResult) {
          integrityRow.subtitle.textContent = verdictLabel(latest.lastIntegrityResult);
        }
        latestVersionRow.subtitle.textContent = latestVersionSubtitle(latest);
        renderDiagnostics(latest);
        refreshInstallBtn(latest);
        await renderSignatureBlock();
        if(verdictNeedsDetails(latest.lastIntegrityResult)) setDiagnosticsVisible(true);
        toast(I18n.format('Update.Action.CheckComplete', true));
      } catch(err) {
        toast(I18n.format('Update.Action.CheckFailed', true, [err instanceof Error ? err.message : String(err)]));
      } finally {
        checkBtn.disabled = false;
        checkBtn.textContent = checkBtnLabel;
      }
    }, {listenerSetter: this.listenerSetter});
    actionsSection.content.append(checkBtn);

    // ── Diagnostics ─────────────────────────────────────────────────────
    // Technical rows moved out of the main sections. Toggled off by default;
    // a row above it flips visibility. Useful when debugging "why did the
    // check say offline / error / conflict" — shows the per-source breakdown
    // and the underlying SW URLs the baseline is guarding.
    const diagnosticsSection = new SettingSection({
      name: 'Update.Section.Diagnostics',
      caption: 'Update.Diagnostics.Caption'
    });
    diagnosticsSection.container.style.display = 'none';

    const diagToggleSection = new SettingSection({});
    const setDiagnosticsVisible = (visible: boolean) => {
      diagnosticsSection.container.style.display = visible ? '' : 'none';
      diagToggleRow.title.textContent = I18n.format(
        visible ? 'Update.Row.HideDiagnostics' : 'Update.Row.ShowDiagnostics',
        true
      );
    };
    const diagToggleRow = new Row({
      titleLangKey: 'Update.Row.ShowDiagnostics',
      icon: 'info',
      clickable: () => {
        setDiagnosticsVisible(diagnosticsSection.container.style.display === 'none');
      },
      listenerSetter: this.listenerSetter
    });
    diagToggleSection.content.append(diagToggleRow.container);

    // Auto-expand Diagnostics when the verdict surfaces a problem. The
    // per-source breakdown is the only place that explains *why* we got
    // `conflict` / `error` / `insufficient` (and with the gitSha shown
    // inline, the mismatch is legible). Leaving Diagnostics collapsed in
    // that state means the user sees a bare "Conflict detected" with no
    // follow-up.
    const verdictNeedsDetails = (v: string | null | undefined): boolean => {
      return v === 'conflict' || v === 'error' || v === 'insufficient';
    };
    if(verdictNeedsDetails(snap.lastIntegrityResult)) setDiagnosticsVisible(true);

    const swUrlRow = new Row({
      titleLangKey: 'Update.Row.InstalledSwUrl',
      subtitle: snap.installedSwUrl || I18n.format('Update.Value.NotSet', true),
      clickable: false
    });
    applyFullUrlStyle(swUrlRow);
    diagnosticsSection.content.append(swUrlRow.container);

    const activeRow = new Row({
      titleLangKey: 'Update.Row.ActiveSw',
      subtitle: snap.activeScriptUrl || I18n.format('Update.Value.NotSet', true),
      clickable: false
    });
    applyFullUrlStyle(activeRow);
    diagnosticsSection.content.append(activeRow.container);

    const waitingRow = new Row({
      titleLangKey: 'Update.Row.WaitingSw',
      subtitle: snap.waitingScriptUrl || I18n.format('Update.Value.None', true),
      clickable: false
    });
    applyFullUrlStyle(waitingRow);
    diagnosticsSection.content.append(waitingRow.container);

    const pendingRow = new Row({
      titleLangKey: 'Update.Row.PendingFinalization',
      subtitle: snap.pendingFinalization ?
        (snap.pendingManifest ? I18n.format('Update.Value.PendingYesWithVersion', true, [snap.pendingManifest.version]) : I18n.format('Update.Value.Yes', true)) :
        I18n.format('Update.Value.No', true),
      clickable: false
    });
    diagnosticsSection.content.append(pendingRow.container);

    const sourcesHeader = new Row({
      titleLangKey: 'Update.Row.SourceBreakdown',
      subtitleLangKey: 'Update.Row.SourceBreakdown.Subtitle',
      clickable: false
    });
    diagnosticsSection.content.append(sourcesHeader.container);

    let detailsBlock: HTMLDivElement | null = null;
    const renderDiagnostics = (latest: UpdateStateSnapshot) => {
      swUrlRow.subtitle.textContent = latest.installedSwUrl || I18n.format('Update.Value.NotSet', true);
      activeRow.subtitle.textContent = latest.activeScriptUrl || I18n.format('Update.Value.NotSet', true);
      waitingRow.subtitle.textContent = latest.waitingScriptUrl || I18n.format('Update.Value.None', true);
      pendingRow.subtitle.textContent = latest.pendingFinalization ?
        (latest.pendingManifest ? I18n.format('Update.Value.PendingYesWithVersion', true, [latest.pendingManifest.version]) : I18n.format('Update.Value.Yes', true)) :
        I18n.format('Update.Value.No', true);
      detailsBlock?.remove();
      detailsBlock = null;
      if(latest.lastIntegrityDetails?.length) {
        detailsBlock = buildIntegrityDetailsBlock(latest.lastIntegrityDetails);
        sourcesHeader.container.after(detailsBlock);
      }
    };
    renderDiagnostics(snap);

    // ── Advanced (recovery) ─────────────────────────────────────────────
    // One recovery action: full reinstall. Combines everything the two
    // previous Rows (Reset baseline + dev Force reload) did separately —
    // unregister Service Worker, wipe CacheStorage, reset the trusted
    // baseline, reload — and explains it in user terms. A soft baseline
    // reset without re-download is a footgun (it asks the user to trust
    // code that may be the very thing the compromise banner is warning
    // about), so it's not offered as a separate shortcut anymore.
    const advancedSection = new SettingSection({
      name: 'Update.Section.Advanced',
      caption: 'Update.Advanced.Caption'
    });
    const reinstallRow = new Row({
      titleLangKey: 'Update.Action.Reinstall',
      subtitleLangKey: 'Update.Row.Reinstall.Subtitle',
      icon: 'replace',
      clickable: async() => {
        try {
          await confirmationPopup({
            titleLangKey: 'Update.Reinstall.ConfirmTitle',
            descriptionLangKey: 'Update.Reinstall.ConfirmDescription',
            button: {
              text: document.createTextNode(I18n.format('Update.Action.ReinstallConfirm', true)),
              isDanger: true
            }
          });
        } catch{
          return;
        }
        try {
          if('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister()));
          }
          if('caches' in window) {
            const names = await caches.keys();
            await Promise.all(names.map((n) => caches.delete(n)));
          }
        } catch(err) {
          console.warn('[reinstall] cleanup failed', err);
        }
        resetBaseline();
        window.location.reload();
      },
      listenerSetter: this.listenerSetter
    });
    advancedSection.content.append(reinstallRow.container);

    // ── About this protection ───────────────────────────────────────────
    const helpSection = new SettingSection({name: 'Update.Section.About'});
    const helpRow = new Row({
      titleLangKey: 'Update.Row.HowItWorks',
      subtitleLangKey: 'Update.Row.HowItWorks.Subtitle',
      icon: 'info',
      clickable: () => {
        confirmationPopup({
          titleLangKey: 'Update.Confirm.ProtectionTitle',
          descriptionLangKey: 'Update.HowItWorks.Description',
          button: {text: document.createTextNode(I18n.format('Update.Action.OK', true))}
        }).catch(() => { /* user closed */ });
      },
      listenerSetter: this.listenerSetter
    });
    helpSection.content.append(helpRow.container);

    this.scrollable.append(
      infoSection.container,
      integritySection.container,
      notificationsSection.container,
      actionsSection.container,
      diagToggleSection.container,
      diagnosticsSection.container,
      advancedSection.container,
      helpSection.container
    );
  }
}
