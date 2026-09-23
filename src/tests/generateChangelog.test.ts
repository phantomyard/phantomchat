import {describe, expect, it} from 'vitest';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const SCRIPT = join(process.cwd(), 'src', 'scripts', 'generate_changelog.js');

describe('generate_changelog.js', () => {
  it('handles a CHANGELOG checked out with Windows CRLF line endings', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'generate-changelog-test-'));
    try {
      mkdirSync(join(sandbox, 'public'));
      writeFileSync(
        join(sandbox, 'CHANGELOG.md'),
        '# Changelog\r\n\r\n### Features\r\n\r\n* Windows package\r\n'
      );

      const result = spawnSync(process.execPath, [SCRIPT], {cwd: sandbox, encoding: 'utf8'});

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(readdirSync(join(sandbox, 'public', 'changelogs'))).toEqual(['en_Features.md']);
      expect(readFileSync(join(sandbox, 'public', 'changelogs', 'en_Features.md'), 'utf8'))
        .toBe('\n• Windows package\n');
    } finally {
      rmSync(sandbox, {recursive: true, force: true});
    }
  });
});
