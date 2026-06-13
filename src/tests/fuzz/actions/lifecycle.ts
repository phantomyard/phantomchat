// @ts-nocheck
import type {ActionSpec, Action, FuzzContext} from '../types';
import * as fc from 'fast-check';

/**
 * Computes a SHA-256 hex digest of a string. Runs in browser via
 * page.evaluate — no Node deps.
 */
const BROWSER_SHA256 = async(input: string): Promise<string> => {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
};

export const reloadPage: ActionSpec = {
  name: 'reloadPage',
  weight: 3,
  generateArgs: () => fc.record({
    user: fc.constantFrom('userA', 'userB'),
    mode: fc.oneof(
      {weight: 2, arbitrary: fc.constant('pure' as const)},
      {weight: 1, arbitrary: fc.constant('during-pending-send' as const)}
    ),
    raceWindowMs: fc.option(fc.integer({min: 40, max: 200}), {nil: undefined}),
    pendingText: fc.string({minLength: 1, maxLength: 40})
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const userId: 'userA' | 'userB' = action.args.user;
    const user = ctx.users[userId];

    // Snapshot pre-reload state so INV-virtual-peer-id-stable and
    // INV-history-rehydrates-identical can diff.
    const snap: any = await user.page.evaluate(() => {
      const proxy = (window as any).apiManagerProxy;
      const peers = proxy?.mirrors?.peers || {};
      const peerMap: Record<string, number> = {};
      for(const [peerId, p] of Object.entries<any>(peers)) {
        if(p?.p2pPubkey) peerMap[p.p2pPubkey] = Number(peerId);
      }
      const mids = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'))
        .map((b) => (b as HTMLElement).dataset.mid as string)
        .filter(Boolean)
        .sort();
      return {peerMap, mids};
    });
    ctx.snapshots.set(`preReloadPeerMap-${userId}`, snap.peerMap);
    // Browser-side sha256 to avoid importing crypto in Node harness.
    const hist = await user.page.evaluate(BROWSER_SHA256, JSON.stringify(snap.mids));
    ctx.snapshots.set(`preReloadHistorySig-${userId}`, {sig: hist, count: snap.mids.length, mids: snap.mids});

    const raceWindowMs = action.args.raceWindowMs ?? 80;

    if(action.args.mode === 'during-pending-send') {
      // Ensure a chat is open so the send actually fires.
      await user.page.evaluate((pid: number) => {
        (window as any).appImManager?.setPeer?.({peerId: pid});
      }, user.remotePeerId);
      await user.page.waitForTimeout(200);
      // Verify chat is actually open before firing the send.
      const chatReady = await user.page.evaluate(() => !!(window as any).appImManager?.chat?.peerId);
      if(!chatReady) {
        action.skipped = true;
        action.meta = {mode: action.args.mode, raceWindowMs, reason: 'no chat available'};
        return action;
      }
      // Fire a send without awaiting. Use the existing sendText plumbing via
      // appMessagesManager so the pending send exercises the real pipeline.
      await user.page.evaluate(({t}: any) => {
        const rs: any = (window as any).rootScope;
        const peerId = (window as any).appImManager?.chat?.peerId;
        if(!rs?.managers?.appMessagesManager || !peerId) return;
        (window as any).__nostraPendingSend = rs.managers.appMessagesManager.sendText({peerId, text: t}).catch(() => {});
      }, {t: action.args.pendingText});
      await user.page.waitForTimeout(raceWindowMs);
    }

    try {
      await user.page.reload({waitUntil: 'load', timeout: 15000});
      user.reloadTimes.push(Date.now());
    } catch(err: any) {
      const errMsg = String(err?.message || err);
      user.consoleLog.push(`[reloadPage] reload failed: ${errMsg}`);
      action.skipped = true;
      action.meta = {mode: action.args.mode, raceWindowMs, reloadError: errMsg};
      return action;
    }

    // Wait for rehydrate: peer mirrors populated and chat inner container present.
    try {
      await user.page.waitForFunction(() => {
        const proxy = (window as any).apiManagerProxy;
        return !!proxy && !!proxy.mirrors && !!proxy.mirrors.peers;
      }, {timeout: 10000});
    } catch {
      // not fatal; invariants will fire if rehydrate was incomplete
    }

    action.meta = {mode: action.args.mode, raceWindowMs, pendingText: action.args.pendingText};
    return action;
  }
};

export const deleteWhileSending: ActionSpec = {
  name: 'deleteWhileSending',
  weight: 1,
  generateArgs: () => fc.record({
    user: fc.constantFrom('userA', 'userB'),
    raceWindowMs: fc.option(fc.integer({min: 40, max: 200}), {nil: undefined})
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const userId: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[userId];
    const peerId = sender.remotePeerId;
    const text = 'race-test-' + Date.now();
    const raceWindowMs = action.args.raceWindowMs ?? 80;

    // Open the chat first so sendMessage has a peerId to target.
    await sender.page.evaluate((pid: number) => {
      (window as any).appImManager?.setPeer?.({peerId: pid});
    }, peerId);
    await sender.page.waitForTimeout(200);

    // Fire send without awaiting.
    await sender.page.evaluate(({pid, t}: any) => {
      const rs: any = (window as any).rootScope;
      if(!rs?.managers?.appMessagesManager) return;
      (window as any).__nostraPendingSend = rs.managers.appMessagesManager.sendText({peerId: pid, text: t}).catch(() => {});
    }, {pid: peerId, t: text});

    await sender.page.waitForTimeout(raceWindowMs);

    // Look for the temp mid in the DOM or mirror.
    // P2P temp mids are integer base+1 (per CLAUDE.md generateTempMessageId rule),
    // same magnitude as real mids (~1.78e15). The DOM .is-sending bubble is the
    // most reliable detection. Fall back to fractional mirror scan for MTProto-legacy.
    const tempMid = await sender.page.evaluate((pid: number) => {
      // Primary: in-flight send bubble carries .is-sending class before mid rename.
      const sending = document.querySelector('.bubbles-inner .bubble.is-sending[data-mid], .bubbles-inner .bubble.is-outgoing[data-mid]') as HTMLElement | null;
      if(sending) {
        const m = Number(sending.dataset.mid);
        return Number.isNaN(m) ? null : m;
      }
      // Fallback for MTProto-legacy: fractional mids in the mirror (e.g. 0.0001).
      const proxy: any = (window as any).apiManagerProxy;
      const hist = proxy?.mirrors?.messages?.[`${pid}_history`] || {};
      const fractional = Object.keys(hist).map(Number).filter((m) => !Number.isNaN(m) && m % 1 !== 0);
      return fractional.length ? Math.max(...fractional) : null;
    }, peerId);

    if(tempMid != null) {
      try {
        await sender.page.evaluate(({pid, m}: any) => {
          const rs: any = (window as any).rootScope;
          return rs?.managers?.appMessagesManager?.deleteMessages?.(pid, [m], true);
        }, {pid: peerId, m: tempMid});
      } catch {
        // delete may race the send's mid rename — not fatal
      }
    }

    // Let the send complete either way.
    await sender.page.evaluate(() => (window as any).__nostraPendingSend?.catch?.(() => {}));

    action.meta = {raceWindowMs, tempMid, text};
    return action;
  }
};
