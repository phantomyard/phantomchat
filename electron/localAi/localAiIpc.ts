/*
 * IPC for the embed (issue #276). The renderer is live-served, so every argument
 * is checked here, and a call from a frame outside the app's own origin gets
 * nothing. The Allow and delete dialogs are native, shown and answered in main.
 */
import {app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent} from 'electron';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {piSdkPath} from '../piHarness';
import {isHexPubkey} from './localAccess';
import {LocalAiHost} from './localAiHost';
import {errorText} from './scrub';

function isAppFrame(event: IpcMainInvokeEvent, devUrl?: string): boolean {
  const url = event.senderFrame?.url ?? '';
  return url.startsWith('app://') || (!!devUrl && url.startsWith(devUrl));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A readable failure for the settings screen, free of the runtime's name. */
async function outcome<T>(run: () => Promise<T>): Promise<{ok: true; value: T} | {ok: false; error: string}> {
  try {
    return {ok: true, value: await run()};
  } catch(err) {
    return {ok: false, error: errorText(err)};
  }
}

export function createLocalAiHost(getWindow: () => BrowserWindow | null, bundleDir: string): LocalAiHost {
  const ask = async(options: Electron.MessageBoxOptions): Promise<boolean> => {
    const win = getWindow();
    const {response} = await (win && !win.isDestroyed() ?
      dialog.showMessageBox(win, options) :
      dialog.showMessageBox(options));
    return response === 0;
  };

  return new LocalAiHost({
    dataDir: join(app.getPath('userData'), 'local-ai'),
    sdkPath: piSdkPath(app.isPackaged, process.resourcesPath, bundleDir),
    phantomOpsBaseUrl: app.isPackaged ? undefined : process.env.PHANTOMCHAT_PHANTOMOPS_BASE_URL,
    openExternal: (url) => {
      try {
        if(new URL(url).protocol === 'https:') void shell.openExternal(url);
      } catch{ /* ignore malformed targets */ }
    },
    emit: (event) => {
      const win = getWindow();
      if(win && !win.isDestroyed()) win.webContents.send('desktop:local-ai-event', event);
    },
    confirmLocalAccess: (name) => ask({
      type: 'warning',
      message: `Allow ${name} to use this PC?`,
      detail: `${name} will be able to run commands and read and change any file on this PC, without asking again. You can turn this off at any time in contact info.`,
      buttons: ['Allow', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    }),
    confirmDeleteExternalAi: (name) => ask({
      type: 'warning',
      message: `Delete ${name}?`,
      detail: 'This destroys its identity and all of its history on this PC, and cannot be undone. Its contact will no longer answer on any device.',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
  });
}

/** Exit status of loading the SDK and running one tool with no provider. */
export async function runPiEmbedProbe(bundleDir: string): Promise<number> {
  const dataDir = mkdtempSync(join(tmpdir(), 'phantomchat-embed-probe-'));
  try {
    const host = new LocalAiHost({
      dataDir,
      sdkPath: piSdkPath(app.isPackaged, process.resourcesPath, bundleDir),
      home: dataDir,
      openExternal: () => {},
      confirmLocalAccess: async() => false,
      confirmDeleteExternalAi: async() => false,
      emit: () => {}
    });
    const providers = await host.listProviders();
    const tool = await host.pi.tool('bash');
    const result = await tool.execute('probe', {command: 'echo embed-ok'}, new AbortController().signal, () => {});
    const ok = providers.length > 2 && JSON.stringify(result).includes('embed-ok');
    process.stdout.write(`embed probe: ${providers.length} providers, tool ${ok ? 'ok' : 'failed'}\n`);
    return ok ? 0 : 1;
  } catch(err) {
    process.stderr.write(`embed probe failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    return 1;
  } finally {
    rmSync(dataDir, {recursive: true, force: true});
  }
}

export function registerLocalAiIpc(host: LocalAiHost, devUrl?: string): void {
  const handle = (channel: string, fn: (...args: any[]) => unknown, fallback: unknown = null) => {
    ipcMain.handle(`desktop:local-ai:${channel}`, (event, ...args) => {
      if(!isAppFrame(event, devUrl)) return fallback;
      return fn(...args);
    });
  };

  handle('set-context', (owner: unknown, relays: unknown) => {
    if(!isHexPubkey(owner) || !Array.isArray(relays)) return;
    host.setContext(owner, relays.filter((relay): relay is string => typeof relay === 'string'));
  });

  handle('list-providers', () => outcome(() => host.listProviders()));
  handle('configure-phantomops', (token: unknown) => outcome(() => host.pi.configurePhantomOps(text(token))));
  handle('configure-openai-compatible', (baseUrl: unknown, key: unknown, model: unknown) =>
    outcome(() => host.pi.configureOpenAiCompatible(text(baseUrl), text(key), text(model))));
  handle('set-provider-key', (provider: unknown, key: unknown) => outcome(() => host.pi.setApiKey(text(provider), text(key))));
  handle('sign-in', (provider: unknown) => outcome(() => host.pi.signIn(text(provider))));
  handle('remove-provider', (provider: unknown) => outcome(() => host.pi.removeProvider(text(provider))));
  handle('answer-auth-prompt', (id: unknown, value: unknown) => {
    host.answerAuthPrompt(text(id), typeof value === 'string' ? value : null);
  });

  handle('list-external-ai', () => host.listExternalAi(), []);
  handle('create-external-ai', () => outcome(async() => host.createExternalAi()));
  handle('create-first-external-ai', () => outcome(() => host.createFirstExternalAi()));
  handle('greet-external-ai', (pubkey: unknown) => host.greetExternalAi(text(pubkey)));
  handle('update-external-ai', (pubkey: unknown, change: unknown) =>
    host.updateExternalAi(text(pubkey), (change ?? {}) as Record<string, unknown>));
  handle('delete-external-ai', (pubkey: unknown) => host.deleteExternalAi(text(pubkey)), false);
  handle('model-choices', () => outcome(() => host.modelChoices()));
  handle('effort-choices', (model: unknown) => outcome(() => host.effortChoices(typeof model === 'string' ? model : null)));

  handle('local-access-enabled', () => host.localAccessEnabled(), []);
  handle('capability', () => host.capabilityMessage());
  handle('set-local-access', (pubkey: unknown, on: unknown, name: unknown) =>
    host.setLocalAccess(text(pubkey), on === true, text(name).slice(0, 140) || 'This contact'), {enabled: false, notify: null});
  handle('tool-message', (sender: unknown, payload: unknown, group: unknown) => {
    const info = group && typeof group === 'object' ? group as {isSession?: unknown; members?: unknown} : null;
    return host.handleToolMessage(text(sender), payload, info && Array.isArray(info.members) ? {
      isSession: info.isSession === true,
      members: info.members.filter((member): member is string => typeof member === 'string')
    } : null);
  }, []);
}
