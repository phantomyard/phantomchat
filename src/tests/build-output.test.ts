import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const distIndexPath = join(process.cwd(), 'dist', 'index.html');
const distExists = existsSync(distIndexPath);

describe.skipIf(!distExists)('Build output — dist/index.html', () => {
  let html: string;

  beforeAll(() => {
    html = readFileSync(distIndexPath, 'utf8');
  });

  test('does not contain absolute nostra.app URLs in asset src/href (script/link tags)', () => {
    // Meta tags and canonical links may legitimately reference absolute URLs.
    // Asset references (JS, CSS, images loaded by browser) must not use origin-absolute paths.
    const scriptSrcMatches = html.match(/<script[^>]+src="([^"]+)"/g) || [];
    const linkHrefMatches = html.match(/<link[^>]+(?:rel="stylesheet"|rel="modulepreload")[^>]+href="([^"]+)"/g) || [];
    const allAssetTags = [...scriptSrcMatches, ...linkHrefMatches];

    const absoluteAssets = allAssetTags.filter(tag => {
      const value = tag.match(/(?:src|href)="([^"]+)"/)?.[1] ?? '';
      return value.startsWith('https://nostra.app') || value.startsWith('https://web.telegram.org');
    });
    expect(absoluteAssets).toEqual([]);
  });

  test('does not contain absolute web.telegram.org URLs in asset src/href', () => {
    expect(html).not.toContain('src="https://web.telegram.org');
    expect(html).not.toContain('href="https://web.telegram.org');
  });

  test('JS and CSS asset paths start with ./ (relative)', () => {
    const scriptSrcMatches = html.match(/<script[^>]+src="([^"]+)"/g) || [];
    const linkHrefMatches = html.match(/<link[^>]+(?:rel="stylesheet"|rel="modulepreload")[^>]*href="([^"]+)"/g) || [];
    const allAssetTags = [...scriptSrcMatches, ...linkHrefMatches];

    for(const tag of allAssetTags) {
      const value = tag.match(/(?:src|href)="([^"]+)"/)?.[1] ?? '';
      if(value && !value.startsWith('http')) {
        expect(value).toMatch(/^\.\//);
      }
    }
  });
});

describe.skipIf(distExists)('Build output — dist/ not yet built', () => {
  test('skipped: dist/ does not exist (pre-build)', () => {
    expect(true).toBe(true);
  });
});
