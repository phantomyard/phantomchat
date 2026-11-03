// Scratch cleanup for the Electron smoke scripts. These run in `finally`, where a
// throw would replace the real failure: on Windows the just-closed Electron can
// still hold its profile, so rmSync raises EPERM and the log shows only that.
// A leftover scratch dir on a runner is harmless, so warn instead of failing.
import {rmSync} from 'node:fs';

export function removeScratch(dir, rm = rmSync) {
  try {
    rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 500});
  } catch(err) {
    console.warn(`Could not remove smoke scratch ${dir}: ${err?.message ?? err}`);
  }
}
