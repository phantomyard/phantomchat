// Fast publication smoke: ensure both channels and their entry assets exist.
import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
const root = resolve(process.argv[2]);
const channels = JSON.parse(readFileSync(resolve(root, 'channels.json'), 'utf8'));
for(const channel of ['stable', 'preview']) {
  if(!/^[a-f0-9]{40}$/.test(channels[channel])) throw new Error(`Invalid ${channel} source`);
  const html = readFileSync(resolve(root, channel === 'stable' ? 'index.html' : 'preview/index.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)];
  if(!assets.length) throw new Error(`Missing ${channel} entry assets`);
  for(const [, asset] of assets) {
    if(/^(?:https?:)?\/\//.test(asset)) continue;
    const path = resolve(root, asset.startsWith('/') ? '.' + asset.split('?')[0] : `${channel === 'stable' ? '' : 'preview/'}${asset.split('?')[0]}`);
    if(!path.startsWith(root + '/') || !existsSync(path)) throw new Error(`Missing asset: ${path}`);
  }
}
console.log('Stable and Preview entry assets verified');
