import {describe, it, expect} from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// An installed client keeps its cached lang pack until boot sees a new local
// version (src/index.ts); with MTProto off nothing else refreshes it. Main
// shipped v21 without the session keys, so this build must be ahead of it.
const SRC = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(SRC, p), 'utf-8');
const SESSION_KEYS = [
  'Title', 'Leave', 'Delete', 'DeleteDescription', 'MakeAdminDescription', 'RemoveMember',
  'DeleteMenu', 'DeleteAndExit', 'LeaveMenu', 'DeleteAndExitName'
].map((k) => `PhantomChat.Session.${k}`);
const PACK_WITHOUT_SESSION_KEYS = 22;

const buildVersion = Number(read('langPackLocalVersion.example.ts').match(/const langPackLocalVersion = (\d+);/)![1]);

describe('session wording reaches a cached v22 lang pack', () => {
  it('boot reloads from local only on a version mismatch', () => {
    expect(read('index.ts')).toContain('if(langPack.localVersion !== App.langPackLocalVersion) {\n    I18n.getLangPackAndApply(langPack.lang_code);');
  });

  it('a cached pack without the session keys is reloaded', () => {
    const cached = {localVersion: PACK_WITHOUT_SESSION_KEYS};
    expect(cached.localVersion !== buildVersion).toBe(true);
    expect(buildVersion).toBeGreaterThan(PACK_WITHOUT_SESSION_KEYS);
  });

  it('the reloaded local pack carries every session key', () => {
    const lang = read('lang.ts');
    const strings = read('scripts/out/langPack.strings');
    for(const key of SESSION_KEYS) {
      expect(lang).toContain(`'${key}':`);
      expect(strings).toContain(`"${key}" = `);
    }
  });
});
