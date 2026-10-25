import 'fake-indexeddb/auto';
import {build} from 'esbuild';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

export async function stateSmoke(stableTree, previewTree) {
  mkdirSync('.channel-build', {recursive: true});
  const dir = mkdtempSync(resolve('.channel-build/state-'));
  const stores = [];
  try {
    for(const [name, tree] of [['stable', stableTree], ['preview', previewTree]]) {
      const outfile = join(dir, name + '.mjs');
      await build({entryPoints: [join(tree, 'src/lib/phantomchat/message-store.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent'});
      const {MessageStore} = await import(pathToFileURL(outfile).href);
      stores.push(MessageStore);
    }
    const [Stable, Preview] = stores;
    let store = new Stable();
    const row = {eventId: 'a'.repeat(64), conversationId: 'channel-fixture', senderPubkey: 'b'.repeat(64), content: 'existing history', type: 'text', timestamp: 1700000000, deliveryState: 'sent', mid: 100, twebPeerId: 1000000000000001};
    await store.saveMessage(row);
    await store.setReadCursor(row.conversationId, 100);
    await store.destroy();
    store = new Preview();
    try {
      assert.equal((await store.getMessages(row.conversationId))[0].content, row.content);
      assert.equal(await store.getReadCursor(row.conversationId), 100);
      await store.saveMessage({...row, eventId: 'c'.repeat(64), mid: 101, timestamp: row.timestamp + 1, content: 'written in Preview'});
      await store.setReadCursor(row.conversationId, 101);
    } finally { await store.destroy(); }
    store = new Stable();
    try {
      const rows = await store.getMessages(row.conversationId);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].content, 'written in Preview');
      assert.equal(await store.getReadCursor(row.conversationId), 101);
      await store.saveMessage({...row, eventId: 'd'.repeat(64), mid: 102, timestamp: row.timestamp + 2});
    } finally { await store.destroy(); }
    console.log('Stable → Preview → Stable: existing messages, Preview writes and read cursors passed');
  } finally { rmSync(dir, {recursive: true, force: true}); }
}
