/* Shared shell: intentionally independent of either application's bundle. */
(() => {
  const preview = location.pathname.startsWith('/preview/');
  const key = 'phantomchat-release-channel';
  const choice = new URL(location.href).searchParams.get('channel');
  let preferred;
  try {
    if(choice === 'stable' || choice === 'preview') localStorage.setItem(key, choice);
    preferred = localStorage.getItem(key);
  } catch { /* Browsing with storage disabled still permits explicit switching. */ }
  if(!preview && preferred === 'preview' && !choice) {
    location.replace('/preview/index.html' + location.search + location.hash);
    return;
  }
  // Keep the installed PWA's original manifest identity, start URL and scope.
  const manifest = document.querySelector('#manifest');
  if(manifest) {
    const canonical = '/site.webmanifest';
    manifest.href = canonical;
    new MutationObserver(() => {
      if(manifest.getAttribute('href') !== canonical) manifest.href = canonical;
    }).observe(manifest, {attributes: true, attributeFilter: ['href']});
  }
  addEventListener('phantomchat-channel-settings', event => {
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Release channel');
    select.title = 'Stable / Preview — both share your identity and local data';
    select.style.cssText = 'max-width:160px;padding:6px;border:1px solid #78818c;border-radius:6px;background:var(--surface-color,#24282e);color:var(--primary-text-color,#eee);font:14px system-ui';
    for(const [value, label] of [['stable', 'Stable'], ['preview', 'Preview']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = preview === (value === 'preview');
      select.append(option);
    }
    select.onchange = () => {
      if(select.value === 'preview' && !confirm('Preview shares your live identity, chats and settings with Stable. Continue?')) {
        select.value = preview ? 'preview' : 'stable';
        return;
      }
      const target = new URL(select.value === 'preview' ? '/preview/index.html' : '/index.html', location.href);
      target.search = location.search;
      target.searchParams.delete('swfix');
      target.searchParams.delete('pc_cb');
      target.searchParams.set('channel', select.value);
      target.hash = location.hash;
      location.assign(target.href);
    };
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px';
    const title = document.createElement('span');
    title.textContent = 'Application channel';
    label.append(title, select);
    event.detail.append(label);
  });
})();
