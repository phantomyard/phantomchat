/*
 * Scan (contacts redesign): find the phantombot personas installed on this PC
 * and add the principal's npub to one's allowlist, through the installed
 * phantombot's own non-interactive CLI (phantombot >= 1.1.475):
 *
 *   phantombot phantomchat --list --json
 *   phantombot phantomchat --persona <p> --allow <npub> --json
 *   phantombot restart              (the daemon reads the list on start)
 *
 * The app never opens a persona directory itself, so the nsec stays where
 * phantombot keeps it. This is a different phantombot from the bundled engine
 * (that one lives under <userData>/phantombot and has its own personas).
 *
 * No Electron import, so vitest drives it with a fake runner.
 */
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {delimiter, join} from 'node:path';

export interface LocalPersona {
  persona: string;
  npub: string | null;
  /** The persona already has a PhantomChat channel set up. */
  phantomchat: boolean;
  /** The principal's npub is already on its allowlist. */
  allowed: boolean;
}

export type ScanFailure = {ok: false; error: {code: 'not_installed' | 'outdated' | 'failed'; message: string}};
export type ScanResult<T> = {ok: true; value: T} | ScanFailure;

export type Runner = (binary: string, args: string[]) => Promise<{code: number; stdout: string; stderr: string}>;

const PERSONA = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const NPUB = /^npub1[02-9ac-hj-np-z]{58}$/;

/** Where the phantombot installers put the binary, then PATH. */
export function phantombotCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  const exe = platform === 'win32' ? 'phantombot.exe' : 'phantombot';
  const out: string[] = [];
  if(env.PHANTOMBOT_INSTALL_DIR) out.push(join(env.PHANTOMBOT_INSTALL_DIR, exe));
  if(platform === 'win32') {
    if(env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'Programs', 'phantombot', exe));
  } else {
    // A GUI launch often has no ~/.local/bin on PATH.
    out.push(join(home, '.local', 'bin', exe), '/usr/local/bin/phantombot', '/opt/homebrew/bin/phantombot');
  }
  for(const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if(dir) out.push(join(dir, exe));
  }
  return [...new Set(out)];
}

export function findPhantombot(candidates: string[], exists: (path: string) => boolean = existsSync): string | undefined {
  return candidates.find((path) => exists(path));
}

export const defaultRunner: Runner = (binary, args) => new Promise((resolve) => {
  execFile(binary, args, {timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024}, (err, stdout, stderr) => {
    const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
    resolve({code, stdout: String(stdout), stderr: String(stderr)});
  });
});

function failed(code: ScanFailure['error']['code'], message: string): ScanFailure {
  return {ok: false, error: {code, message}};
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-3).join('\n').slice(0, 400);
}

/** The first phantombot with `phantomchat --list/--allow --json` (#760). */
export const MIN_PHANTOMBOT = [1, 1, 475] as const;

export function parseVersion(text: string): number[] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function atLeast(version: number[], min: readonly number[]): boolean {
  for(let i = 0; i < min.length; i++) {
    if(version[i] !== min[i]) return version[i] > min[i];
  }
  return true;
}

/**
 * An older phantombot ignores the flags it does not know and would run its
 * interactive setup instead, so the version is checked before anything else.
 */
async function checkVersion(binary: string, run: Runner): Promise<ScanFailure | undefined> {
  const res = await run(binary, ['--version']);
  const version = parseVersion(res.stdout);
  if(res.code !== 0 || !version) return failed('failed', tail(res.stderr) || 'phantombot did not report its version');
  if(!atLeast(version, MIN_PHANTOMBOT)) {
    return failed('outdated', `Update phantombot to ${MIN_PHANTOMBOT.join('.')} or later to use Scan (this PC has ${version.join('.')})`);
  }
}

export async function listLocalPersonas(binary: string | undefined, ownNpub: string, run: Runner = defaultRunner): Promise<ScanResult<LocalPersona[]>> {
  if(!binary) return failed('not_installed', 'phantombot is not installed on this PC');
  const old = await checkVersion(binary, run);
  if(old) return old;
  const res = await run(binary, ['phantomchat', '--list', '--json']);
  let rows: unknown;
  try {
    rows = res.code === 0 ? JSON.parse(res.stdout.trim().split('\n').pop() ?? '') : undefined;
  } catch{
    rows = undefined;
  }
  if(!Array.isArray(rows)) {
    return failed('failed', tail(res.stderr) || 'phantombot did not list its personas');
  }
  const out: LocalPersona[] = [];
  for(const row of rows) {
    if(!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if(typeof r.persona !== 'string' || !PERSONA.test(r.persona)) continue;
    const npub = typeof r.npub === 'string' && NPUB.test(r.npub) ? r.npub : null;
    const allowedNpubs = Array.isArray(r.allowedNpubs) ? r.allowedNpubs : [];
    out.push({persona: r.persona, npub, phantomchat: r.phantomchat === true, allowed: allowedNpubs.includes(ownNpub)});
  }
  return {ok: true, value: out};
}

/**
 * Allow `ownNpub` on `persona`, then restart the installed phantombot so the
 * running daemon answers it. Returns the persona's npub (minted by phantombot
 * when the persona had none) for the new contact.
 */
export async function allowOnLocalPersona(
  binary: string | undefined,
  persona: string,
  ownNpub: string,
  run: Runner = defaultRunner
): Promise<ScanResult<{npub: string; added: boolean; restarted: boolean; restartError?: string}>> {
  if(!binary) return failed('not_installed', 'phantombot is not installed on this PC');
  if(!PERSONA.test(persona)) return failed('failed', 'not a persona name');
  if(!NPUB.test(ownNpub)) return failed('failed', 'not an npub');
  const old = await checkVersion(binary, run);
  if(old) return old;
  const res = await run(binary, ['phantomchat', '--persona', persona, '--allow', ownNpub, '--json']);
  if(res.code !== 0) return failed('failed', tail(res.stderr) || `phantombot exited ${res.code}`);
  // The allow reply carries OUR npub; the persona's comes from a fresh list.
  let added = true;
  try {
    added = JSON.parse(res.stdout.trim().split('\n').pop() ?? '{}').added !== false;
  } catch{}
  const listed = await listLocalPersonas(binary, ownNpub, run);
  const npub = listed.ok ? listed.value.find((p) => p.persona === persona)?.npub : undefined;
  if(!npub) return failed('failed', 'phantombot did not report the persona\'s npub');
  if(!added) return {ok: true, value: {npub, added, restarted: false}};
  const restart = await run(binary, ['restart']);
  return {
    ok: true,
    value: restart.code === 0 ?
      {npub, added, restarted: true} :
      {npub, added, restarted: false, restartError: tail(restart.stderr) || `restart exited ${restart.code}`}
  };
}
