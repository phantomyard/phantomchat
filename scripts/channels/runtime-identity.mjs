import assert from 'node:assert/strict';

export async function createDisposableIdentity(page) {
  await page.getByRole('button', {name: 'Create New Identity', exact: true}).click();
  await page.getByRole('button', {name: 'Continue', exact: true}).click();
  await page.getByRole('button', {name: 'Skip', exact: true}).click();
  return identityFingerprint(page);
}

export async function identityFingerprint(page, expected) {
  await page.waitForFunction(() => !!window.__phantomchatChatAPI, undefined, {timeout: 60000});
  const actual = await page.evaluate(async() => {
    const request = indexedDB.open('PhantomChat.chat');
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const tx = db.transaction(['nostr-identity', 'nostr-keys']);
      const identityRequest = tx.objectStore('nostr-identity').get('current');
      const keyRequest = tx.objectStore('nostr-keys').get('browser-key');
      const read = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const [identity, key] = await Promise.all([read(identityRequest), read(keyRequest)]);
      if(!identity || !key) throw new Error('Existing encrypted identity or wrapping key missing');
      const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: identity.iv}, key.key, identity.encryptedKeys);
      const hash = await crypto.subtle.digest('SHA-256', plain);
      return {npub: identity.npub, keyExtractable: key.key.extractable, fingerprint: Array.from(new Uint8Array(hash)).join(',')};
    } finally { db.close(); }
  });
  assert.equal(actual.keyExtractable, false);
  assert.match(actual.npub, /^npub1/);
  if(expected) assert.deepEqual(actual, expected);
  return actual;
}

export async function writeOfflineMessage(page, id, mid) {
  await page.waitForFunction(() => !!window.__phantomchatChatAPI);
  await page.evaluate(({id, mid}) => {
    const api = window.__phantomchatChatAPI;
    // Published NIP-06 test-vector public key, never a real contact. All network
    // traffic is blocked by the surrounding harness; test durable sends only.
    void api.connect('17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917').catch(() => {});
    void api.sendText(id, {messageId: id, mid, twebPeerId: 1000000000000001}).catch(() => {});
  }, {id, mid});
  await assertOfflineMessage(page, id, mid);
}

export async function assertOfflineMessage(page, id, mid) {
  await page.waitForFunction(async({id, mid}) => {
    const request = indexedDB.open('phantomchat-messages');
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      if(!db.objectStoreNames.contains('messages')) return false;
      const get = db.transaction('messages').objectStore('messages').index('eventId').get(id);
      const row = await new Promise((resolve, reject) => { get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); });
      return row?.content === id && row.mid === mid && row.twebPeerId === 1000000000000001;
    } finally { db.close(); }
  }, {id, mid}, {timeout: 30000});
}

export async function openChannelSettings(page) {
  await page.locator('.sidebar-tools-button').first().click();
  await page.locator('.btn-menu-item').filter({hasText: 'Settings'}).first().click();
  await page.getByRole('combobox', {name: 'Release channel'}).waitFor();
}
