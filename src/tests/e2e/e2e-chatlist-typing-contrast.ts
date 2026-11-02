// @ts-nocheck
/**
 * Local Chromium regression: the "‹peer› is working" line must be visible on the
 * SELECTED chat-list row, in every UI theme.
 *
 * Symptom (2026-11-02, corporate light theme): opening a session made the row go
 * blank — no last-message preview, no working indicator — while the chat header
 * above still said "‹peer› is working". `_chatlist.scss` forced
 * `--color: #fff` on `.chatlist-chat.active .peer-typing-container` because the
 * active row is `--primary-color` (dark blue) on the default theme. The
 * boring-corporate theme — the DEFAULT theme — paints the active row
 * `--bc-selected` (#ffffff in light), and `_peerTyping.scss` consumes `--color`
 * as `color`, so the indicator rendered white-on-white.
 *
 * What is pinned here: on the active row, the typing line's computed colour
 * keeps a readable contrast against the row's own computed background, under
 * boring-corporate (light + night) AND Fun and Relaxed.
 *
 * Start Vite separately, then run:
 * FUZZ_APP_URL=http://127.0.0.1:8080 pnpm exec tsx src/tests/e2e/e2e-chatlist-typing-contrast.ts
 * Uses disposable identities and its own in-process relay; no Docker required.
 * CHROMIUM_PATH overrides the browser when Playwright's pinned build is absent.
 */
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {chromium} from 'playwright';
import {matchFilters} from 'nostr-tools';
import {bootHarness} from '../fuzz/harness';
import {LocalRelay} from './helpers/local-relay';

// An isolated NIP-01 relay avoids Docker permissions and shared test containers.
let relayServer: WebSocketServer;
LocalRelay.prototype.start = async function() {
  relayServer = new WebSocketServer({host: '127.0.0.1', port: 0});
  await new Promise<void>((resolve) => relayServer.once('listening', resolve));
  this.url = `ws://127.0.0.1:${relayServer.address().port}`;
  const events = new Map();
  const subscriptions = new Map();
  relayServer.on('connection', (socket) => {
    subscriptions.set(socket, new Map());
    socket.on('close', () => subscriptions.delete(socket));
    socket.on('message', (raw) => {
      const [kind, id, ...rest] = JSON.parse(String(raw));
      const send = (s, msg) => s.readyState === 1 && s.send(JSON.stringify(msg));
      if(kind === 'EVENT') {
        const event = id;
        events.set(event.id, event);
        send(socket, ['OK', event.id, true, '']);
        for(const [client, subs] of subscriptions) {
          for(const [sub, filters] of subs) {
            if(matchFilters(filters, event)) send(client, ['EVENT', sub, event]);
          }
        }
      } else if(kind === 'REQ') {
        subscriptions.get(socket).set(id, rest);
        for(const event of events.values()) {
          if(matchFilters(rest, event)) send(socket, ['EVENT', id, event]);
        }
        send(socket, ['EOSE', id]);
      } else if(kind === 'CLOSE') subscriptions.get(socket).delete(id);
    });
  });
};
LocalRelay.prototype.stop = async function() {
  for(const client of relayServer.clients) client.terminate();
  await new Promise<void>((resolve) => relayServer.close(() => resolve()));
};

// Keep onboarding independent of public profile/asset services. The actual
// messaging transport is the local relay above; all app assets come from Vite.
const launch = chromium.launch.bind(chromium);
chromium.launch = async(options) => {
  const browser = await launch({...options, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {})});
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async(contextOptions) => {
    const context = await newContext(contextOptions);
    context.on('page', (page) => {
      page.on('domcontentloaded', () => console.log('browser DOM loaded'));
      page.on('pageerror', (error) => console.error('browser pageerror:', error.message));
    });
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
    });
    return context;
  };
  return browser;
};

