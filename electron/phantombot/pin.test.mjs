import {afterEach, describe, expect, it} from 'vitest';
import {matchesBun, readPin, resolveEngine} from './build-host.mjs';

/*
 * The engine is not pinned to a version any more: pin.json names a channel and
 * the build resolves it. These tests keep that honest — a pin that drifts back
 * to a hand-maintained tag, or a Bun series the build silently ignores, is the
 * failure the channel exists to prevent.
 */

const env = {...process.env};

afterEach(() => {
  process.env = {...env};
});

describe('pin.json', () => {
  it('names a channel the build can resolve, or a tag with its commit', () => {
    const pin = readPin();
    if(pin.channel) {
      expect(pin.channel).toBe('latest');
      expect(pin.tag).toBeUndefined();
    } else {
      expect(typeof pin.tag).toBe('string');
      expect(pin.tag).toMatch(/^v\d+\.\d+\.\d+/);
      expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('pins Bun as a series, the way phantombot releases pin it', () => {
    expect(readPin().bun).toMatch(/^\d+\.(x|\d+\.\d+)$/);
  });
});

describe('Bun version match', () => {
  it('accepts any release in a pinned series', () => {
    expect(matchesBun('1.x', '1.4.4')).toBe(true);
    expect(matchesBun('1.x', '1.9.0')).toBe(true);
  });

  it('rejects a different major, and an exact pin that differs', () => {
    expect(matchesBun('1.x', '2.0.0')).toBe(false);
    expect(matchesBun('1.4.4', '1.4.5')).toBe(false);
    expect(matchesBun('1.4.4', '1.4.4')).toBe(true);
  });
});

describe('engine resolution', () => {
  it('lets the workflow hand every matrix job one resolved tag and commit', async () => {
    process.env.PHANTOMBOT_HOST_REF = 'v1.1.490';
    process.env.PHANTOMBOT_HOST_COMMIT = 'a'.repeat(40);
    expect(await resolveEngine()).toMatchObject({
      tag: 'v1.1.490',
      commit: 'a'.repeat(40),
      source: 'PHANTOMBOT_HOST_REF'
    });
  });

  it('refuses a pin that names a channel this build does not know', async () => {
    delete process.env.PHANTOMBOT_HOST_REF;
    await expect(resolveEngine({channel: 'nightly', bun: '1.x'})).rejects.toThrow(/no channel this build knows/);
  });

  it('refuses a pinned tag with no commit to build', async () => {
    delete process.env.PHANTOMBOT_HOST_REF;
    await expect(resolveEngine({tag: 'v1.1.490', bun: '1.x'})).rejects.toThrow(/pins a tag but no commit/);
  });
});
