/*
 * First-launch bootstrap, shipped inside the signed app. It shows until the live
 * frontend has been fetched once, and again if that local copy is ever gone
 * while the network is down.
 *
 * It is also how an existing install moves onto the thin shell. Identity,
 * phantoms, history and settings already sit on this app:// origin and carry over
 * as they are, so this page must never write to browser storage. The new frontend
 * replaces the old bundle's service worker when it registers its own.
 */
export const SPLASH_PATH = '/__shell/splash.html';
export const READY_PATH = '/__shell/ready';

export const SPLASH_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>PhantomChat</title>
<style>
  :root {color-scheme: light dark;}
  body {margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; font: 15px system-ui, sans-serif; text-align: center; padding: 0 24px; box-sizing: border-box;}
  h1 {font-size: 20px; font-weight: 600; margin: 0 0 8px;}
  p {margin: 0 0 16px; opacity: .7;}
  button {font: inherit; padding: 8px 18px; cursor: pointer;}
  [hidden] {display: none;}
</style>
</head>
<body>
<h1 id="title">Looking for updates…</h1>
<p id="detail">Getting PhantomChat ready. This only happens the first time.</p>
<button id="retry" type="button" hidden>Try again</button>
<script>
  const target = location.pathname === '${SPLASH_PATH}' ? '/index.html' : location.href;
  const title = document.getElementById('title');
  const detail = document.getElementById('detail');
  const retry = document.getElementById('retry');
  let timer;
  async function attempt() {
    clearTimeout(timer);
    try {
      const response = await fetch('${READY_PATH}', {cache: 'no-store'});
      if(response.ok) {
        location.replace(target);
        return;
      }
    } catch{}
    title.textContent = 'No connection';
    detail.textContent = 'PhantomChat needs the internet to finish getting ready. Anything already on this device is safe. Retrying…';
    retry.hidden = false;
    timer = setTimeout(attempt, 5000);
  }
  retry.addEventListener('click', attempt);
  attempt();
</script>
</body>
</html>
`;