/** WCAG 2.1 relative luminance + contrast ratio, so the assert is not "looks off". */
function contrastRatio(foreground, background) {
  const parse = (rgb) => {
    const match = /rgba?\(([^)]+)\)/.exec(rgb);
    if(!match) throw new Error('unparsable colour: ' + rgb);
    return match[1].split(',').slice(0, 3).map((part) => parseFloat(part));
  };
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance = (rgb) => {
    const [r, g, b] = parse(rgb).map(channel);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = luminance(foreground);
  const b = luminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

async function main() {
  const {ctx, teardown} = await bootHarness({consoleBufferMax: 1500});
  const A = ctx.users.userA;
  const B = ctx.users.userB;
  const ready = async(page) => page.waitForFunction(() =>
    window.appImManager?.setPeer && window.__phantomchatChatAPI && window.__phantomchatGroupAPI,
  undefined, {timeout: 60000});
  try {
    await Promise.all([ready(A.page), ready(B.page)]);
    const group = await B.page.evaluate(async(other) => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      return getGroupAPI().createGroup('Typing contrast regression', [other]);
    }, A.pubkeyHex);
    let groupPeer;
    const deadline = Date.now() + 30000;
    while(!groupPeer && Date.now() < deadline) {
      groupPeer = await A.page.evaluate(async(gid) => {
        const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
        return (await getGroupStore().get(gid))?.peerId;
      }, group).catch(() => undefined);
      if(!groupPeer) await A.page.waitForTimeout(500);
    }
    assert.ok(groupPeer, 'group reached user A');

    const send = async(text) => {
      await B.page.evaluate(async({gid, content}) => {
        const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
        await getGroupAPI().sendMessage(gid, content);
      }, {gid: group, content: text});
    };
    const arrive = async(text) => {
      const limit = Date.now() + 30000;
      while(Date.now() < limit) {
        const found = await A.page.evaluate(async({gid, content}) => {
          const {getMessageStore} = await import('/src/lib/phantomchat/message-store.ts');
          const rows = await getMessageStore().getMessages(`group:${gid}`, 100);
          return rows.some((row) => row.content === content);
        }, {gid: group, content: text}).catch(() => false);
        if(found) return;
        await A.page.waitForTimeout(300);
      }
      throw new Error(`message never reached user A: ${text}`);
    };

    // The row has to exist with a preview before typing can replace it.
    await send('typing-contrast-baseline');
    await arrive('typing-contrast-baseline');
    await A.page.locator('[data-filter-id="3"]').first().click();
    const rowSelector = `.chatlist-chat[data-peer-id="${groupPeer}"]`;
    await A.page.locator(rowSelector).first().waitFor({timeout: 30000});

    // Selecting the row is the whole point: the reported bug only shows on the
    // ACTIVE row, because that is the state the hardcoded white lived under.
    await A.page.evaluate((peerId) => window.appImManager.setPeer({peerId}), groupPeer);
    await A.page.waitForFunction((selector) =>
      document.querySelector(selector)?.classList.contains('active'), rowSelector, {timeout: 15000});
    await A.page.waitForTimeout(500);

    const typing = async(stop) => A.page.evaluate(({chatId, from, stop}) =>
      window.rootScope.managers.apiUpdatesManager.processLocalUpdate({
        _: 'updateChatUserTyping',
        chat_id: chatId,
        from_id: {_: 'peerUser', user_id: from},
        action: {_: stop ? 'sendMessageCancelAction' : 'sendMessageTypingAction'}
      }), {chatId: Math.abs(groupPeer), from: A.remotePeerId, stop});

    const waitForTypingLine = async() => {
      const limit = Date.now() + 15000;
      while(Date.now() < limit) {
        const text = await A.page.evaluate((selector) =>
          document.querySelector(selector)?.querySelector('.peer-typing-container')?.textContent ?? null, rowSelector);
        if(text) return text;
        await A.page.waitForTimeout(250);
      }
      return null;
    };

    /** Applies a theme on <html> exactly the way the boot script and the day/night toggle do. */
    const applyTheme = async({uiTheme, night}) => A.page.evaluate(({uiTheme, night}) => {
      if(uiTheme) document.documentElement.setAttribute('data-ui-theme', uiTheme);
      else document.documentElement.removeAttribute('data-ui-theme');
      document.documentElement.classList.toggle('night', night);
    }, {uiTheme, night});

    await typing(false);
    assert.ok(await waitForTypingLine(), 'typing line must render on the active row');

    const measure = async() => A.page.evaluate((selector) => {
      const row = document.querySelector(selector);
      const container = row?.querySelector('.peer-typing-container');
      if(!container) return null;
      const rowStyle = getComputedStyle(row);
      return {
        text: container.textContent,
        colour: getComputedStyle(container).color,
        background: rowStyle.backgroundColor
      };
    }, rowSelector);

    const themes = [
      // Boring Corporate is the default theme, so this is the shape Andrew sees.
      {name: 'boring-corporate day', uiTheme: 'boring-corporate', night: false},
      {name: 'boring-corporate night', uiTheme: 'boring-corporate', night: true},
      // Fun and Relaxed has no attribute; its active row is the dark accent one
      // the old hardcoded white was written for — it must keep working.
      {name: 'fun and relaxed', uiTheme: null, night: false}
    ];

    for(const theme of themes) {
      await applyTheme(theme);
      await A.page.waitForTimeout(200);
      const state = await measure();
      assert.ok(state, `${theme.name}: typing line must still be mounted`);
      const ratio = contrastRatio(state.colour, state.background);
      console.log('CONTRAST', theme.name, JSON.stringify({...state, ratio: ratio.toFixed(2)}));
      assert.ok(
        ratio >= 3,
        `${theme.name}: "‹peer› is working" must be readable on the active row — ` +
        `colour ${state.colour} on row background ${state.background} is ${ratio.toFixed(2)}:1`
      );
      assert.ok(/\bis working\b/.test(state.text), `${theme.name}: row must carry the working line, got ${JSON.stringify(state.text)}`);
    }

    // Clearing the typing line must restore the last-message preview, not leave
    // the active row blank (the same symptom's other half).
    await applyTheme({uiTheme: 'boring-corporate', night: false});
    await typing(true);
    const limit = Date.now() + 15000;
    let preview = null;
    while(Date.now() < limit) {
      preview = await A.page.evaluate((selector) =>
        document.querySelector(selector)?.querySelector('.row-subtitle')?.textContent ?? null, rowSelector);
      if(preview?.includes('typing-contrast-baseline')) break;
      await A.page.waitForTimeout(250);
    }
    assert.ok(preview?.includes('typing-contrast-baseline'), `active row must fall back to the preview, got ${JSON.stringify(preview)}`);
    if(process.env.SHOT) await A.page.screenshot({path: process.env.SHOT});
    console.log('PASS the working line is readable on the active row in every theme');
  } catch(error) {
    console.error('USER A console', A.consoleLog.slice(-30).join('\n'));
    throw error;
  } finally {
    await teardown();
  }
}
main().then(() => process.exit(0)).catch((error) => {console.error(error); process.exit(1);});
