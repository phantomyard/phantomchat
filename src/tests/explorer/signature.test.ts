import {describe, expect, it, beforeEach, afterEach} from 'vitest';
import {mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {computeSignature, recordSighting, loadStore, markFixPrOpen, markFixed, markReportOnly, type Sighting} from '../../../scripts/explorer/signature';

describe('explorer signature', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exp-sig-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, {recursive: true, force: true});
  });

  it('computeSignature returns a stable string for identical inputs', () => {
    const sig1 = computeSignature({area: 'messaging', intent: 'send_text_message', oracle: 'A:console_error', hash: 'deadbeef'});
    const sig2 = computeSignature({area: 'messaging', intent: 'send_text_message', oracle: 'A:console_error', hash: 'deadbeef'});
    expect(sig1).toBe(sig2);
    expect(sig1).toBe('messaging:send_text_message:A:console_error:deadbeef');
  });

  it('recordSighting creates the store on first call', async() => {
    const storePath = join(tmpRoot, 'seen-signatures.json');
    const sighting: Sighting = {
      signature: 'messaging:send_text_message:A:console_error:abc12345',
      findId: 'FIND-12345678',
      timestamp: '2026-04-29T14:00:00Z'
    };
    const result = await recordSighting(storePath, sighting);
    expect(result.isNew).toBe(true);
    expect(result.entry.occurrences).toBe(1);
    expect(existsSync(storePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(parsed[sighting.signature]).toMatchObject({
      find_id: 'FIND-12345678',
      occurrences: 1,
      status: 'open'
    });
  });

  it('recordSighting bumps occurrences on duplicate signature', async() => {
    const storePath = join(tmpRoot, 'seen-signatures.json');
    const sig = 'messaging:send_text_message:A:console_error:abc12345';
    await recordSighting(storePath, {signature: sig, findId: 'FIND-1', timestamp: '2026-04-29T14:00:00Z'});
    const result = await recordSighting(storePath, {signature: sig, findId: 'FIND-2', timestamp: '2026-04-29T14:05:00Z'});
    expect(result.isNew).toBe(false);
    expect(result.entry.occurrences).toBe(2);
    expect(result.entry.first_seen).toBe('2026-04-29T14:00:00Z');
    expect(result.entry.last_seen).toBe('2026-04-29T14:05:00Z');
  });

  it('loadStore returns {} when the file does not exist', async() => {
    const storePath = join(tmpRoot, 'missing.json');
    const store = await loadStore(storePath);
    expect(store).toEqual({});
  });

  it('recordSighting flags REGRESSION when signature has status=fixed', async() => {
    const storePath = join(tmpRoot, 'seen-signatures.json');
    const sig = 'messaging:send_text_message:A:console_error:abc12345';
    writeFileSync(storePath, JSON.stringify({
      [sig]: {find_id: 'FIND-old', occurrences: 1, first_seen: 't0', last_seen: 't0', status: 'fixed'}
    }));
    const result = await recordSighting(storePath, {signature: sig, findId: 'FIND-new', timestamp: 't1'});
    expect(result.isNew).toBe(false);
    expect(result.regression).toBe(true);
    expect(result.entry.status).toBe('fixed');
  });

  describe('status helpers', () => {
    it('markFixPrOpen sets status + fix_pr + fix_branch', async() => {
      const storePath = join(tmpRoot, 'seen-signatures.json');
      const sig = 'messaging:x:A:console_error:abc';
      await recordSighting(storePath, {signature: sig, findId: 'FIND-1', timestamp: 't0'});
      const updated = await markFixPrOpen(storePath, sig, {fixPr: 'https://github.com/x/y/pull/42', fixBranch: 'explorer/fix-FIND-1'});
      expect(updated.status).toBe('fix-pr-open');
      expect(updated.fix_pr).toBe('https://github.com/x/y/pull/42');
      expect(updated.fix_branch).toBe('explorer/fix-FIND-1');
      const reloaded = await loadStore(storePath);
      expect(reloaded[sig].status).toBe('fix-pr-open');
    });

    it('markFixed flips status to fixed (called when PR merges)', async() => {
      const storePath = join(tmpRoot, 'seen-signatures.json');
      const sig = 'messaging:y:A:console_error:abc';
      await recordSighting(storePath, {signature: sig, findId: 'FIND-2', timestamp: 't0'});
      await markFixPrOpen(storePath, sig, {fixPr: 'pr', fixBranch: 'br'});
      const updated = await markFixed(storePath, sig);
      expect(updated.status).toBe('fixed');
    });

    it('markReportOnly stores reason for audit', async() => {
      const storePath = join(tmpRoot, 'seen-signatures.json');
      const sig = 'messaging:z:A:console_error:abc';
      await recordSighting(storePath, {signature: sig, findId: 'FIND-3', timestamp: 't0'});
      const updated = await markReportOnly(storePath, sig, 'category-disallowed:messageport');
      expect(updated.status).toBe('report-only');
      expect(updated.report_only_reason).toBe('category-disallowed:messageport');
    });

    it('patchEntry-style helpers throw if signature missing', async() => {
      const storePath = join(tmpRoot, 'seen-signatures.json');
      await expect(markFixPrOpen(storePath, 'never:seen:0:0', {fixPr: 'x', fixBranch: 'y'})).rejects.toThrow();
    });
  });
});
