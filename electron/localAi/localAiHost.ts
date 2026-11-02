/*
 * The one embed behind both #276 features: External AI contacts and local tools
 * for remote phantoms. No Electron imports: localAiIpc.ts passes in what it needs,
 * so this can be run under plain Node against a real runtime.
 */
import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync} from 'node:fs';
import {hostname} from 'node:os';
import {join} from 'node:path';
import {ExternalAiContact} from './externalAiContact';
import {ExternalAiStore, toView, writePrivateJson, type ExternalAiRecord, type ExternalAiView} from './externalAiStore';
import {
  decideToolCall, isEnabled, isHexPubkey, LOCAL_ACCESS_FILE, LOCAL_TOOL_NAMES, parseLocalAccess, parseToolCall,
  rememberCall, setOwner, type CallGroupInfo, type LocalAccessState
} from './localAccess';
import {LocalToolRunner} from './localTools';
import {PiRuntime, type AuthPromptRequest, type EffortChoices, type ModelChoice, type ProviderView} from './piRuntime';
import {NostrRelayLink, type RelayLink} from './relayLink';
import {chunkResult, type ToolMessage} from './toolProtocol';

export interface LocalAiHostOptions {
  dataDir: string;
  sdkPath: string;
  phantomOpsBaseUrl?: string;
  home?: string;
  openExternal(url: string): void;
  /** Native dialogs live in main. Both resolve to true only on an explicit yes. */
  confirmLocalAccess(contactName: string): Promise<boolean>;
  confirmDeleteExternalAi(contactName: string): Promise<boolean>;
  emit(event: LocalAiEvent): void;
  createLink?(record: ExternalAiRecord, relays: string[]): RelayLink;
  now?: () => number;
}

export type LocalAiEvent =
  | {type: 'tools-activity'; running: number}
  | ({type: 'auth-prompt'; id: string} & AuthPromptRequest);

export class LocalAiHost {
  readonly pi: PiRuntime;
  private readonly store: ExternalAiStore;
  private readonly runner: LocalToolRunner;
  private readonly accessPath: string;
  private readonly contacts = new Map<string, ExternalAiContact>();
  private readonly authPrompts = new Map<string, {resolve(value: string): void; reject(err: Error): void}>();
  private access: LocalAccessState;
  private relays: string[] = [];

