/*
 * Compiles the phantombot host (host.ts) into one self-contained binary for
 * the desktop app: electron/dist/phantombot/phantombot-host[.exe].
 *
 * The engine is not an npm install: at v1.1.464 `bun add
 * github:phantomyard/phantombot#<tag>` fails on a local-path stub dependency.
 * So this checks out phantombot at the commit in pin.json, installs with ITS
 * lockfile (the dependency set its own release binaries are built from), drops
 * the three host files into src/phantomchat-host/ and runs `bun build
 * --compile`, as phantombot's release workflow does for its CLI.
 *
 * Target: PHANTOMBOT_HOST_TARGET (a Bun target such as bun-linux-arm64), else
 * this machine's OS with ARCH or the current arch. The packaging jobs set ARCH
 * from their matrix, so the binary always matches the installer it ships in.
 */
import {execFileSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(readFileSync(join(here, 'pin.json'), 'utf8'));
const cacheRoot = process.env.PHANTOMBOT_HOST_CACHE ?? join(here, '..', '..', 'node_modules', '.cache', 'phantombot-host');
const checkout = join(cacheRoot, pin.commit);
const outDir = join(here, '..', 'dist', 'phantombot');

export function bunTarget(platform = process.platform, arch = process.env.ARCH || process.arch) {
  const os = {linux: 'linux', darwin: 'darwin', win32: 'windows'}[platform];
  if(!os) throw new Error(`no phantombot host target for ${platform}`);
  if(arch !== 'x64' && arch !== 'arm64') throw new Error(`no phantombot host target for ${arch}`);
  // Same choice as phantombot's own release: linux x64 uses the baseline build
  // so CPUs without AVX2 still run it.
  return `bun-${os}-${arch}${os === 'linux' && arch === 'x64' ? '-baseline' : ''}`;
}

export function hostFileName(target) {
  return target.startsWith('bun-windows-') ? 'phantombot-host.exe' : 'phantombot-host';
}

function run(cmd, args, cwd) {
  execFileSync(cmd, args, {cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'bun'});
}

function git(args, cwd) {
  return execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();
}

function ensureCheckout() {
  if(existsSync(join(checkout, '.phantomchat-ready'))) return;
  rmSync(checkout, {recursive: true, force: true});
  mkdirSync(checkout, {recursive: true});
  git(['init', '-q'], checkout);
  git(['fetch', '-q', '--depth', '1', 'https://github.com/phantomyard/phantombot.git', `refs/tags/${pin.tag}`], checkout);
  git(['checkout', '-q', 'FETCH_HEAD'], checkout);
  // The tag is a moving name; the commit is the pin.
  const head = git(['rev-parse', 'HEAD'], checkout);
  if(head !== pin.commit) throw new Error(`phantombot ${pin.tag} is ${head}, pin.json expects ${pin.commit}`);
  run('bun', ['install', '--frozen-lockfile'], checkout);
  // Bake the version the way phantombot's release does, so the engine reports it.
  const versionFile = join(checkout, 'src', 'version.ts');
  const version = pin.tag.replace(/^v/, '');
  const source = readFileSync(versionFile, 'utf8');
  const placeholder = 'export const VERSION = "0.1.0-dev";';
  if(!source.includes(placeholder)) throw new Error('src/version.ts has no VERSION placeholder');
  writeFileSync(versionFile, source.replace(placeholder, `export const VERSION = "${version}";`));
  writeFileSync(join(checkout, '.phantomchat-ready'), pin.commit + '\n');
}

export function buildHost(target = process.env.PHANTOMBOT_HOST_TARGET || bunTarget()) {
  let bun;
  try {
    bun = execFileSync('bun', ['--version'], {encoding: 'utf8', shell: process.platform === 'win32'}).trim();
  } catch{
    throw new Error(`the phantombot host needs Bun ${pin.bun} on PATH (https://bun.com), or PHANTOMBOT_HOST=skip to build without it`);
  }
  if(bun !== pin.bun) throw new Error(`phantombot host needs Bun ${pin.bun} (pin.json), found ${bun}`);
  ensureCheckout();
  const hostDir = join(checkout, 'src', 'phantomchat-host');
  rmSync(hostDir, {recursive: true, force: true});
  mkdirSync(hostDir, {recursive: true});
  for(const file of ['host.ts', 'dispatch.ts', 'methods.ts']) cpSync(join(here, file), join(hostDir, file));
  rmSync(outDir, {recursive: true, force: true});
  mkdirSync(outDir, {recursive: true});
  const outfile = join(outDir, hostFileName(target));
  run('bun', ['build', '--compile', `--target=${target}`, './src/phantomchat-host/host.ts', '--outfile', outfile], checkout);
  writeFileSync(join(outDir, 'pin.json'), JSON.stringify({...pin, target}, null, 2) + '\n');
  return outfile;
}

if(process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(buildHost());
}
