/*
 * Compiles the phantombot host (host.ts) into one self-contained binary for
 * the desktop app: electron/dist/phantombot/phantombot-host[.exe].
 *
 * WHICH ENGINE: pin.json names a CHANNEL, not a tag. `{"channel": "latest"}`
 * resolves the phantombot release GitHub marks as Latest, at build time, so a
 * desktop build always bundles an engine the principal has already promoted —
 * there is no version number to remember to bump. A `{tag, commit}` pin is
 * still honoured for a deliberate one-off, and PHANTOMBOT_HOST_REF (+
 * PHANTOMBOT_HOST_COMMIT) overrides both, which is how the release workflow
 * resolves once and hands the same tag+commit to every matrix job.
 *
 * The engine is not an npm install: at v1.1.464 `bun add
 * github:phantomyard/phantombot#<tag>` fails on a local-path stub dependency.
 * So this checks out phantombot at the resolved commit, installs with ITS
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
const pinPath = join(here, 'pin.json');
const repo = process.env.PHANTOMBOT_REPO ?? 'phantomyard/phantombot';
const repoUrl = `https://github.com/${repo}.git`;
const cacheRoot = process.env.PHANTOMBOT_HOST_CACHE ?? join(here, '..', '..', 'node_modules', '.cache', 'phantombot-host');
const outDir = join(here, '..', 'dist', 'phantombot');

export function readPin() {
  return JSON.parse(readFileSync(pinPath, 'utf8'));
}

// Bun is pinned as a series ("1.x") or an exact version. phantombot's own
// release builds with `bun-version: 1.x`, so a series keeps the two in step
// without a number to chase.
export function matchesBun(wanted, found) {
  if(typeof wanted !== 'string' || !wanted) return false;
  if(wanted.endsWith('.x')) return found.startsWith(wanted.slice(0, -1));
  return found === wanted;
}

function tagCommit(tag) {
  const refs = execFileSync('git', ['ls-remote', repoUrl, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {encoding: 'utf8'});
  const byRef = new Map();
  for(const line of refs.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if(sha && ref) byRef.set(ref, sha);
  }
  // An annotated tag resolves to the tag object; ^{} is the commit it names.
  const sha = byRef.get(`refs/tags/${tag}^{}`) ?? byRef.get(`refs/tags/${tag}`);
  if(!sha) throw new Error(`${repo} has no tag ${tag}`);
  return sha;
}

async function latestReleaseTag() {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = {accept: 'application/vnd.github+json', 'user-agent': 'phantomchat-build'};
  if(token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {headers});
  if(!response.ok) {
    throw new Error(`cannot read the latest ${repo} release (HTTP ${response.status}); release it, or set PHANTOMBOT_HOST_REF to a tag`);
  }
  const release = await response.json();
  // Prereleases are never Latest, so this is the promoted ring only.
  if(!release.tag_name) throw new Error(`the latest ${repo} release has no tag`);
  return release.tag_name;
}

/** The engine this build bundles: {tag, commit, bun, channel?, source}. */
export async function resolveEngine() {
  const pin = readPin();
  const forced = process.env.PHANTOMBOT_HOST_REF;
  if(forced) {
    return {
      tag: forced,
      commit: process.env.PHANTOMBOT_HOST_COMMIT || tagCommit(forced),
      bun: pin.bun,
      source: 'PHANTOMBOT_HOST_REF'
    };
  }
  if(pin.tag) {
    if(!pin.commit) throw new Error('pin.json pins a tag but no commit');
    return {tag: pin.tag, commit: pin.commit, bun: pin.bun, source: 'pin.json tag'};
  }
  if(pin.channel !== 'latest') {
    throw new Error(`pin.json names no tag and no channel this build knows (${JSON.stringify(pin.channel)})`);
  }
  const tag = await latestReleaseTag();
  return {tag, commit: tagCommit(tag), bun: pin.bun, channel: 'latest', source: `${repo} latest release`};
}

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

function bunOnPath() {
  try {
    return execFileSync('bun', ['--version'], {encoding: 'utf8', shell: process.platform === 'win32'}).trim();
  } catch{
    throw new Error(`the phantombot host needs Bun ${readPin().bun} on PATH (https://bun.com), or PHANTOMBOT_HOST=skip to build without it`);
  }
}

function ensureCheckout(engine) {
  const checkout = join(cacheRoot, engine.commit);
  if(existsSync(join(checkout, '.phantomchat-ready'))) return checkout;
  rmSync(checkout, {recursive: true, force: true});
  mkdirSync(checkout, {recursive: true});
  git(['init', '-q'], checkout);
  git(['fetch', '-q', '--depth', '1', repoUrl, `refs/tags/${engine.tag}`], checkout);
  git(['checkout', '-q', 'FETCH_HEAD'], checkout);
  // The tag is a moving name; the commit is what this build is.
  const head = git(['rev-parse', 'HEAD'], checkout);
  if(head !== engine.commit) throw new Error(`phantombot ${engine.tag} is ${head}, the build resolved ${engine.commit}`);
  run('bun', ['install', '--frozen-lockfile'], checkout);
  // Bake the version the way phantombot's release does, so the engine reports it.
  const versionFile = join(checkout, 'src', 'version.ts');
  const version = engine.tag.replace(/^v/, '');
  const source = readFileSync(versionFile, 'utf8');
  const placeholder = 'export const VERSION = "0.1.0-dev";';
  if(!source.includes(placeholder)) throw new Error('src/version.ts has no VERSION placeholder');
  writeFileSync(versionFile, source.replace(placeholder, `export const VERSION = "${version}";`));
  writeFileSync(join(checkout, '.phantomchat-ready'), engine.commit + '\n');
  return checkout;
}

export async function buildHost(target = process.env.PHANTOMBOT_HOST_TARGET || bunTarget()) {
  const engine = await resolveEngine();
  const bun = bunOnPath();
  if(!matchesBun(engine.bun, bun)) {
    throw new Error(`phantombot host needs Bun ${engine.bun} (pin.json), found ${bun}`);
  }
  console.log(`phantombot engine ${engine.tag} (${engine.commit}) from ${engine.source}`);
  const checkout = ensureCheckout(engine);
  const hostDir = join(checkout, 'src', 'phantomchat-host');
  rmSync(hostDir, {recursive: true, force: true});
  mkdirSync(hostDir, {recursive: true});
  for(const file of ['host.ts', 'dispatch.ts', 'methods.ts']) cpSync(join(here, file), join(hostDir, file));
  rmSync(outDir, {recursive: true, force: true});
  mkdirSync(outDir, {recursive: true});
  const outfile = join(outDir, hostFileName(target));
  run('bun', ['build', '--compile', `--target=${target}`, './src/phantomchat-host/host.ts', '--outfile', outfile], checkout);
  // What shipped, not what was asked for: the resolved tag and commit go with
  // the binary, so a bug report names the engine without reading a workflow log.
  const shipped = {tag: engine.tag, commit: engine.commit, bun: engine.bun, target};
  if(engine.channel) shipped.channel = engine.channel;
  writeFileSync(join(outDir, 'pin.json'), JSON.stringify(shipped, null, 2) + '\n');
  return outfile;
}

if(process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if(process.argv.includes('--resolve')) {
    console.log(JSON.stringify(await resolveEngine()));
  } else {
    console.log(await buildHost());
  }
}
