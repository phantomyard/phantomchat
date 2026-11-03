import {describe, expect, it, vi} from 'vitest';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {removeScratch} from '../../scripts/channels/smoke-cleanup.mjs';

const CHANNEL_SCRIPTS = join(process.cwd(), 'scripts', 'channels');

describe('Electron smoke cleanup', () => {
  it('warns instead of throwing, so it cannot replace the real failure', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failingRm = () => {
      throw new Error('EPERM, Permission denied');
    };
    expect(() => removeScratch('scratch-dir', failingRm)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('scratch-dir'));
    warn.mockRestore();
  });

  it('retries, because Windows releases a closed Electron profile late', () => {
    const rm = vi.fn();
    removeScratch('scratch-dir', rm);
    expect(rm).toHaveBeenCalledWith('scratch-dir', expect.objectContaining({recursive: true, force: true, maxRetries: 5}));
  });

  it('is what every Electron smoke script uses', () => {
    const scripts = readdirSync(CHANNEL_SCRIPTS).filter((name) => /^electron-.*smoke\.mjs$/.test(name));
    expect(scripts.length).toBeGreaterThanOrEqual(3);
    for(const name of scripts) {
      const source = readFileSync(join(CHANNEL_SCRIPTS, name), 'utf8');
      expect(source, name).toContain('removeScratch(dir)');
      expect(source, name).not.toContain('rmSync');
    }
  });
});
