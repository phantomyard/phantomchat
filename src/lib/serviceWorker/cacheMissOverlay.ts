/*
 * Main-thread overlay for SW cache corruption.
 *
 * When requestCacheStrict (in cache.ts) can't find a shell asset in the
 * CACHE-ONLY precache, the SW posts {type: 'SW_CACHE_MISS', url} to every
 * window client. This listener renders a full-screen overlay prompting the
 * user to reinstall. Reinstall clears all CacheStorage entries and unregisters
 * the SW before reloading.
 *
 * The Nostra identity seed lives in localStorage (`nostra_identity`) and
 * survives both operations, so reinstall is non-destructive for the user.
 *
 * This is the reactive counterpart to the fail-fast install in
 * index.service.ts: the install now rejects on ANY precache miss, so cache
 * corruption should only appear after disk-level tampering or a kill/power
 * loss mid-install. When it does, the overlay gives the user a one-click
 * recovery path instead of a silent chunk-load failure.
 */

let shown = false;

function buildOverlay(url: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.setAttribute('data-cache-miss-overlay', '1');
  wrap.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483647',
    'background:rgba(0,0,0,0.85)',
    'color:#ffffff',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    'padding:2rem',
    'box-sizing:border-box'
  ].join(';');

  const card = document.createElement('div');
  card.style.cssText = [
    'max-width:32rem',
    'width:100%',
    'background:#1e1e1e',
    'border-radius:12px',
    'padding:2rem',
    'box-shadow:0 8px 32px rgba(0,0,0,0.4)',
    'box-sizing:border-box'
  ].join(';');

  const h1 = document.createElement('h1');
  h1.textContent = 'Cache corrotta';
  h1.style.cssText = 'margin:0 0 1rem;font-size:1.5rem;font-weight:600;line-height:1.3';

  const p1 = document.createElement('p');
  p1.textContent = 'Un file dell\'app non è stato trovato nella cache locale. Reinstalla per continuare — la tua identità (seed) è al sicuro.';
  p1.style.cssText = 'margin:0 0 1rem;line-height:1.5';

  const p2 = document.createElement('p');
  p2.style.cssText = 'margin:0 0 1.5rem;font-size:0.85rem;opacity:0.7;word-break:break-all';
  const label = document.createTextNode('Mancante: ');
  const code = document.createElement('code');
  code.textContent = url;
  code.style.cssText = 'background:rgba(255,255,255,0.1);padding:0.15rem 0.4rem;border-radius:4px';
  p2.appendChild(label);
  p2.appendChild(code);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Reinstalla';
  btn.style.cssText = [
    'background:#3390ec',
    'color:#ffffff',
    'border:none',
    'padding:0.75rem 1.5rem',
    'border-radius:8px',
    'font-size:1rem',
    'font-weight:500',
    'cursor:pointer'
  ].join(';');
  btn.addEventListener('click', async() => {
    btn.disabled = true;
    btn.textContent = 'Reinstallazione...';
    try {
      if('caches' in self) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch(err) {
      console.error('[cacheMissOverlay] reinstall cleanup failed', err);
    }
    location.reload();
  });

  card.appendChild(h1);
  card.appendChild(p1);
  card.appendChild(p2);
  card.appendChild(btn);
  wrap.appendChild(card);
  return wrap;
}

function render(url: string): void {
  if(shown) return;
  shown = true;
  const doAppend = () => {
    try {
      const overlay = buildOverlay(url);
      document.body.appendChild(overlay);
    } catch(err) {
      console.error('[cacheMissOverlay] render failed', err);
    }
  };
  if(document.body) {
    doAppend();
  } else {
    document.addEventListener('DOMContentLoaded', doAppend, {once: true});
  }
}

export function initCacheMissOverlay(): void {
  if(!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if(!data || data.type !== 'SW_CACHE_MISS') return;
    render(String(data.url || ''));
  });
}
