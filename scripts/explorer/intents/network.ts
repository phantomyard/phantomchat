import {z} from 'zod';
import type {IntentDef, IntentResult} from './types';
import type {AtomicAction} from '../types';
import type {FuzzContext} from '../../../src/tests/fuzz/types';

const ToggleOfflineParams = z.object({
  user: z.enum(['userA', 'userB']),
  offline: z.boolean()
});

const SlowNetworkParams = z.object({
  user: z.enum(['userA', 'userB']),
  downloadKbps: z.number().int().min(1).max(10_000),
  uploadKbps: z.number().int().min(1).max(10_000)
});

const RelayUrlParams = z.object({
  user: z.enum(['userA', 'userB']),
  relayUrl: z.string().min(5)
});

const pageOf = (u: 'userA'|'userB'): 'A'|'B' => u === 'userA' ? 'A' : 'B';

export const toggle_offline: IntentDef<z.infer<typeof ToggleOfflineParams>> = {
  name: 'toggle_offline',
  area: 'network',
  paramsSchema: ToggleOfflineParams,
  description: 'Set the user\'s browser context to offline (true) or online (false). Tests offline-queue behavior + reconnect.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    try {
      await ctx.users[params.user].context.setOffline(params.offline);
      return {
        ok: true,
        atomic_trace: [{type: 'evaluate', page: pageOf(params.user), script: `context.setOffline(${params.offline})`}],
        observations: []
      };
    } catch(err: any) {
      return {ok: false, atomic_trace: [], observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const slow_network: IntentDef<z.infer<typeof SlowNetworkParams>> = {
  name: 'slow_network',
  area: 'network',
  paramsSchema: SlowNetworkParams,
  description: 'Throttle the user\'s context bandwidth via CDP. Tests slow-connection behavior.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    try {
      const cdp = await ctx.users[params.user].context.newCDPSession(ctx.users[params.user].page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 100,
        downloadThroughput: (params.downloadKbps * 1024) / 8,
        uploadThroughput: (params.uploadKbps * 1024) / 8
      });
      return {
        ok: true,
        atomic_trace: [{type: 'evaluate', page: pageOf(params.user), script: `CDP throttle ${params.downloadKbps}/${params.uploadKbps} kbps`}],
        observations: []
      };
    } catch(err: any) {
      return {ok: false, atomic_trace: [], observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const disconnect_relay: IntentDef<z.infer<typeof RelayUrlParams>> = {
  name: 'disconnect_relay',
  area: 'network',
  paramsSchema: RelayUrlParams,
  description: 'Block a specific relay URL via Playwright route. Tests relay-drop recovery.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    try {
      await ctx.users[params.user].context.route(`**/${params.relayUrl}/**`, (route) => route.abort('connectionrefused'));
      return {
        ok: true,
        atomic_trace: [{type: 'evaluate', page: pageOf(params.user), script: `block ${params.relayUrl}`}],
        observations: []
      };
    } catch(err: any) {
      return {ok: false, atomic_trace: [], observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const reconnect_relay: IntentDef<z.infer<typeof RelayUrlParams>> = {
  name: 'reconnect_relay',
  area: 'network',
  paramsSchema: RelayUrlParams,
  description: 'Unblock a previously blocked relay URL.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    try {
      await ctx.users[params.user].context.unroute(`**/${params.relayUrl}/**`);
      return {
        ok: true,
        atomic_trace: [{type: 'evaluate', page: pageOf(params.user), script: `unblock ${params.relayUrl}`}],
        observations: []
      };
    } catch(err: any) {
      return {ok: false, atomic_trace: [], observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const networkIntents: Record<string, IntentDef<any>> = {
  toggle_offline: toggle_offline as IntentDef<any>,
  slow_network: slow_network as IntentDef<any>,
  disconnect_relay: disconnect_relay as IntentDef<any>,
  reconnect_relay: reconnect_relay as IntentDef<any>
};
