/*
 * Merge per-architecture electron-updater feed files into one (issue #164).
 *
 * Windows x64 and arm64 are packaged on separate runners, and each run emits
 * its own `latest.yml` describing only the artifact it built. Uploading both
 * to one release means the second clobbers the first, and whichever survives
 * offers ITS architecture to every user — an arm64 machine would be handed
 * the x64 installer on the next update, or vice versa.
 *
 * electron-updater picks a file out of `files` by matching process.arch
 * against the file name (Provider.findFile), so a single feed listing both
 * installers resolves correctly on both architectures. This script produces
 * that feed.
 *
 * Fails closed: mismatched versions, a missing `files` list, or duplicate
 * architectures all abort rather than publishing a feed that would send the
 * wrong bytes to real machines.
 *
 * Usage: node scripts/merge-update-feed.mjs <out.yml> <in-a.yml> <in-b.yml> [...]
 */
import {readFileSync, writeFileSync} from 'fs';
import {load, dump} from 'js-yaml';

/**
 * @param {string[]} sources raw YAML documents, in preference order — the
 *   first is the base whose top-level `path`/`sha512` are kept, so put the
 *   most common architecture first. That matters because electron-updater
 *   falls back to the FIRST entry when it cannot match an architecture.
 * @returns {string} merged YAML
 */
export function mergeUpdateFeeds(sources) {
  if(!Array.isArray(sources) || sources.length === 0) {
    throw new Error('no feed files given');
  }

  const docs = sources.map((raw, i) => {
    const doc = load(raw);
    if(!doc || typeof doc !== 'object') throw new Error(`feed ${i} is not a YAML mapping`);
    if(typeof doc.version !== 'string' || doc.version.length === 0) throw new Error(`feed ${i} has no version`);
    if(!Array.isArray(doc.files) || doc.files.length === 0) throw new Error(`feed ${i} has no files[]`);
    return doc;
  });

  const [base] = docs;

  for(const doc of docs.slice(1)) {
    // Two feeds from different versions means the build matrix disagreed
    // about what it was building. Publishing that would offer users a
    // mixture of two releases.
    if(doc.version !== base.version) {
      throw new Error(`version mismatch between feeds: ${base.version} vs ${doc.version}`);
    }
  }

  const files = [];
  const seen = new Set();
  for(const doc of docs) {
    for(const file of doc.files) {
      if(!file || typeof file.url !== 'string' || typeof file.sha512 !== 'string') {
        throw new Error(`malformed file entry in feed for ${doc.version}`);
      }
      // A duplicate url means the same artifact was uploaded twice — the
      // exact clobbering this script exists to prevent, so shout about it.
      if(seen.has(file.url)) {
        throw new Error(`duplicate artifact across feeds: ${file.url}`);
      }
      seen.add(file.url);
      files.push(file);
    }
  }

  const merged = {...base, files};
  // Keep the base's top-level path/sha512: they are the legacy single-file
  // fields old clients read, and they must agree with files[0].
  merged.path = files[0].url;
  merged.sha512 = files[0].sha512;

  return dump(merged, {lineWidth: -1, noRefs: true});
}

// CLI
if(process.argv[1] && process.argv[1].endsWith('merge-update-feed.mjs')) {
  const [out, ...inputs] = process.argv.slice(2);
  if(!out || inputs.length === 0) {
    console.error('usage: merge-update-feed.mjs <out.yml> <in.yml> [in.yml ...]');
    process.exit(2);
  }
  const merged = mergeUpdateFeeds(inputs.map((f) => readFileSync(f, 'utf8')));
  writeFileSync(out, merged, 'utf8');
  console.log(`merged ${inputs.length} feed(s) into ${out}`);
  console.log(merged);
}
