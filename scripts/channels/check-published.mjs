import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {checkCompatibility} from './check.mjs';

// Draft release archives need a write-capable token to discover. PRs instead
// read the source SHAs emitted into the deployed site by the publisher.
export async function checkPublishedCompatibility(config, candidate = 'HEAD', cwd = process.cwd(), fetcher = fetch) {
  const url = new URL('https://chat.phantomyard.ai/channels.json');
  url.searchParams.set('compatibility', String(Date.now()));
  const response = await fetcher(url, {cache: 'no-store', signal: AbortSignal.timeout(20000)});
  if(!response.ok) throw new Error(`Published channel metadata unavailable: HTTP ${response.status}`);
  const channels = await response.json();
  if(!channels || !/^[a-f0-9]{40}$/.test(channels.stable) || !/^[a-f0-9]{40}$/.test(channels.preview)) {
    throw new Error('Invalid published channel source SHAs');
  }
  console.log(`Checking published Stable ${channels.stable} against ${candidate}`);
  return checkCompatibility({...config, stableRef: channels.stable}, candidate, cwd);
}
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkPublishedCompatibility(JSON.parse(readFileSync('scripts/channels/config.json', 'utf8')), process.argv[2] || 'HEAD');
}
