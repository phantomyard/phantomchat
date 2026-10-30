/*
 * Desktop-only entry point for the Updates tab (issue #164).
 *
 * The screen itself now lives in phantomchatApplicationUpdates.ts, because
 * the channel control must be identical whether the tab is reached from the
 * desktop build or from the channel-aware web build — and because
 * scripts/channels/build.mjs re-materialises that file into both channel
 * trees. Keeping one implementation is what stops the two radios from
 * drifting apart again (owner batch 8, 2026-10-30).
 *
 * Settings still imports this module dynamically so the tab stays out of the
 * main bundle, and so an older packaged build keeps resolving the same path.
 */
export {default} from '@components/sidebarLeft/tabs/phantomchatApplicationUpdates';
