// @ts-nocheck
import type {BrowserContext} from 'playwright';

export async function rewriteManifestSources(
  context: BrowserContext,
  urls: {cdn: string; github: string; ipfs: string}
): Promise<void> {
  await context.addInitScript((u) => {
    (window as any).__NOSTRA_TEST_MANIFEST_SOURCES__ = [
      {name: 'cdn', url: u.cdn},
      {name: 'github-pages', url: u.github},
      {name: 'ipfs', url: u.ipfs}
    ];
  }, urls);
}
