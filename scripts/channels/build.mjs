import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, symlinkSync, rmSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {checkCompatibility, baselineDigestFor} from './check.mjs';
import {stateSmoke} from './state-smoke.mjs';

if(!process.env.npm_execpath) throw new Error('Run this builder with pnpm build (pnpm supplies the package-manager executable).');
const root = process.cwd();
const candidate = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
const config = JSON.parse(readFileSync(process.env.CHANNEL_BASELINE || 'scripts/channels/config.json', 'utf8'));
if(!/^[a-f0-9]{40}$/.test(config.stableRef) || !/^\d+\.\d+\.\d+$/.test(config.stableVersion)) {
  throw new Error('Stable requires an immutable commit SHA and release version');
}
// A deployed PWA baseline is bound to a checksummed archive + authenticated
// release record. Historical local/Electron pins retain their release-tag check.
if(!process.env.CHANNEL_BASELINE) {
  const releasedStable = execFileSync('git', ['rev-parse', `phantomchat-v${config.stableVersion}^{commit}`]).toString().trim();
  if(releasedStable !== config.stableRef) throw new Error('Stable SHA must match its phantomchat-v release tag');
}
checkCompatibility(config, candidate, root, baselineDigestFor(config));
const run = (cmd, args, cwd = root, env = {}) => execFileSync(cmd, args, {cwd, stdio: 'inherit', env: {...process.env, ...env}});
// Scratch is inside this checkout, never a shared /tmp or live profile.
mkdirSync('.channel-build', {recursive: true});
const scratch = mkdtempSync(resolve('.channel-build/run-'));
try {
  const variants = [['stable', config.stableRef], ['preview', candidate]];
  if(process.env.PWA_RELEASE === '1') variants.push(['promotion', candidate]);
  for(const [channel, ref] of variants) {
    const tree = join(scratch, channel);
    mkdirSync(tree);
    const archive = join(scratch, `${channel}.tar`);
    execFileSync('git', ['archive', '--format=tar', '-o', archive, ref]);
    run('tar', ['-xf', archive, '-C', tree]);
    // Reviewed dependency changes get an independent install. Never compile
    // pinned Stable against Preview's newer dependency graph.
    if(readFileSync(join(tree, 'pnpm-lock.yaml'), 'utf8') !== readFileSync('pnpm-lock.yaml', 'utf8')) {
      run(process.execPath, [process.env.npm_execpath, 'install', '--frozen-lockfile', '--ignore-scripts'], tree);
    } else {
      symlinkSync(resolve('node_modules'), join(tree, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    // Infrastructure-only patch shared by BOTH pinned sources. Fail if upstream
    // changes its shape: never silently lose cache isolation.
    const patch = (file, from, to) => {
      const target = join(tree, file);
      const text = readFileSync(target, 'utf8');
      if(!text.includes(from)) throw new Error(`Channel infrastructure patch needs review: ${file}`);
      writeFileSync(target, text.replace(from, to));
    };
    patch('src/lib/serviceWorker/index.service.ts', "event.request.url.indexOf(location.origin + '/') === 0 &&", "event.request.url.indexOf(location.origin + '/') === 0 && new URL(event.request.url).pathname.startsWith('/preview/') === location.pathname.startsWith('/preview/') &&");
    if(channel === 'preview') {
      for(const file of ['src/lib/sessionStorage.ts', 'src/lib/singleInstance.ts', 'src/lib/appManagers/utils/state/loadState.ts', 'src/lib/appManagers/apiManager.ts']) {
        const target = join(tree, file);
        const text = readFileSync(target, 'utf8');
        if(!text.includes('k_build')) throw new Error(`Missing build-marker patch: ${file}`);
        writeFileSync(target, text.replaceAll('k_build', 'k_build_preview'));
      }
    }
    // Share the channel UI with pinned Stable without promoting its app code.
    // Every file listed here must be ABSENT at stableRef (or explicitly
    // approved for this exact pair), because the copy replaces whatever the
    // pinned tree has; a file Stable does not have yet is how the shared tab's
    // imports resolve there at all.
    const sharedChannelFiles = [
      'src/components/sidebarLeft/tabs/phantomchatApplicationUpdates.ts',
      'src/lib/phantomchat/update-channel-choice.ts'
    ];
    for(const file of sharedChannelFiles) {
      mkdirSync(join(tree, file, '..'), {recursive: true});
      writeFileSync(join(tree, file), execFileSync('git', ['show', `${candidate}:${file}`]));
    }
    patch('src/components/sidebarLeft/tabs/settings.ts', "import {hasDesktopUpdateApi} from '@lib/phantomchat/desktop-api';", '');
    patch('src/components/sidebarLeft/tabs/settings.ts', 'if(hasDesktopUpdateApi()) {', 'if(window.phantomchatChannels) {');
    patch('src/components/sidebarLeft/tabs/settings.ts', "await import('@components/sidebarLeft/tabs/phantomchatDesktopUpdates')", "await import('@components/sidebarLeft/tabs/phantomchatApplicationUpdates')");
    const bucket = channel === 'preview' ? 'cachedAssets-preview' : 'cachedAssets-stable';
    patch('src/lib/serviceWorker/cache.ts', "'cachedAssets'", "'" + bucket + "'");
    patch('src/lib/phantomchat/phantomchat-update-checker.ts', 'regs.map((r)', "regs.filter(r => new URL(r.scope).pathname === (location.pathname.startsWith('/preview/') ? '/preview/' : '/')).map((r)");
    patch('src/lib/phantomchat/phantomchat-update-checker.ts', 'keys.map((k)', `keys.filter(k => k === '${bucket}').map((k)`);
    patch('src/lib/apiManagerProxy.ts', 'registration.active && !navigator.serviceWorker.controller', "registration.active && (!navigator.serviceWorker.controller || new URL(navigator.serviceWorker.controller.scriptURL).pathname.startsWith('/preview/') !== location.pathname.startsWith('/preview/'))");
    patch('src/lib/apiManagerProxy.ts', 'const controller = navigator.serviceWorker.controller || registration.installing || registration.waiting || registration.active;', "const current = navigator.serviceWorker.controller; const controller = current && new URL(current.scriptURL).pathname.startsWith('/preview/') === location.pathname.startsWith('/preview/') ? current : registration.installing || registration.waiting || registration.active;");
    // Keep noServiceWorker debugging from unregistering the other channel.
    patch('src/lib/apiManagerProxy.ts', 'for(const reg of regs)', "for(const reg of regs.filter(r => new URL(r.scope).pathname === (location.pathname.startsWith('/preview/') ? '/preview/' : '/')))");
    // Preview publication preserves the verified live Stable bytes. Its source
    // tree is still available below for the cross-version storage fixture.
    if(channel === 'stable' && process.env.PWA_RELEASE === '1' && process.env.CHANNEL_BASELINE) {
      if(!process.env.PWA_STABLE_DIST) throw new Error('Published Stable directory is required');
      cpSync(resolve(process.env.PWA_STABLE_DIST), join(tree, 'dist'), {
        recursive: true, filter: source => source !== resolve(process.env.PWA_STABLE_DIST, 'preview')
      });
      continue;
    }
    run('node', ['src/scripts/generate_changelog.js'], tree);
    run(process.execPath, [process.env.npm_execpath, 'exec', 'vite', 'build', '--mode', 'production'], tree, {NODE_ENV: 'production', APP_VERSION: channel === 'stable' ? (config.stableVersion) : process.env.APP_VERSION || `${config.stableVersion}-preview-local`});
    const out = join(tree, 'dist');
    writeFileSync(join(out, 'channel-switcher.js'), execFileSync('git', ['show', `${candidate}:public/channel-switcher.js`]));
    const html = join(out, 'index.html');
    writeFileSync(html, readFileSync(html, 'utf8').replace('<head>', '<head>\n<script defer src="/channel-switcher.js"></script>'));
  }
  await stateSmoke(join(scratch, 'stable'), join(scratch, 'preview'));
  if(process.env.PWA_RELEASE === '1') {
    rmSync('dist-stable-candidate', {recursive: true, force: true});
    cpSync(join(scratch, 'promotion/dist'), 'dist-stable-candidate', {recursive: true});
  }
  rmSync('dist', {recursive: true, force: true});
  cpSync(join(scratch, 'stable/dist'), 'dist', {recursive: true});
  cpSync(join(scratch, 'preview/dist'), 'dist/preview', {recursive: true});
  writeFileSync('dist/channels.json', JSON.stringify({stable: config.stableRef, preview: candidate}) + '\n');
} finally {
  rmSync(scratch, {recursive: true, force: true});
}
