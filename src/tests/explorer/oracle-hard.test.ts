import {describe, expect, it} from 'vitest';
import {checkHard, type HardOracleInput} from '../../../scripts/explorer/oracles/hard';

describe('Oracle A — hard checks', () => {
  it('flags console error not in allowlist', () => {
    const input: HardOracleInput = {
      pageA: {consoleSinceStart: ['[ERROR] Uncaught TypeError: foo is undefined']},
      pageB: {consoleSinceStart: []}
    };
    const findings = checkHard(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].oracle).toBe('console_error');
    expect(findings[0].page).toBe('A');
  });

  it('does NOT flag a console error matching the fuzz allowlist', () => {
    const input: HardOracleInput = {
      pageA: {consoleSinceStart: ['[vite] connected']},
      pageB: {consoleSinceStart: []}
    };
    expect(checkHard(input)).toHaveLength(0);
  });

  it('flags unhandled rejection', () => {
    const input: HardOracleInput = {
      pageA: {consoleSinceStart: []},
      pageB: {consoleSinceStart: ['[PAGEERROR] Unhandled promise rejection: bad thing']}
    };
    const findings = checkHard(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].oracle).toBe('unhandled_rejection');
    expect(findings[0].page).toBe('B');
  });

  it('flags lowercase [error] from real harness output (regression for case-mismatch bug)', () => {
    const input: HardOracleInput = {
      pageA: {consoleSinceStart: ['[error] Cannot read property of undefined']},
      pageB: {consoleSinceStart: []}
    };
    const findings = checkHard(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].oracle).toBe('console_error');
  });

  it('flags lowercase [pageerror] from real harness output (regression for case-mismatch bug)', () => {
    const input: HardOracleInput = {
      pageA: {consoleSinceStart: []},
      pageB: {consoleSinceStart: ['[pageerror] TypeError: x is undefined\n  at line 5']}
    };
    const findings = checkHard(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].oracle).toBe('unhandled_rejection');
    expect(findings[0].page).toBe('B');
  });
});
