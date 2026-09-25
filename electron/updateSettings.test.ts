/*
 * Update ring persistence. The two properties that matter: a broken settings
 * file must never stop the app booting, and the 24h schedule must survive a
 * machine being asleep.
 */
import {describe, it, expect, afterEach} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {
  normalizeUpdateSettings,
  readUpdateSettings,
  writeUpdateSettings,
  updateSettingsPath,
  isUpdateChannel,
  isCheckDue,
  channelUpdaterFlags,
  DEFAULT_CHANNEL,
  CHECK_INTERVAL_MS
} from './updateSettings';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pc-upd-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while(dirs.length) rmSync(dirs.pop()!, {recursive: true, force: true});
});

describe('isUpdateChannel', () => {
  it('accepts exactly the two rings', () => {
    expect(isUpdateChannel('stable')).toBe(true);
    expect(isUpdateChannel('preview')).toBe(true);
  });

  it('rejects anything else, including near-misses from a hostile renderer', () => {
    for(const value of ['beta', 'Stable', 'STABLE', '', 'latest', null, undefined, 1, {}, ['stable']]) {
      expect(isUpdateChannel(value)).toBe(false);
    }
  });
});

describe('normalizeUpdateSettings', () => {
  it('defaults to stable so preview is always opt-in', () => {
    expect(normalizeUpdateSettings(undefined)).toEqual({channel: 'stable', lastCheckedAt: null});
    expect(DEFAULT_CHANNEL).toBe('stable');
  });

  it('keeps a valid stored ring', () => {
    expect(normalizeUpdateSettings({channel: 'preview', lastCheckedAt: 1000}))
      .toEqual({channel: 'preview', lastCheckedAt: 1000});
  });

  it('falls back per-field: a corrupt timestamp must not discard the chosen ring', () => {
    expect(normalizeUpdateSettings({channel: 'preview', lastCheckedAt: 'yesterday'}))
      .toEqual({channel: 'preview', lastCheckedAt: null});
    expect(normalizeUpdateSettings({channel: 'nonsense', lastCheckedAt: 1000}))
      .toEqual({channel: 'stable', lastCheckedAt: 1000});
  });

  it('rejects non-finite and non-positive timestamps', () => {
    for(const bad of [NaN, Infinity, -Infinity, 0, -5]) {
      expect(normalizeUpdateSettings({channel: 'stable', lastCheckedAt: bad}).lastCheckedAt).toBeNull();
    }
  });

  it('drops unknown fields rather than persisting them', () => {
    const result = normalizeUpdateSettings({channel: 'stable', evil: 'payload'}) as unknown as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['channel', 'lastCheckedAt']);
  });

  it('survives non-object input of every shape', () => {
    for(const bad of [null, 'preview', 42, [], true]) {
      expect(normalizeUpdateSettings(bad).channel).toBe('stable');
    }
  });
});

describe('readUpdateSettings / writeUpdateSettings', () => {
  it('round-trips a chosen ring', () => {
    const file = updateSettingsPath(scratch());
    writeUpdateSettings(file, {channel: 'preview', lastCheckedAt: 12345});
    expect(readUpdateSettings(file)).toEqual({channel: 'preview', lastCheckedAt: 12345});
  });

  it('returns defaults for a file that does not exist yet (first run)', () => {
    expect(readUpdateSettings(updateSettingsPath(scratch())))
      .toEqual({channel: 'stable', lastCheckedAt: null});
  });

  it('returns defaults for a truncated or hand-mangled file instead of throwing', () => {
    const file = updateSettingsPath(scratch());
    writeFileSync(file, '{"channel": "prev');
    expect(() => readUpdateSettings(file)).not.toThrow();
    expect(readUpdateSettings(file)).toEqual({channel: 'stable', lastCheckedAt: null});
  });

  it('writes atomically and leaves no .tmp behind', () => {
    const file = updateSettingsPath(scratch());
    writeUpdateSettings(file, {channel: 'preview', lastCheckedAt: 1});
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).channel).toBe('preview');
  });

  it('never throws when the location is unwritable — a lost preference must not crash the app', () => {
    const dir = scratch();
    chmodSync(dir, 0o500); // read + execute, no write
    try {
      expect(() => writeUpdateSettings(join(dir, 'sub', 'update-settings.json'), {channel: 'preview', lastCheckedAt: 1}))
        .not.toThrow();
    } finally {
      chmodSync(dir, 0o700); // so afterEach can clean up
    }
  });
});

describe('isCheckDue', () => {
  const now = 1_700_000_000_000;

  it('is due when never checked', () => {
    expect(isCheckDue(null, now)).toBe(true);
  });

  it('is not due before the interval elapses', () => {
    expect(isCheckDue(now - 1000, now)).toBe(false);
    expect(isCheckDue(now - (CHECK_INTERVAL_MS - 1), now)).toBe(false);
  });

  it('is due at exactly the interval and beyond', () => {
    expect(isCheckDue(now - CHECK_INTERVAL_MS, now)).toBe(true);
    expect(isCheckDue(now - CHECK_INTERVAL_MS * 3, now)).toBe(true);
  });

  it('is due on the first wake after a long sleep — the case a timer alone misses', () => {
    // Laptop closed at T, opened 5 days later. No interval tick ever fired.
    const fiveDays = CHECK_INTERVAL_MS * 5;
    expect(isCheckDue(now, now + fiveDays)).toBe(true);
  });

  it('is due when the stored timestamp is in the future, rather than wedging off', () => {
    // Clock skew, a timezone-confused system clock, or a settings file copied
    // from another machine. Without this, checks stop until real time catches up.
    expect(isCheckDue(now + CHECK_INTERVAL_MS * 10, now)).toBe(true);
  });
});

describe('channelUpdaterFlags', () => {
  it('preview allows prereleases', () => {
    expect(channelUpdaterFlags('preview').allowPrerelease).toBe(true);
    expect(channelUpdaterFlags('stable').allowPrerelease).toBe(false);
  });

  it('stable allows a downgrade, so leaving preview actually lands on stable bytes', () => {
    // Delete allowDowngrade and this is the test that fails: a user on
    // preview 1.0.50 choosing Stable (1.0.45) would otherwise be told they
    // are up to date and keep receiving preview builds.
    expect(channelUpdaterFlags('stable').allowDowngrade).toBe(true);
  });

  it('preview does NOT allow a downgrade — nothing should walk a preview user backwards', () => {
    expect(channelUpdaterFlags('preview').allowDowngrade).toBe(false);
  });
});
