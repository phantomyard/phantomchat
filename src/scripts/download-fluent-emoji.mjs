// Downloads Microsoft Fluent Emoji 3D PNGs into public/assets/fluent-emoji/.
// Source: github.com/microsoft/fluentui-emoji (MIT). Run after editing
// FLUENT_EMOJI_MAP in src/lib/nostra/fluent-emoji.ts.
//
// Microsoft's folder naming is inconsistent (some "Red heart", some
// "Red Heart"). Script tries multiple URL patterns per slug, logs failures.

import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'public', 'assets', 'fluent-emoji');

// Pairs: [slug, folderName]. Edit here when adding emoji.
const EMOJI = [
  ['red_heart', 'Red heart'],
  ['thumbs_up', 'Thumbs up'],
  ['thumbs_down', 'Thumbs down'],
  ['fire', 'Fire'],
  ['party_popper', 'Party popper'],
  ['confetti_ball', 'Confetti ball'],
  ['birthday_cake', 'Birthday cake'],
  ['wrapped_gift', 'Wrapped gift'],
  ['christmas_tree', 'Christmas tree'],
  ['evergreen_tree', 'Evergreen tree'],
  ['national_park', 'National park'],
  ['tent', 'Tent'],
  ['milky_way', 'Milky way'],
  ['rainbow', 'Rainbow'],
  ['star', 'Star'],
  ['crescent_moon', 'Crescent moon'],
  ['sun', 'Sun'],
  ['rose', 'Rose'],
  ['sparkles', 'Sparkles'],
  ['artist_palette', 'Artist palette'],
  ['face_with_tears_of_joy', 'Face with tears of joy'],
  ['smiling_face_with_heart_eyes', 'Smiling face with heart-eyes'],
  ['crying_face', 'Crying face'],
  ['folded_hands', 'Folded hands'],
  ['hundred_points', 'Hundred points']
];

const BASE = 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets';

function urls(slug, folder) {
  const titled = folder.split(' ').map(s => s[0].toUpperCase() + s.slice(1)).join(' ');
  // Some Fluent Emoji have skin-tone subfolders — Default/3D path.
  // Others (like "heart-eyes") keep hyphens in the filename.
  const slugWithHyphen = slug.replace('heart_eyes', 'heart-eyes');
  return [
    `${BASE}/${encodeURIComponent(folder)}/3D/${slug}_3d.png`,
    `${BASE}/${encodeURIComponent(titled)}/3D/${slug}_3d.png`,
    `${BASE}/${encodeURIComponent(folder)}/3D/${slugWithHyphen}_3d.png`,
    `${BASE}/${encodeURIComponent(folder)}/Default/3D/${slug}_3d_default.png`,
    `${BASE}/${encodeURIComponent(titled)}/Default/3D/${slug}_3d_default.png`
  ];
}

await fs.mkdir(OUT_DIR, {recursive: true});

let ok = 0, fail = 0;
for(const [slug, folder] of EMOJI) {
  let written = false;
  for(const u of urls(slug, folder)) {
    try {
      const res = await fetch(u);
      if(!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(path.join(OUT_DIR, `${slug}.png`), buf);
      console.log(`[ok] ${slug} ${(buf.length / 1024).toFixed(1)}KB`);
      written = true;
      ok++;
      break;
    } catch {}
  }
  if(!written) {
    console.warn(`[fail] ${slug}: none of the candidate URLs succeeded`);
    fail++;
  }
}
console.log(`\nDone: ${ok} ok, ${fail} failed.`);
if(fail > 0) process.exit(1);
