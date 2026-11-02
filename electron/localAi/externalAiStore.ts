/*
 * External AI identities (issue #276). The nsec stays here, in the main process
 * of the PC that created it: it is never sent to the renderer, contact sync or a
 * relay. Same protection as a phantom's identity file: a private file in a
 * private folder. There is no backup or transfer, by decision.
 */
import {mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {isHexPubkey} from './localAccess';

export const EXTERNAL_AI_BASE_NAME = 'External AI';

export interface ExternalAiRecord {
  pubkey: string;
  /** Hex secret key. Stays in this module's callers, in main. */
  secretKey: string;
  /** The only npub that can drive it. */
  ownerPubkey: string;
  name: string;
  /** `<provider>/<model>`; null follows the default. */
  model: string | null;
  effort: string | null;
  createdAt: number;
  greeted?: boolean;
}

/** What the renderer is allowed to see. */
export type ExternalAiView = Omit<ExternalAiRecord, 'secretKey'>;

export function toView(record: ExternalAiRecord): ExternalAiView {
  const {secretKey: _secret, ...view} = record;
  return view;
}

/** External AI, External AI 2, External AI 3, ... The lowest free number. */
export function nextName(existing: string[]): string {
  const taken = new Set(existing.map((name) => name.trim().toLowerCase()));
  if(!taken.has(EXTERNAL_AI_BASE_NAME.toLowerCase())) return EXTERNAL_AI_BASE_NAME;
  for(let n = 2; ; n++) {
    const name = `${EXTERNAL_AI_BASE_NAME} ${n}`;
    if(!taken.has(name.toLowerCase())) return name;
  }
}

export function writePrivateJson(filePath: string, value: unknown): void {
  const temp = `${filePath}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), {mode: 0o600});
  renameSync(temp, filePath);
}

export class ExternalAiStore {
  private readonly records = new Map<string, ExternalAiRecord>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, {recursive: true, mode: 0o700});
    for(const name of readdirSync(dir)) {
      if(!isHexPubkey(name)) continue;
      try {
        const record = JSON.parse(readFileSync(join(dir, name, 'identity.json'), 'utf8')) as ExternalAiRecord;
        if(record.pubkey === name && typeof record.secretKey === 'string') this.records.set(name, record);
      } catch(err) {
        console.error('could not read an External AI identity', name, err);
      }
    }
  }

  list(ownerPubkey?: string): ExternalAiRecord[] {
    return [...this.records.values()]
    .filter((record) => !ownerPubkey || record.ownerPubkey === ownerPubkey)
    .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(pubkey: string): ExternalAiRecord | undefined {
    return this.records.get(pubkey);
  }

  contactDir(pubkey: string): string {
    return join(this.dir, pubkey);
  }

  create(ownerPubkey: string, now: number): ExternalAiRecord {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const record: ExternalAiRecord = {
      pubkey,
      secretKey: Buffer.from(secret).toString('hex'),
      ownerPubkey,
      name: nextName(this.list(ownerPubkey).map((r) => r.name)),
      model: null,
      effort: null,
      createdAt: now
    };
    this.save(record);
    return record;
  }

  update(pubkey: string, change: Partial<Pick<ExternalAiRecord, 'name' | 'model' | 'effort' | 'greeted'>>): ExternalAiRecord | undefined {
    const record = this.records.get(pubkey);
    if(!record) return undefined;
    Object.assign(record, change);
    this.save(record);
    return record;
  }

  /** Destroys the nsec and everything else kept for this contact. */
  destroy(pubkey: string): boolean {
    if(!isHexPubkey(pubkey) || !this.records.has(pubkey)) return false;
    this.records.delete(pubkey);
    rmSync(this.contactDir(pubkey), {recursive: true, force: true});
    return true;
  }

  /** Whether the first External AI was already created for this owner. */
  autoCreated(ownerPubkey: string): boolean {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'auto-created.json'), 'utf8'))?.[ownerPubkey] === true;
    } catch{
      return false;
    }
  }

  markAutoCreated(ownerPubkey: string): void {
    let current: Record<string, boolean> = {};
    try {
      current = JSON.parse(readFileSync(join(this.dir, 'auto-created.json'), 'utf8'));
    } catch{ /* first time */ }
    writePrivateJson(join(this.dir, 'auto-created.json'), {...current, [ownerPubkey]: true});
  }

  private save(record: ExternalAiRecord): void {
    const dir = this.contactDir(record.pubkey);
    mkdirSync(dir, {recursive: true, mode: 0o700});
    writePrivateJson(join(dir, 'identity.json'), record);
    this.records.set(record.pubkey, record);
  }
}
