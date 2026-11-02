/*
 * The embedded agent runtime (issue #276): providers, models and sessions.
 *
 * Loaded on first use, so the app starts no slower for someone who never uses
 * it. Everything lives under the app's own folder: PI_CODING_AGENT_DIR is pointed
 * there before the first import, because the runtime also keeps helper binaries
 * under that directory, and explicit paths alone would not move them. A
 * standalone install on the same machine is neither read nor changed.
 */
import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  buildProviderEntry, fetchGatewayModels, normalizeBaseUrl, OPENAI_COMPATIBLE_PROVIDER, PHANTOMOPS_AUTO_MODEL,
  PHANTOMOPS_BASE_URL, PHANTOMOPS_PROVIDER, type GatewayModel, type ModelsJsonEntry
} from './customProviders';
import {errorText} from './scrub';

/* eslint-disable @typescript-eslint/no-explicit-any -- the SDK is loaded at runtime from outside this bundle */

export const AGENT_TOOLS = ['read', 'bash', 'edit', 'write', 'ls', 'find', 'grep'];

export interface ProviderView {
  id: string;
  name: string;
  configured: boolean;
  /** Where the credential comes from: 'stored', 'environment', and so on. */
  source: string | null;
  featured: boolean;
  custom: boolean;
  canUseKey: boolean;
  canUseOAuth: boolean;
  baseUrl: string | null;
}

export interface ModelChoice {
  /** `<provider>/<model>`, the value stored on the contact. */
  value: string;
  label: string;
  provider: string;
  providerName: string;
}

export interface EffortChoices {
  levels: string[];
  /** False means the picker is greyed out. */
  enabled: boolean;
}

export interface AuthPromptRequest {
  message: string;
  placeholder?: string;
  secret: boolean;
}

export interface PiRuntimeOptions {
  sdkPath: string;
  dataDir: string;
  phantomOpsBaseUrl?: string;
  openExternal(url: string): void;
  askUser(request: AuthPromptRequest): Promise<string>;
  home?: string;
}