  constructor(private readonly options: LocalAiHostOptions) {
    mkdirSync(options.dataDir, {recursive: true, mode: 0o700});
    this.accessPath = join(options.dataDir, LOCAL_ACCESS_FILE);
    this.access = this.loadAccess();
    this.store = new ExternalAiStore(join(options.dataDir, 'external-ai'));
    this.pi = new PiRuntime({
      sdkPath: options.sdkPath,
      dataDir: options.dataDir,
      phantomOpsBaseUrl: options.phantomOpsBaseUrl,
      home: options.home,
      openExternal: options.openExternal,
      askUser: (request) => this.askUser(request)
    });
    this.runner = new LocalToolRunner({
      resolveTool: (name) => this.pi.tool(name),
      logPath: join(options.dataDir, 'local-tools.log'),
      onActivity: (running) => options.emit({type: 'tools-activity', running})
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private loadAccess(): LocalAccessState {
    const newId = () => randomBytes(16).toString('hex');
    try {
      return parseLocalAccess(JSON.parse(readFileSync(this.accessPath, 'utf8')), newId);
    } catch{
      return parseLocalAccess({}, newId);
    }
  }

  private saveAccess(): void {
    writePrivateJson(this.accessPath, this.access);
  }

  /** Who is signed in and which relays to use. Set by the renderer on every launch. */
  setContext(ownerPubkey: string, relays: string[]): void {
    if(!isHexPubkey(ownerPubkey)) return;
    const ownerChanged = this.access.ownerPubkey !== ownerPubkey;
    setOwner(this.access, ownerPubkey);
    this.saveAccess();
    this.relays = relays.filter((relay) => /^wss?:\/\//.test(relay)).slice(0, 32);

    if(ownerChanged) this.stopContacts();
    for(const contact of this.contacts.values()) contact.setRelays(this.relays);
    if(!this.relays.length) return;
    for(const record of this.store.list(ownerPubkey)) this.startContact(record);
  }

  private startContact(record: ExternalAiRecord): void {
    if(this.contacts.has(record.pubkey)) return;
    const link = this.options.createLink?.(record, this.relays) ??
      new NostrRelayLink(record.pubkey, Uint8Array.from(Buffer.from(record.secretKey, 'hex')), this.relays);
    const contact = new ExternalAiContact({
      record,
      ownerPubkey: record.ownerPubkey,
      dir: this.store.contactDir(record.pubkey),
      link,
      log: (...args) => console.error(...args),
      runPrompt: ({record: current, chatKey, text, systemPrompt}) => this.pi.prompt({
        sessionDir: this.pi.sessionDir(current.pubkey, chatKey),
        model: current.model,
        effort: current.effort,
        systemPrompt,
        text
      })
    });
    this.contacts.set(record.pubkey, contact);
    contact.start();
  }

  private stopContacts(): void {
    for(const contact of this.contacts.values()) contact.stop();
    this.contacts.clear();
  }

  shutdown(): void {
    this.stopContacts();
  }

  // --- Providers ------------------------------------------------------------

  listProviders(): Promise<ProviderView[]> {
    return this.pi.listProviders();
  }

  private askUser(request: AuthPromptRequest): Promise<string> {
    const id = randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      this.authPrompts.set(id, {resolve, reject});
      this.options.emit({type: 'auth-prompt', id, ...request});
    });
  }

  answerAuthPrompt(id: string, value: string | null): void {
    const pending = this.authPrompts.get(id);
    if(!pending) return;
    this.authPrompts.delete(id);
    if(value === null) pending.reject(new Error('Cancelled'));
    else pending.resolve(value);
  }

  // --- External AI ----------------------------------------------------------

  private owner(): string {
    if(!this.access.ownerPubkey) throw new Error('Not signed in');
    return this.access.ownerPubkey;
  }

  listExternalAi(): ExternalAiView[] {
    return this.access.ownerPubkey ? this.store.list(this.access.ownerPubkey).map(toView) : [];
  }

  isHosted(pubkey: string): boolean {
    const record = this.store.get(pubkey);
    return !!record && record.ownerPubkey === this.access.ownerPubkey;
  }

  createExternalAi(): ExternalAiView {
    const record = this.store.create(this.owner(), this.now());
    if(this.relays.length) this.startContact(record);
    return toView(record);
  }

  /** Once per contact, after the renderer has added it, so it is not a stranger's message. */
  async greetExternalAi(pubkey: string): Promise<void> {
    const record = this.store.get(pubkey);
    if(!record || record.greeted || !this.isHosted(pubkey)) return;
    this.store.update(pubkey, {greeted: true});
    await this.contacts.get(pubkey)?.greet();
  }

  /** The first one comes by itself, once, when the first provider is configured. */
  async createFirstExternalAi(): Promise<ExternalAiView | null> {
    const owner = this.owner();
    if(this.store.autoCreated(owner) || this.store.list(owner).length) return null;
    if(!await this.pi.hasConfiguredProvider()) return null;
    this.store.markAutoCreated(owner);
    return this.createExternalAi();
  }

  async updateExternalAi(pubkey: string, change: {name?: unknown; model?: unknown; effort?: unknown}): Promise<ExternalAiView | null> {
    if(!this.isHosted(pubkey)) return null;
    const next: {name?: string; model?: string | null; effort?: string | null} = {};
    if(typeof change.name === 'string' && change.name.trim()) next.name = change.name.trim().slice(0, 140);
    if(typeof change.model === 'string' || change.model === null) next.model = change.model as string | null;
    if(typeof change.effort === 'string' || change.effort === null) next.effort = change.effort as string | null;
    const record = this.store.update(pubkey, next);
    if(!record) return null;
    const contact = this.contacts.get(pubkey);
    contact?.setRecord(record);
    if(next.name) void contact?.publishProfile();
    return toView(record);
  }

  /**
   * Asks first, in a native dialog the renderer cannot answer for you. Returns
   * false when the delete should not go ahead.
   */
  async deleteExternalAi(pubkey: string): Promise<boolean> {
    const record = this.store.get(pubkey);
    if(!record || !this.isHosted(pubkey)) return false;
    if(!await this.options.confirmDeleteExternalAi(record.name)) return false;
    this.contacts.get(pubkey)?.stop({save: false});
    this.contacts.delete(pubkey);
    this.pi.deleteContactHistory(pubkey);
    this.store.destroy(pubkey);
    return true;
  }

  modelChoices(): Promise<ModelChoice[]> {
    return this.pi.listModels();
  }

  effortChoices(model: string | null): Promise<EffortChoices> {
    return this.pi.effortChoices(model);
  }

  // --- Local PC access ------------------------------------------------------

  localAccessEnabled(): string[] {
    return Object.keys(this.access.enabled);
  }

  private capability(): ToolMessage {
    return {
      t: 'capability',
      deviceId: this.access.deviceId,
      deviceName: hostname(),
      platform: process.platform,
      tools: LOCAL_TOOL_NAMES
    };
  }

  /** The message to send a contact whose switch is ON. */
  capabilityMessage(): ToolMessage {
    return this.capability();
  }

  /**
   * Flip one contact's switch. ON asks in the native dialog, once. OFF never asks,
   * and cancels whatever that contact has running. The return value is the state
   * main ended up with, plus the message the contact should now be sent.
   */
  async setLocalAccess(pubkey: string, on: boolean, contactName: string): Promise<{enabled: boolean; notify: ToolMessage | null}> {
    if(!isHexPubkey(pubkey) || !this.access.ownerPubkey) return {enabled: false, notify: null};
    if(pubkey === this.access.ownerPubkey) return {enabled: false, notify: null};
    const current = isEnabled(this.access, pubkey);
    if(on === current) return {enabled: current, notify: null};

    if(on) {
      if(!await this.options.confirmLocalAccess(contactName)) return {enabled: false, notify: null};
      this.access.enabled[pubkey] = this.now();
      this.saveAccess();
      return {enabled: true, notify: this.capability()};
    }

    delete this.access.enabled[pubkey];
    this.saveAccess();
    this.runner.revoke(pubkey);
    return {enabled: false, notify: {t: 'revoked', deviceId: this.access.deviceId}};
  }

  /**
   * One rumor from a contact. `sender` is verified by the renderer's unwrap, which
   * holds the key. What comes back is what to send them: usually nothing.
   */
  async handleToolMessage(sender: string, payload: unknown, group: CallGroupInfo | null): Promise<ToolMessage[]> {
    if(!isHexPubkey(sender) || !payload || typeof payload !== 'object') return [];
    const message = payload as {t?: unknown; callId?: unknown};
    switch(message.t) {
      case 'hello':
        return isEnabled(this.access, sender) ? [this.capability()] : [];
      case 'cancel':
        if(typeof message.callId === 'string') this.runner.cancel(sender, message.callId);
        return [];
      case 'call': {
        const call = parseToolCall(payload);
        if(!call) return [];
        const decision = decideToolCall({state: this.access, sender, call, group, now: this.now()});
        if(decision !== 'run') return [];
        rememberCall(this.access, call, this.now());
        this.saveAccess();
        const result = await this.runner.run(sender, call);
        return chunkResult(call.callId, result);
      }
      default:
        return [];
    }
  }
}

export type {ToolMessage};
