// @ts-nocheck
import type {BrowserContext, Page} from 'playwright';
import type {LocalRelay} from '../e2e/helpers/local-relay';

export type UserId = 'userA' | 'userB';

export interface UserHandle {
  id: UserId;
  context: BrowserContext;
  page: Page;
  displayName: string;
  npub: string;
  /** 64-char hex pubkey, decoded from npub at boot. Needed for GroupAPI calls.
   *  Optional so existing unit-test UserHandle fakes (reactions/bubbles/…)
   *  keep compiling without forced backfill. */
  pubkeyHex?: string;
  /** Deterministic virtual peerId for the OTHER user — i.e. the peerId
   *  THIS user uses to address `other`. Set by linkContacts as
   *  `injectContact(self, other)`. Pass it as the `peerId` argument when
   *  this user opens / sends to the other user (e.g. in setPeer or
   *  appMessagesManager.sendText). */
  remotePeerId: number;
  /** Console lines captured since harness start (ring buffer). */
  consoleLog: string[];
  /** Timestamps of reload events — used to gate INV-console-clean warmup. */
  reloadTimes: number[];
}

export interface FuzzContext {
  users: {userA: UserHandle; userB: UserHandle};
  relay: LocalRelay;
  /** Snapshots captured during the sequence so regression invariants can diff. */
  snapshots: Map<string, any>;
  /** Action index inside the current sequence — for tiered invariant pacing. */
  actionIndex: number;
}

export interface Action {
  name: string;
  args: Record<string, any>;
  /** Applied by the action module if the action cannot run (e.g. edit when no bubble exists). */
  skipped?: boolean;
  /** Metadata the action wants to pass to its own postconditions. */
  meta?: Record<string, any>;
}

export type ActionDriver = (ctx: FuzzContext, action: Action) => Promise<Action>;

export interface ActionSpec {
  name: string;
  weight: number;
  /** Fast-check arbitrary that generates `args` for this action. */
  generateArgs: () => any;
  drive: ActionDriver;
}

export type InvariantTier = 'cheap' | 'medium' | 'regression';

export interface InvariantResult {
  ok: boolean;
  /** Human-readable first assertion that failed. Undefined if ok. */
  message?: string;
  /** Optional extra data captured at the moment of failure (DOM snippet, state dump). */
  evidence?: Record<string, any>;
}

export interface Invariant {
  id: string;
  tier: InvariantTier;
  check(ctx: FuzzContext, action?: Action): Promise<InvariantResult>;
}

export interface Postcondition {
  id: string;
  check(ctx: FuzzContext, action: Action): Promise<InvariantResult>;
}

export interface FailureDetails {
  invariantId: string;
  tier: InvariantTier | 'postcondition';
  message: string;
  evidence?: Record<string, any>;
  action?: Action;
  stackTopFrame?: string;
}

export interface ReportEntry {
  signature: string;
  invariantId: string;
  tier: FailureDetails['tier'];
  assertion: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  seed: number;
  minimalTrace: Action[];
  status: 'open' | 'fixed';
  fixedAt?: string;
  fixedCommit?: string;
}
