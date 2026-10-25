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
  // Presentation lives in the app's own Settings components, shared by the
  // builder with pinned Stable. This shell owns only routing and preference.
  window.phantomchatChannels = Object.freeze({
    current: preview ? 'preview' : 'stable',
    choose(channel) {
      if(channel !== 'stable' && channel !== 'preview') return false;
      if(channel === (preview ? 'preview' : 'stable')) return true;
      if(channel === 'preview' && !confirm('Preview shares your live identity, chats and settings with Stable. Continue?')) return false;
      const target = new URL(channel === 'preview' ? '/preview/index.html' : '/index.html', location.href);
      target.search = location.search;
      target.searchParams.delete('swfix');
      target.searchParams.delete('pc_cb');
      target.searchParams.set('channel', channel);
      target.hash = location.hash;
      location.assign(target.href);
      return true;
    }
  });
})();
