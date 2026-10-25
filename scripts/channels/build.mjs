import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync, symlinkSync, rmSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {checkCompatibility} from './check.mjs';
import {stateSmoke} from './state-smoke.mjs';

const root = process.cwd();
const config = JSON.parse(readFileSync('scripts/channels/config.json', 'utf8'));
checkCompatibility(config);
const run = (cmd, args, cwd = root, env = {}) => execFileSync(cmd, args, {cwd, stdio: 'inherit', env: {...process.env, ...env}});
// Scratch is inside this checkout, never a shared /tmp or live profile.
mkdirSync('.channel-build', {recursive: true});
const scratch = mkdtempSync(resolve('.channel-build/run-'));
try {
  for(const [channel, ref] of [['stable', config.stableRef], ['preview', 'HEAD']]) {
    const tree = join(scratch, channel);
    mkdirSync(tree);
    const archive = join(scratch, `${channel}.tar`);
    execFileSync('git', ['archive', '--format=tar', '-o', archive, ref]);
    run('tar', ['-xf', archive, '-C', tree]);
    // A different dependency graph cannot silently reuse the other build's dependencies.
    if(readFileSync(join(tree, 'pnpm-lock.yaml'), 'utf8') !== readFileSync('pnpm-lock.yaml', 'utf8')) {
      throw new Error('Stable and Preview dependency locks differ; supply independently installed build environments before releasing.');
    }
    symlinkSync(resolve('node_modules'), join(tree, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
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
    const bucket = channel === 'stable' ? 'cachedAssets-stable' : 'cachedAssets-preview';
    patch('src/lib/serviceWorker/cache.ts', "'cachedAssets'", JSON.stringify(bucket));
    patch('src/lib/phantomchat/phantomchat-update-checker.ts', 'regs.map((r)', "regs.filter(r => new URL(r.scope).pathname === (location.pathname.startsWith('/preview/') ? '/preview/' : '/')).map((r)");
    patch('src/lib/phantomchat/phantomchat-update-checker.ts', 'keys.map((k)', `keys.filter(k => k === '${bucket}').map((k)`);
    patch('src/lib/apiManagerProxy.ts', 'registration.active && !navigator.serviceWorker.controller', "registration.active && (!navigator.serviceWorker.controller || new URL(navigator.serviceWorker.controller.scriptURL).pathname.startsWith('/preview/') !== location.pathname.startsWith('/preview/'))");
    patch('src/lib/apiManagerProxy.ts', 'const controller = navigator.serviceWorker.controller || registration.installing || registration.waiting || registration.active;', "const current = navigator.serviceWorker.controller; const controller = current && new URL(current.scriptURL).pathname.startsWith('/preview/') === location.pathname.startsWith('/preview/') ? current : registration.installing || registration.waiting || registration.active;");
    // Keep noServiceWorker debugging from unregistering the other channel.
    patch('src/lib/apiManagerProxy.ts', 'for(const reg of regs)', "for(const reg of regs.filter(r => new URL(r.scope).pathname === (location.pathname.startsWith('/preview/') ? '/preview/' : '/')))");
    run('node', ['src/scripts/generate_changelog.js'], tree);
    run(process.execPath, [process.env.npm_execpath, 'exec', 'vite', 'build', '--mode', 'production'], tree, {NODE_ENV: 'production', APP_VERSION: channel === 'stable' ? (config.stableVersion) : process.env.APP_VERSION || '1.0.0'});
    const out = join(tree, 'dist');
    cpSync('public/channel-switcher.js', join(out, 'channel-switcher.js'));
    const html = join(out, 'index.html');
    writeFileSync(html, readFileSync(html, 'utf8').replace('<head>', '<head>\n<script defer src="/channel-switcher.js"></script>'));
  }
  await stateSmoke(join(scratch, 'stable'), join(scratch, 'preview'));
  rmSync('dist', {recursive: true, force: true});
  cpSync(join(scratch, 'stable/dist'), 'dist', {recursive: true});
  cpSync(join(scratch, 'preview/dist'), 'dist/preview', {recursive: true});
  writeFileSync('dist/channels.json', JSON.stringify({stable: config.stableRef, preview: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim()}) + '\n');
} finally {
  rmSync(scratch, {recursive: true, force: true});
}
