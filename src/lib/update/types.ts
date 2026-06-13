/**
 * Shared types for Phase A controlled updates.
 * Spec: docs/superpowers/specs/2026-04-16-phase-a-controlled-updates-design.md
 */

export interface Manifest {
  schemaVersion: number;
  version: string;
  gitSha: string;
  published: string;
  swUrl: string;
  bundleHashes: Record<string, string>;
  changelog: string;
  alternateSources?: Record<string, unknown>;
}

export type IntegrityVerdict = 'verified' | 'verified-partial' | 'conflict' | 'insufficient' | 'offline' | 'error';

export interface IntegrityResult {
  verdict: IntegrityVerdict;
  manifest?: Manifest;
  sources: Array<{
    name: string;
    status: 'ok' | 'error' | 'stale';
    error?: string;
    version?: string;
    gitSha?: string;
    swUrl?: string;
  }>;
  checkedAt: number;
}

export enum BootGate {
  LocalChecksOnly = 'local-checks-only',
  NetworkPending = 'network-pending',
  AllVerified = 'all-verified'
}

export type CompromiseReason =
  | {type: 'sw-url-changed'; expected: string; got: string}
  | {type: 'sw-body-changed-at-same-url'; url?: string; waitingUrl?: string}
  | {type: 'unexpected-waiting-sw'; waitingUrl?: string}
  | {type: 'manifest-schema-too-new'; receivedSchemaVersion: number};

export type FailureReason =
  | {type: 'network-error'; err: string}
  | {type: 'hash-mismatch'; path: string; expected: string; actual: string}
  | {type: 'install-timeout'}
  | {type: 'install-redundant'}
  | {type: 'register-failed'; err: string}
  | {type: 'finalization-url-mismatch'; expected: string; actual: string};

export type UpdateFlowState =
  | {kind: 'idle'}
  | {kind: 'available'; manifest: Manifest}
  | {kind: 'downloading'; target: Manifest; completed: number; total: number}
  | {kind: 'verifying'; target: Manifest}
  | {kind: 'registering'; target: Manifest}
  | {kind: 'finalizing'; target: Manifest}
  | {kind: 'failed'; reason: FailureReason; target?: Manifest};

export class CompromiseAlertError extends Error {
  readonly reason: CompromiseReason;
  constructor(reason: CompromiseReason) {
    super(`CompromiseAlert: ${reason.type}`);
    this.reason = reason;
    this.name = 'CompromiseAlertError';
  }
}

export class UpdateFlowError extends Error {
  readonly reason: FailureReason;
  constructor(reason: FailureReason) {
    super(`UpdateFlow: ${reason.type}`);
    this.reason = reason;
    this.name = 'UpdateFlowError';
  }
}