export function modelValue(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** `<provider>/<model>`. Model ids contain slashes themselves, the provider never does. */
export function splitModelValue(value: string): {provider: string; model: string} | null {
  const at = value.indexOf('/');
  if(at <= 0 || at === value.length - 1) return null;
  return {provider: value.slice(0, at), model: value.slice(at + 1)};
}

export class PiRuntime {
  private sdkPromise?: Promise<any>;
  private runtimePromise?: Promise<any>;
  readonly agentDir: string;
  private readonly home: string;

  constructor(private readonly options: PiRuntimeOptions) {
    this.agentDir = join(options.dataDir, 'pi-agent');
    this.home = options.home ?? homedir();
  }

  private get modelsPath(): string {
    return join(this.agentDir, 'models.json');
  }

  private get phantomOpsBaseUrl(): string {
    return this.options.phantomOpsBaseUrl ?? PHANTOMOPS_BASE_URL;
  }

  sdk(): Promise<any> {
    if(!this.sdkPromise) {
      mkdirSync(this.agentDir, {recursive: true, mode: 0o700});
      process.env.PI_CODING_AGENT_DIR = this.agentDir;
      this.sdkPromise = import(pathToFileURL(this.options.sdkPath).href);
      this.sdkPromise.catch(() => {
        this.sdkPromise = undefined;
      });
    }
    return this.sdkPromise;
  }

  private runtime(): Promise<any> {
    if(!this.runtimePromise) {
      this.runtimePromise = this.sdk().then((sdk) => sdk.ModelRuntime.create({
        authPath: join(this.agentDir, 'auth.json'),
        modelsPath: this.modelsPath
      }));
      this.runtimePromise.catch(() => {
        this.runtimePromise = undefined;
      });
    }
    return this.runtimePromise;
  }

  /** models.json is read when the runtime is created, so a write means a new one. */
  private resetRuntime(): void {
    this.runtimePromise = undefined;
  }

  private readModelsJson(): {providers: Record<string, ModelsJsonEntry>} {
    try {
      const parsed = JSON.parse(readFileSync(this.modelsPath, 'utf8'));
      return {providers: parsed?.providers && typeof parsed.providers === 'object' ? parsed.providers : {}};
    } catch{
      return {providers: {}};
    }
  }

  private writeModelsJson(file: {providers: Record<string, ModelsJsonEntry>}): void {
    mkdirSync(dirname(this.modelsPath), {recursive: true, mode: 0o700});
    const temp = this.modelsPath + '.tmp';
    writeFileSync(temp, JSON.stringify(file, null, 2), {mode: 0o600});
    renameSync(temp, this.modelsPath);
    this.resetRuntime();
  }

  private setCustomProvider(id: string, entry: ModelsJsonEntry): void {
    const file = this.readModelsJson();
    file.providers[id] = entry;
    this.writeModelsJson(file);
  }

  private async storeKey(provider: string, key: string): Promise<void> {
    const rt = await this.runtime();
    await rt.login(provider, 'api_key', {
      prompt: async() => key,
      notify: () => {}
    });
  }

  async listProviders(): Promise<ProviderView[]> {
    const rt = await this.runtime();
    const custom = this.readModelsJson().providers;
    const views: ProviderView[] = rt.getProviders()
    .filter((provider: any) => provider.id !== PHANTOMOPS_PROVIDER && provider.id !== OPENAI_COMPATIBLE_PROVIDER)
    .map((provider: any) => {
      const status = rt.getProviderAuthStatus(provider.id);
      return {
        id: provider.id,
        name: provider.name ?? provider.id,
        configured: !!status?.configured,
        source: status?.source ?? null,
        featured: false,
        custom: false,
        canUseKey: !!provider.auth?.apiKey?.login,
        canUseOAuth: !!provider.auth?.oauth,
        baseUrl: null
      };
    })
    .sort((a: ProviderView, b: ProviderView) => a.name.localeCompare(b.name));

    const customView = (id: string, name: string, featured: boolean): ProviderView => {
      const status = custom[id] ? rt.getProviderAuthStatus(id) : undefined;
      return {
        id,
        name,
        configured: !!status?.configured,
        source: status?.source ?? null,
        featured,
        custom: true,
        canUseKey: true,
        canUseOAuth: false,
        baseUrl: custom[id]?.baseUrl ?? null
      };
    };
    return [
      customView(PHANTOMOPS_PROVIDER, 'PhantomOps', true),
      customView(OPENAI_COMPATIBLE_PROVIDER, 'OpenAI-Compatible', false),
      ...views
    ];
  }

  /** PhantomOps needs only the token: the endpoint is fixed. */
  async configurePhantomOps(token: string): Promise<void> {
    const key = token.trim();
    if(!key) throw new Error('A PhantomOps token is required');
    const models = await fetchGatewayModels(this.phantomOpsBaseUrl, key);
    this.setCustomProvider(PHANTOMOPS_PROVIDER, buildProviderEntry({
      baseUrl: this.phantomOpsBaseUrl,
      models: models ?? [],
      defaultModel: PHANTOMOPS_AUTO_MODEL,
      keyless: false
    }));
    await this.storeKey(PHANTOMOPS_PROVIDER, key);
  }

  /** A self-hosted server may have no key at all. */
  async configureOpenAiCompatible(rawBaseUrl: string, rawKey: string, rawModel: string): Promise<void> {
    const baseUrl = normalizeBaseUrl(rawBaseUrl);
    if(!baseUrl) throw new Error('The base URL must start with http:// or https://');
    const key = rawKey.trim();
    const listed = await fetchGatewayModels(baseUrl, key || undefined);
    const models = listed?.length ? listed : [];
    const model = rawModel.trim();
    if(model && !models.some((m) => m.id === model)) models.unshift({id: model, efforts: []});
    if(!models.length) throw new Error('No models found at that URL. Enter a model name.');
    this.setCustomProvider(OPENAI_COMPATIBLE_PROVIDER, buildProviderEntry({baseUrl, models, keyless: !key}));
    if(key) await this.storeKey(OPENAI_COMPATIBLE_PROVIDER, key);
  }

  async setApiKey(provider: string, key: string): Promise<void> {
    if(!key.trim()) throw new Error('An API key is required');
    await this.storeKey(provider, key.trim());
  }

  /** Browser sign-in, for the providers that support it. */
  async signIn(provider: string): Promise<void> {
    const rt = await this.runtime();
    await rt.login(provider, 'oauth', {
      prompt: async(prompt: any) => {
        if(prompt?.type === 'select') {
          const options: {id: string; label: string}[] = prompt.options ?? [];
          if(options.length === 1) return options[0].id;
          const list = options.map((option, i) => `${i + 1}. ${option.label}`).join('\n');
          const answer = await this.options.askUser({message: `${prompt.message}\n${list}\nEnter a number.`, secret: false});
          return options[Number(answer) - 1]?.id ?? options[0]?.id ?? '';
        }
        return this.options.askUser({
          message: String(prompt?.message ?? 'Enter the code'),
          placeholder: prompt?.placeholder,
          secret: prompt?.type === 'secret'
        });
      },
      notify: (event: any) => {
        if(event?.type === 'auth_url') {
          this.options.openExternal(event.url);
        } else if(event?.type === 'device_code') {
          this.options.openExternal(event.verificationUri);
          void this.options.askUser({message: `Enter this code in your browser: ${event.userCode}`, secret: false}).catch(() => {});
        }
      }
    });
  }

  async removeProvider(provider: string): Promise<void> {
    const rt = await this.runtime();
    await rt.logout(provider).catch(() => {});
    const file = this.readModelsJson();
    if(file.providers[provider]) {
      delete file.providers[provider];
      this.writeModelsJson(file);
    }
  }

  async hasConfiguredProvider(): Promise<boolean> {
    const rt = await this.runtime();
    return (await rt.getAvailable()).length > 0;
  }

  /** Models from configured providers only. */
  async listModels(): Promise<ModelChoice[]> {
    const rt = await this.runtime();
    await this.refreshGatewayModels(rt);
    const runtime = await this.runtime();
    const available: any[] = [...await runtime.getAvailable()];
    const rank = (m: any) => (m.provider === PHANTOMOPS_PROVIDER ? 0 : 1);
    return available
    .sort((a, b) => rank(a) - rank(b) || String(a.provider).localeCompare(String(b.provider)))
    .map((m) => ({
      value: modelValue(m.provider, m.id),
      label: m.name ?? m.id,
      provider: m.provider,
      providerName: runtime.getProvider(m.provider)?.name ?? m.provider
    }));
  }

  /** The gateway's list is the truth, and it changes without an app release. */
  private async refreshGatewayModels(rt: any): Promise<GatewayModel[] | null> {
    const entry = this.readModelsJson().providers[PHANTOMOPS_PROVIDER];
    if(!entry) return null;
    const key = await rt.getAuth(PHANTOMOPS_PROVIDER).then((auth: any) => auth?.apiKey).catch((): undefined => undefined);
    const models = await fetchGatewayModels(entry.baseUrl, key);
    if(!models) return null;
    const next = buildProviderEntry({
      baseUrl: entry.baseUrl,
      models,
      defaultModel: PHANTOMOPS_AUTO_MODEL,
      keyless: false
    });
    if(JSON.stringify(next) !== JSON.stringify(entry)) this.setCustomProvider(PHANTOMOPS_PROVIDER, next);
    return models;
  }

  /**
   * Effort levels for one model. PhantomOps is asked directly, so the picker stays
   * grey when the gateway gives no answer and starts working once it does.
   */
  async effortChoices(value: string | null): Promise<EffortChoices> {
    const model = await this.resolveModel(value);
    if(!model) return {levels: [], enabled: false};
    if(model.provider === PHANTOMOPS_PROVIDER) {
      const models = await this.refreshGatewayModels(await this.runtime());
      const efforts = models?.find((m) => m.id === model.id)?.efforts ?? [];
      return {levels: efforts, enabled: efforts.length > 0};
    }
    const sdk = await this.sdk();
    const {session} = await this.createSession({
      model,
      effort: null,
      systemPrompt: '',
      sessionManager: sdk.SessionManager.inMemory(this.home)
    });
    try {
      const levels: string[] = session.getAvailableThinkingLevels();
      return {levels, enabled: levels.length > 1};
    } finally {
      session.dispose();
    }
  }

  /** The stored choice, else `phantomops/auto`, else the first available model. */
  async resolveModel(value: string | null): Promise<any | undefined> {
    const rt = await this.runtime();
    const available: any[] = [...await rt.getAvailable()];
    if(value) {
      const parts = splitModelValue(value);
      const stored = parts && available.find((m) => m.provider === parts.provider && m.id === parts.model);
      if(stored) return stored;
    }
    return available.find((m) => m.provider === PHANTOMOPS_PROVIDER && m.id === PHANTOMOPS_AUTO_MODEL) ?? available[0];
  }

  private async createSession(input: {
    model: any;
    effort: string | null;
    systemPrompt: string;
    sessionManager: any;
  }): Promise<{session: any}> {
    const sdk = await this.sdk();
    const settingsManager = sdk.SettingsManager.inMemory({compaction: {enabled: true}, retry: {enabled: true, maxRetries: 2}});
    // No discovery of any kind: home is the working folder, and a standalone
    // install keeps its settings, skills and instructions under it.
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: this.home,
      agentDir: this.agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: input.systemPrompt
    });
    await resourceLoader.reload();
    return sdk.createAgentSession({
      cwd: this.home,
      agentDir: this.agentDir,
      modelRuntime: await this.runtime(),
      model: input.model,
      thinkingLevel: input.effort ?? 'off',
      resourceLoader,
      settingsManager,
      sessionManager: input.sessionManager,
      tools: AGENT_TOOLS
    });
  }

  /** One message into one chat. The session file is the chat's memory. */
  async prompt(input: {
    sessionDir: string;
    model: string | null;
    effort: string | null;
    systemPrompt: string;
    text: string;
  }): Promise<{ok: true; text: string} | {ok: false; error: string}> {
    let session: any;
    try {
      const model = await this.resolveModel(input.model);
      if(!model) return {ok: false, error: 'No AI provider is set up. Add one in Settings, on the PC hosting me.'};
      const sdk = await this.sdk();
      mkdirSync(input.sessionDir, {recursive: true, mode: 0o700});
      ({session} = await this.createSession({
        model,
        effort: input.effort,
        systemPrompt: input.systemPrompt,
        sessionManager: sdk.SessionManager.continueRecent(this.home, input.sessionDir)
      }));
      await session.prompt(input.text);
      const last = session.messages[session.messages.length - 1];
      if(last?.stopReason === 'error' || last?.errorMessage) {
        return {ok: false, error: errorText(last.errorMessage ?? 'The provider returned an error')};
      }
      return {ok: true, text: session.getLastAssistantText() ?? ''};
    } catch(err) {
      return {ok: false, error: errorText(err)};
    } finally {
      session?.dispose();
    }
  }

  /** Where one chat's session files live. Hashed, so a chat id can never be a path. */
  sessionDir(contactPubkey: string, chatKey: string): string {
    const hashed = createHash('sha256').update(chatKey).digest('hex').slice(0, 32);
    return join(this.agentDir, 'sessions', 'external-ai', contactPubkey, hashed);
  }

  deleteContactHistory(contactPubkey: string): void {
    rmSync(join(this.agentDir, 'sessions', 'external-ai', contactPubkey), {recursive: true, force: true});
  }

  /** One tool, on its own, with no provider and no agent loop. */
  async tool(name: string): Promise<any> {
    const sdk = await this.sdk();
    const factories: Record<string, (cwd: string) => any> = {
      bash: sdk.createBashTool,
      read: sdk.createReadTool,
      write: sdk.createWriteTool,
      edit: sdk.createEditTool,
      ls: sdk.createLsTool,
      find: sdk.createFindTool,
      grep: sdk.createGrepTool
    };
    return factories[name](this.home);
  }
}
