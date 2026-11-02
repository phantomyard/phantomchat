// @ts-nocheck
/**
 * #276 against the real thing: the Electron main process, the bundled runtime,
 * real gift-wraps over an isolated relay, and a fake openai-completions server
 * standing in for PhantomOps. Native dialogs are the only stubbed part.
 *
 * Needs `pnpm app:build:electron` first and Vite running:
 *   pnpm start &
 *   FUZZ_APP_URL=http://localhost:8080 npx tsx src/tests/e2e/e2e-external-ai-desktop.ts
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {_electron as electron} from 'playwright';
import {finalizeEvent, generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {Relay} from 'nostr-tools/relay';
import {useIsolatedNetwork} from './helpers/isolated-network';
import {LocalRelay} from './helpers/local-relay';
import {dismissOverlays} from './helpers/dismiss-overlays';
import {
  createGiftWrap, createRumor, createSeal, unwrapNip17Message
} from '../../lib/phantomchat/nostr-crypto';

useIsolatedNetwork();

const APP_URL = process.env.FUZZ_APP_URL || 'http://localhost:8080';
const work = mkdtempSync(join(tmpdir(), 'external-ai-e2e-'));
const home = join(work, 'home');
const userData = join(work, 'userData');
mkdirSync(join(home, '.pi', 'agent'), {recursive: true});
const STANDALONE_AUTH = JSON.stringify({openai: {type: 'api_key', key: 'STANDALONE-KEY'}});
const STANDALONE_SETTINGS = JSON.stringify({defaultProvider: 'openai'});
writeFileSync(join(home, '.pi', 'agent', 'auth.json'), STANDALONE_AUTH);
writeFileSync(join(home, '.pi', 'agent', 'settings.json'), STANDALONE_SETTINGS);
writeFileSync(join(home, 'AGENTS.md'), 'STANDALONE-INSTRUCTIONS');

const pass = (label) => console.log('PASS', label);

// --- A fake gateway ----------------------------------------------------------
const requests = [];
let gatewayEfforts = null;
const gateway = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => body += d);
  req.on('end', () => {
    if(req.url.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({object: 'list', data: [
        {id: 'phantomops/auto'},
        {id: 'gateway/one', ...(gatewayEfforts ? {efforts: gatewayEfforts} : {})}
      ]}));
      return;
    }
    const json = JSON.parse(body);
    requests.push({auth: req.headers.authorization, json});
    const last = json.messages[json.messages.length - 1];
    const text = JSON.stringify(last.content);
    const send = (obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    res.setHeader('content-type', 'text/event-stream');
    if(last.role === 'user' && text.includes('MAKEFILE')) {
      send({id: 'x', choices: [{index: 0, delta: {role: 'assistant', tool_calls: [{index: 0, id: 'c1', type: 'function', function: {
        name: 'bash',
        arguments: JSON.stringify({command: 'echo made-by-tool > made.txt; pwd'})
      }}]}}]});
      send({id: 'x', choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}]});
    } else {
      const reply = last.role === 'tool' ? 'tool-finished' : `answer-${requests.length}`;
      send({id: 'x', choices: [{index: 0, delta: {role: 'assistant', content: reply}}]});
      send({id: 'x', choices: [{index: 0, delta: {}, finish_reason: 'stop'}]});
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

async function main() {
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}/api/v1`;

  const relay = new LocalRelay();
  await relay.start();
  const tap = await Relay.connect(relay.url);

  const app = await electron.launch({
    executablePath: resolve('node_modules/electron/dist/electron'),
    args: ['electron/dist/main.cjs', '--no-sandbox', `--user-data-dir=${userData}`],
    env: {
      // Only what a display needs: a provider key in the environment counts as configured.
      PATH: process.env.PATH,
      DISPLAY: process.env.DISPLAY,
      XAUTHORITY: process.env.XAUTHORITY,
      HOME: home,
      VITE_DEV_SERVER_URL: APP_URL,
      PHANTOMCHAT_PHANTOMOPS_BASE_URL: gatewayUrl
    },
    timeout: 60000
  });
  const setDialogAnswer = async(answer) => {
    await app.evaluate(({dialog}, answer) => {
      globalThis.__dialogs = globalThis.__dialogs ?? [];
      dialog.showMessageBox = async(...args) => {
        const options = args[args.length - 1];
        globalThis.__dialogs.push(options.message);
        return {response: answer, checkboxChecked: false};
      };
    }, answer);
  };
  const dialogsShown = () => app.evaluate(() => globalThis.__dialogs ?? []);
  await setDialogAnswer(0);

  app.process().stderr?.on('data', (d) => {
    const line = String(d);
    if(process.env.E2E_MAIN_LOG === '1' && !/GPU|TU:|viz_main|gbm|dri/.test(line)) console.error('[main]', line.trim());
  });

  const context = app.context();
  await relay.injectInto(context);
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  if(process.env.E2E_MAIN_LOG === '1') {
    page.on('console', (m) => {
      if(process.env.E2E_ALL_LOG === '1' || /LocalAi|local AI|GroupAPI|OnboardingIntegration/i.test(m.text())) console.error('[page]', m.type(), m.text().slice(0, 300));
    });
  }

  try {
    await page.waitForLoadState('load');
    await page.reload({waitUntil: 'load', timeout: 90000});
    await page.waitForTimeout(8000);
    await dismissOverlays(page);
    const gotIt = page.getByRole('button', {name: 'Got it'});
    if(await gotIt.isVisible().catch(() => false)) await gotIt.click({force: true});
    await page.getByRole('button', {name: 'Create New Identity'}).click({force: true, timeout: 60000});
    await page.waitForTimeout(2000);
    const npub = await page.evaluate(() => {
      for(const e of document.querySelectorAll('*')) {
        if(e.children.length === 0 && e.textContent?.includes('npub1')) return e.textContent.trim();
      }
      return '';
    });
    const ownerHex = nip19.decode(npub).data;
    await dismissOverlays(page);
    await page.getByRole('button', {name: 'Continue'}).click({force: true});
    await page.waitForTimeout(2000);
    await page.getByRole('textbox').fill('Principal');
    await dismissOverlays(page);
    await page.getByRole('button', {name: 'Get Started'}).click({force: true});
    await page.waitForFunction(() => !!window.appImManager?.setPeer && !!window.__phantomchatChatAPI, undefined, {timeout: 60000});
    await page.waitForTimeout(5000);
    await dismissOverlays(page);

    const ai = (channel, ...args) => page.evaluate(([channel, args]) => window.phantomchatDesktop.localAi[channel](...args), [channel, args]);

    // --- Providers -----------------------------------------------------------
    const initial = await ai('list-providers');
    assert.equal(initial.ok, true);
    assert.equal(initial.value[0].id, 'phantomops', 'PhantomOps is featured first');
    assert.equal(initial.value[0].configured, false);
    assert.ok(initial.value.length > 30, 'the catalog is listed');
    assert.ok(!initial.value.find((p) => p.id === 'openai').configured, 'a standalone key is not read');
    assert.deepEqual(await ai('list-external-ai'), [], 'nothing before a provider is configured');
    assert.ok(!(await ai('create-first-external-ai')).value, 'no automatic contact with no provider');
    pass('catalog and auth status; standalone install not read');

    // The real screen: Settings, Providers, type the token, Save.
    await page.evaluate(async() => {
      const {default: Tab} = await import('/src/components/sidebarLeft/tabs/phantomchatDesktopProviders.ts');
      const {default: appSidebarLeft} = await import('/src/components/sidebarLeft/index.ts');
      appSidebarLeft.createTab(Tab).open();
    });
    const tab = page.locator('.phantomchat-desktop-providers');
    await tab.locator('input[placeholder^="Personal API token"]').fill('pok_e2e_token');
    await tab.locator('button', {hasText: 'Save'}).first().click();
    await tab.locator('.row', {hasText: 'External AI'}).first().waitFor({timeout: 30000});
    await page.screenshot({path: join(work, 'providers.png')});

    const providers = await ai('list-providers');
    assert.equal(providers.value[0].configured, true);
    const authFile = readFileSync(join(userData, 'local-ai', 'pi-agent', 'auth.json'), 'utf8');
    assert.ok(authFile.includes('pok_e2e_token'), 'the token is in the private native store');
    const models = readFileSync(join(userData, 'local-ai', 'pi-agent', 'models.json'), 'utf8');
    assert.ok(!models.includes('pok_e2e_token'), 'and not in models.json');
    pass('PhantomOps set up with a token alone; secret in the native store only');

    const list = await ai('list-external-ai');
    assert.equal(list.length, 1, 'the first External AI was created automatically');
    assert.equal(list[0].name, 'External AI');
    assert.ok(!('secretKey' in list[0]), 'no nsec over IPC');
    const aiPubkey = list[0].pubkey;
    assert.ok(!(await ai('create-first-external-ai')).value, 'and only once');
    pass('first External AI created once, no nsec reaches the renderer');

    const peerId = await page.evaluate(async(pubkey) => {
      const {PhantomChatBridge} = await import('/src/lib/phantomchat/phantomchat-bridge.ts');
      return PhantomChatBridge.getInstance().mapPubkeyToPeerId(pubkey);
    }, aiPubkey);
    let pinned = false;
    for(let i = 0; i < 60 && !pinned; i++) {
      pinned = await page.evaluate(async(peerId) => {
        const dialog = await window.rootScope.managers.appMessagesManager.getDialogOnly(peerId);
        return !!dialog?.pFlags?.pinned;
      }, peerId);
      if(!pinned) await page.waitForTimeout(500);
    }
    if(!pinned) {
      console.error('DIAG', await page.evaluate(async(peerId) => {
        const m = window.rootScope.managers.appMessagesManager;
        const d = await m.getDialogOnly(peerId);
        const {getMessageStore} = await import('/src/lib/phantomchat/message-store.ts');
        return JSON.stringify({peerId, d: d ? d.pFlags : null, rows: document.querySelectorAll('.chatlist-chat').length, attrs: [...document.querySelectorAll('.chatlist-chat')].map((e) => e.getAttribute('data-peer-id'))});
      }, peerId));
    }
    assert.equal(pinned, true, 'pinned');
    await page.locator(`.chatlist-chat[data-peer-id="${peerId}"]`, {hasText: "I'm External AI"}).first().waitFor({state: 'attached', timeout: 10000});
    pass('pinned');

    // Kind 0 went out as a bot under its own npub.
    const profile = await new Promise((resolve) => {
      const sub = tap.subscribe([{kinds: [0], authors: [aiPubkey]}], {onevent: (e) => {
        sub.close();
        resolve(JSON.parse(e.content));
      }});
    });
    assert.equal(profile.bot, true);
    pass('own npub, kind-0 bot');

    // --- Chat, through the real composer -------------------------------------
    await page.evaluate((peerId) => window.appImManager.setPeer({peerId}), peerId);
    const input = page.locator('.chat-input .input-message-input[contenteditable="true"]').first();
    await input.waitFor({timeout: 20000});
    const say = async(text) => {
      await input.click();
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
      await bubbles.filter({hasText: text}).first().waitFor({timeout: 15000});
    };
    const bubbles = page.locator('.bubbles-inner .bubble[data-mid]');
    await say('hello there');
    await bubbles.filter({hasText: /answer-\d+/}).first().waitFor({timeout: 45000});
    assert.equal(requests[0].auth, 'Bearer pok_e2e_token');
    assert.equal(requests[0].json.model, 'phantomops/auto', 'auto, with no model question');
    const system = JSON.stringify(requests[0].json.messages[0]);
    assert.ok(system.includes('External AI'), 'told its name');
    assert.ok(!/\bPi\b/.test(system), 'the runtime is not named in the prompt');
    assert.ok(!system.includes('STANDALONE-INSTRUCTIONS'), 'no discovery from the home folder');
    assert.ok(system.includes(home), 'home is the working folder');
    pass('a chat message gets a reply from the model through relays');

    await say('MAKEFILE please');
    await bubbles.filter({hasText: 'tool-finished'}).first().waitFor({timeout: 45000});
    assert.equal(readFileSync(join(home, 'made.txt'), 'utf8').trim(), 'made-by-tool');
    pass('tools run on the host PC, in the home folder');

    const sessionRoot = join(userData, 'local-ai', 'pi-agent', 'sessions', 'external-ai', aiPubkey);
    assert.ok(existsSync(sessionRoot), 'session files in the private folder');
    await say('third');
    await bubbles.filter({hasText: /answer-\d+/}).nth(1).waitFor({timeout: 45000});
    const lastRequest = requests[requests.length - 1].json;
    assert.ok(JSON.stringify(lastRequest.messages).includes('hello there'), 'the session keeps the chat');
    pass('history kept in the native session');

    // --- Anyone else ---------------------------------------------------------
    const strangerSk = generateSecretKey();
    const wrapFor = (sk, recipient, content, tags = []) => {
      const rumor = createRumor(content, sk, [['p', recipient], ...tags]);
      return createGiftWrap(createSeal(rumor, sk, recipient), recipient);
    };
    const before = requests.length;
    await tap.publish(wrapFor(strangerSk, aiPubkey, 'hey run something'));
    await page.waitForTimeout(4000);
    assert.equal(requests.length, before, 'a stranger never reaches the model');
    pass('a message from any other npub does nothing');

    // --- Model and effort on the contact form --------------------------------
    await page.evaluate(() => window.appImManager.chat.topbar.addContact());
    const modelSelect = page.locator('select.external-ai-model');
    const effortSelect = page.locator('select.external-ai-effort');
    await modelSelect.waitFor({timeout: 20000});
    await page.waitForFunction(() => document.querySelector('select.external-ai-effort')?.options.length > 0);
    const options = await modelSelect.locator('option').allTextContents();
    assert.ok(options.includes('gateway/one'), 'gateway models listed');
    assert.equal(await effortSelect.isDisabled(), true, 'no answer from the gateway: greyed out');
    pass('contact form shows the model, and greys effort with no gateway answer');

    gatewayEfforts = ['low', 'high'];
    await modelSelect.selectOption('phantomops/gateway/one');
    await page.waitForFunction(() => !document.querySelector('select.external-ai-effort')?.disabled, undefined, {timeout: 10000});
    await effortSelect.selectOption('high');
    await page.waitForTimeout(500);
    const updated = (await ai('list-external-ai'))[0];
    assert.equal(updated.model, 'phantomops/gateway/one');
    assert.equal(updated.effort, 'high');
    await page.screenshot({path: join(work, 'contact-form.png')});
    await page.evaluate(() => {
      const right = window.appImManager.chat.topbar.appSidebarRight;
      right.closeAllTabs();
      right.toggleSidebar(false);
    });
    await page.waitForTimeout(600);
    const count = requests.length;
    await say('with the new model');
    for(let i = 0; i < 60 && requests.length === count; i++) await page.waitForTimeout(500);
    assert.equal(requests[count].json.model, 'gateway/one', 'applies to the next message');
    assert.equal(requests[count].json.reasoning_effort, 'high', 'and sends the effort');
    pass('effort enables when the gateway answers; a change applies to the next message');
    await ai('update-external-ai', aiPubkey, {model: null, effort: null});

    // --- Local PC access: a stand-in for a remote phantom --------------------
    const phantomSk = generateSecretKey();
    const phantom = getPublicKey(phantomSk);
    const inbox = [];
    tap.subscribe([{kinds: [1059], '#p': [phantom]}], {onevent: (e) => {
      try {
        const rumor = unwrapNip17Message(JSON.parse(JSON.stringify(e)), phantomSk);
        if(rumor.tags.some((t) => t[0] === 'phantomchat-local-tools')) {
          const body = JSON.parse(rumor.content);
          // What keeps a phantom or an older client from treating this as a message.
          assert.equal(body.type, 'phantomchat-local-tools');
          assert.ok(rumor.tags.some((t) => t[0] === 'control' && t[1] === 'true'));
          inbox.push(body);
        }
      } catch{ /* not for us */ }
    }});
    const toolTag = [['phantomchat-local-tools', '1'], ['control', 'true']];
    const sendCall = (body, sk = phantomSk) => tap.publish(wrapFor(sk, ownerHex, JSON.stringify({type: 'phantomchat-local-tools', ...body}), toolTag));
    const waitFor = async(predicate, ms = 20000) => {
      const end = Date.now() + ms;
      while(Date.now() < end) {
        const hit = inbox.find(predicate);
        if(hit) return hit;
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    };
    const quiet = async(predicate, ms = 3500) => {
      await new Promise((r) => setTimeout(r, ms));
      return !inbox.some(predicate);
    };
    const contactPeer = await page.evaluate(async(pubkey) => {
      const {addP2PContact} = await import('/src/lib/phantomchat/add-p2p-contact.ts');
      return (await addP2PContact({pubkey, nickname: 'Remote Phantom', source: 'e2e'})).peerId;
    }, phantom);

    const baseCall = (extra = {}) => ({
      t: 'call',
      callId: 'c' + Math.random().toString(36).slice(2),
      deviceId: 'unknown',
      tool: 'bash',
      args: {command: 'echo from-local-tool'},
      expiresAt: Date.now() + 60000,
      ...extra
    });

    await sendCall({t: 'hello'});
    assert.ok(await quiet((m) => m.t === 'capability'), 'capability is not advertised with the switch OFF');
    await sendCall(baseCall({callId: 'off-call'}));
    assert.ok(await quiet((m) => m.callId === 'off-call'), 'switch OFF gets nothing');
    pass('switch OFF: not advertised, nothing runs');

    // The real switch in contact info, with the native dialog.
    await page.evaluate((peerId) => window.appImManager.setPeer({peerId}), contactPeer);
    // This contact's info, on the right.
    await page.evaluate(() => {
      window.appImManager.chat.topbar.appSidebarRight.toggleSidebar(true);
    });
    await page.waitForTimeout(1000);
    const switchRow = page.locator('.row', {hasText: 'Local PC access'}).first();
    await switchRow.waitFor({timeout: 20000});
    await page.screenshot({path: join(work, 'contact-info.png')});

    await setDialogAnswer(1);
    await switchRow.click();
    await page.waitForTimeout(800);
    assert.deepEqual(await ai('local-access-enabled'), [], 'declining leaves it OFF');
    assert.equal(await switchRow.locator('input[type=checkbox]').isChecked(), false, 'and the toggle follows');
    await setDialogAnswer(0);
    const dialogsBefore = (await dialogsShown()).length;
    await switchRow.click();
    const capability = await waitFor((m) => m.t === 'capability');
    assert.ok(capability, 'the switch ON tells that contact');
    assert.deepEqual(await ai('local-access-enabled'), [phantom]);
    assert.ok((await dialogsShown()).length === dialogsBefore + 1, 'one dialog');
    const {deviceId} = capability;
    pass('Allow dialog gates the switch; declined stays OFF');

    await sendCall(baseCall({callId: 'run-1', deviceId}));
    const result = await waitFor((m) => m.t === 'result' && m.callId === 'run-1');
    assert.ok(result, 'a result comes back');
    const parsed = JSON.parse(result.data);
    assert.equal(parsed.exit ?? 0, 0);
    assert.ok(parsed.output.includes('from-local-tool'));
    assert.equal((await dialogsShown()).length, dialogsBefore + 1, 'no prompt per call');
    pass('a command runs with no provider needed and no prompt per call');

    await sendCall(baseCall({callId: 'read-1', deviceId, tool: 'read', args: {path: join(home, 'made.txt')}}));
    const readResult = await waitFor((m) => m.t === 'result' && m.callId === 'read-1');
    assert.ok(JSON.parse(readResult.data).output.includes('made-by-tool'));
    pass('a local file can be read');

    await sendCall(baseCall({callId: 'other-device', deviceId: 'f'.repeat(32)}));
    await sendCall(baseCall({callId: 'expired', deviceId, expiresAt: Date.now() - 1}));
    assert.ok(await quiet((m) => m.callId === 'other-device' || m.callId === 'expired'), 'neither runs');
    pass('another device id, or past expiry, does not run');

    await sendCall(baseCall({callId: 'stranger', deviceId}), strangerSk);
    assert.ok(await quiet((m) => m.callId === 'stranger'));
    pass('an unknown npub gets nothing');

    assert.equal(await bubbles.count(), 0, 'tool traffic is never a chat message');
    pass('tool traffic renders nothing');

    await sendCall(baseCall({callId: 'slow', deviceId, args: {command: 'sleep 30; echo late'}, timeoutMs: 60000}));
    await page.locator('.local-tools-indicator').waitFor({timeout: 15000});
    pass('indicator shows while a call runs');
    await switchRow.click();
    const cancelled = await waitFor((m) => m.t === 'result' && m.callId === 'slow', 10000);
    assert.ok(cancelled, 'the running call ends straight away');
    assert.equal(JSON.parse(cancelled.data).status, 'cancelled');
    assert.ok(await waitFor((m) => m.t === 'revoked'));
    await sendCall(baseCall({callId: 'after-off', deviceId}));
    assert.ok(await quiet((m) => m.callId === 'after-off'));
    await page.locator('.local-tools-indicator').waitFor({state: 'detached', timeout: 5000});
    pass('switch OFF cancels in-flight calls and refuses the next');

    const log = readFileSync(join(userData, 'local-ai', 'local-tools.log'), 'utf8');
    assert.ok(log.includes(phantom) && !log.includes('from-local-tool'), 'metadata only');
    pass('calls logged, metadata only');

    // --- Groups and Sessions --------------------------------------------------
    await page.reload({waitUntil: 'load', timeout: 90000});
    await page.waitForFunction(() => !!window.appImManager?.setPeer && !!window.__phantomchatChatAPI, undefined, {timeout: 60000});
    await page.waitForFunction(() => !!window.__phantomchatGroupAPI, undefined, {timeout: 30000});
    const groupResult = await page.evaluate(async({member}) => {
      const groupId = await window.__phantomchatGroupAPI.createGroup('with-ai', [member], undefined, {kind: 'session'});
      const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
      return {groupId, peerId: (await getGroupStore().get(groupId)).peerId};
    }, {member: aiPubkey});
    const countBefore = requests.length;
    await page.waitForTimeout(2000);
    await page.evaluate(({groupId}) => window.__phantomchatGroupAPI.sendMessage(groupId, 'hello in a session'), groupResult);
    for(let i = 0; i < 80 && requests.length === countBefore; i++) await page.waitForTimeout(500);
    assert.ok(requests.length > countBefore, 'the model ran for the session');
    await page.evaluate((peerId) => window.appImManager.setPeer({peerId}), groupResult.peerId);
    await bubbles.filter({hasText: /answer-\d+/}).first().waitFor({timeout: 30000});
    pass('answers in a Session, posting as itself');

    // Tools from a Session with a contact whose switch is ON, and from nowhere else.
    await setDialogAnswer(0);
    await ai('set-local-access', phantom, true, 'Remote Phantom');
    const {deviceId: reloadedDevice} = await ai('capability');
    const makeGroup = (member, kind) => page.evaluate(({member, kind}) =>
      window.__phantomchatGroupAPI.createGroup(`tools-${kind}`, [member], undefined, {kind}), {member, kind});
    const toolSession = await makeGroup(phantom, 'session');
    const plainGroup = await makeGroup(phantom, 'group');
    const strangerSession = await makeGroup(getPublicKey(generateSecretKey()), 'session');
    await sendCall(baseCall({callId: 'in-session', deviceId: reloadedDevice, groupId: toolSession}));
    assert.ok(await waitFor((m) => m.t === 'result' && m.callId === 'in-session'), 'a Session counts as the contact');
    await sendCall(baseCall({callId: 'in-group', deviceId: reloadedDevice, groupId: plainGroup}));
    await sendCall(baseCall({callId: 'not-a-member', deviceId: reloadedDevice, groupId: strangerSession}));
    assert.ok(await quiet((m) => m.callId === 'in-group' || m.callId === 'not-a-member'), 'other groups get nothing');
    await ai('set-local-access', phantom, false, 'Remote Phantom');
    await sendCall(baseCall({callId: 'session-off', deviceId: reloadedDevice, groupId: toolSession}));
    assert.ok(await quiet((m) => m.callId === 'session-off'), 'the same Session with the switch OFF gets nothing');
    pass('a Session runs tools with the switch ON, not with it OFF; other groups never');

    // A second one.
    const second = await page.evaluate(async() => {
      const {createExternalAi} = await import('/src/lib/phantomchat/local-ai.ts');
      return createExternalAi();
    });
    assert.equal(second.name, 'External AI 2');
    assert.notEqual(second.pubkey, aiPubkey);
    pass('New External AI adds another, with its own npub');

    // --- Delete --------------------------------------------------------------
    await setDialogAnswer(1);
    const refused = await page.evaluate(async(pubkey) => {
      const {confirmHostedDelete} = await import('/src/lib/phantomchat/local-ai.ts');
      return confirmHostedDelete(pubkey);
    }, second.pubkey);
    assert.equal(refused, false, 'cancel keeps it');
    assert.ok(existsSync(join(userData, 'local-ai', 'external-ai', second.pubkey, 'identity.json')));
    await setDialogAnswer(0);
    const accepted = await page.evaluate(async(pubkey) => {
      const {confirmHostedDelete} = await import('/src/lib/phantomchat/local-ai.ts');
      return confirmHostedDelete(pubkey);
    }, aiPubkey);
    assert.equal(accepted, true);
    assert.ok(!existsSync(join(userData, 'local-ai', 'external-ai', aiPubkey)), 'nsec destroyed');
    assert.ok(!existsSync(sessionRoot), 'history destroyed');
    assert.deepEqual((await ai('list-external-ai')).map((x) => x.pubkey), [second.pubkey]);
    pass('delete asks natively, then destroys the nsec and the history');

    // --- Standalone install, last, so everything above had its chance --------
    assert.equal(readFileSync(join(home, '.pi', 'agent', 'auth.json'), 'utf8'), STANDALONE_AUTH);
    assert.equal(readFileSync(join(home, '.pi', 'agent', 'settings.json'), 'utf8'), STANDALONE_SETTINGS);
    assert.deepEqual(readdirSync(join(home, '.pi', 'agent')).sort(), ['auth.json', 'settings.json']);
    pass('a standalone install on the machine is unchanged');

    console.log('ALL PASSED');
    console.log('screenshots in', work);
  } catch(err) {
    await page.screenshot({path: join(work, 'failure.png')}).catch(() => {});
    console.error('model requests:', requests.length, 'work dir:', work);
    throw err;
  } finally {
    await app.close().catch(() => {});
    tap.close();
    await relay.stop().catch(() => {});
    gateway.close();
    if(process.env.KEEP_E2E !== '1') rmSync(work, {recursive: true, force: true});
  }
}

main().catch((err) => {
  console.error('FAILED', err);
  process.exit(1);
});
