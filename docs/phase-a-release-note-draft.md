# Phase A Release Note Draft

Copy this into the release-please PR description (or the GitHub Release notes manually) when cutting the first Phase A version.

---

## Controlled Updates — nessun aggiornamento silenzioso

Da questa versione in avanti, Nostra.chat non si aggiorna più automaticamente. Ogni aggiornamento richiede il tuo consenso esplicito.

**Cosa cambia**
- All'avvio dell'app, se una nuova versione è disponibile, compare un popup che mostra il changelog e ti chiede di confermare l'aggiornamento.
- Ogni aggiornamento è **verificato in modo incrociato** contro 3 sorgenti indipendenti (nostra.chat via Cloudflare, GitHub Releases, IPFS) prima di essere proposto.
- Nuovo pannello in **Impostazioni → Privacy & Sicurezza → App Updates** che mostra la versione corrente, l'ultimo controllo di integrità e un pulsante per forzare un controllo manuale.
- Il Service Worker non si sostituisce più da solo in background.

**Cosa non cambia**
- I tuoi dati restano invariati. Nessun reset, nessun re-onboarding.
- Modello di sicurezza: vedi `docs/TRUST-MINIMIZED-UPDATES.md` per il threat model completo e ciò che Phase A protegge (e non protegge).

**Limiti noti**
- La prima installazione di questa versione avviene ancora in modo silenzioso (una volta sola). Da ora in poi, ogni aggiornamento successivo richiede consenso.
- Phase A difende da una compromissione singola del CDN. Una compromissione coordinata di tutte e 3 le origini simultaneamente è coperta da **Phase C** (firme crittografiche del maintainer), prevista per una release futura.

---

## English

Starting from this release, Nostra.chat no longer auto-updates silently. Every update requires your explicit consent.

**What changed**
- On app start, if a new version is available, a popup shows the changelog and asks you to confirm the update.
- Each update is **cross-verified** against 3 independent distribution origins (nostra.chat via Cloudflare, GitHub Releases, IPFS) before being offered.
- New panel in **Settings → Privacy & Security → App Updates** shows your current version, the last integrity check, and a button to force a manual check.
- The Service Worker no longer silently replaces itself in the background.

**What doesn't change**
- Your data is preserved. No reset, no re-onboarding.
- Security model: see `docs/TRUST-MINIMIZED-UPDATES.md` for the full threat model and what Phase A does (and doesn't) protect against.

**Known limits**
- This first Phase A install still happens silently (one time). From this version onward, every subsequent update requires consent.
- Phase A defends against single-CDN compromise. Coordinated compromise of all 3 origins simultaneously is addressed by **Phase C** (maintainer cryptographic signatures) — planned for a future release.
