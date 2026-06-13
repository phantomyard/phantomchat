import {createEffect, createSignal, onCleanup, onMount, Show} from 'solid-js';
import rootScope from '@lib/rootScope';
import classNames from '@helpers/string/classNames';
import type {RuntimeState} from '@lib/nostra/privacy-transport';

/**
 * Global startup banner — mounted ONLY in Tor-only mode by nostra-bridge.
 * Renders:
 *   - booting     → dark bar with spinner, text "Connecting via Tor — messages queued"
 *   - tor-active  → transient green "Connected via Tor" that fades away
 *   - everything else → hidden
 *
 * No Skip, Retry, or Continue-without-Tor buttons — the mode switch
 * (Privacy & Security → Tor) is the only escape hatch now.
 */
export default function TorStartupBanner() {
  const [state, setState] = createSignal<RuntimeState>('booting');
  const [fading, setFading] = createSignal(false);
  const [hidden, setHidden] = createSignal(false);

  const setBannerHeightVar = (px: number) => {
    document.documentElement.style.setProperty('--tor-banner-height', `${px}px`);
  };

  onMount(() => {
    const handler = (e: {state: RuntimeState; error?: string}) => {
      const prev = state();
      setState(e.state);
      if(e.state === 'booting') {
        setHidden(false);
        setFading(false);
      }
      if(e.state === 'tor-active' && prev === 'booting') {
        setFading(false);
        const fadeTimer = setTimeout(() => setFading(true), 2500);
        const hideTimer = setTimeout(() => setHidden(true), 3200);
        onCleanup(() => {
          clearTimeout(fadeTimer);
          clearTimeout(hideTimer);
        });
      }
      if(e.state === 'direct-active' || e.state === 'offline') {
        setHidden(true);
      }
    };
    rootScope.addEventListener('nostra_tor_state', handler);
    const t = (window as any).__nostraTransport;
    if(t?.getRuntimeState) {
      const s: RuntimeState = t.getRuntimeState();
      setState(s);
      if(s === 'tor-active' || s === 'direct-active' || s === 'offline') {
        setHidden(true);
      }
    }
    onCleanup(() => {
      rootScope.removeEventListener('nostra_tor_state', handler);
      setBannerHeightVar(0);
    });
  });

  createEffect(() => {
    const _hidden = hidden();
    const _state = state();
    const _fading = fading();
    if(_hidden) {
      setBannerHeightVar(0);
      return;
    }
    // Keep the reserved space during fade-out.
    setBannerHeightVar(40);
  });

  return (
    <Show when={!hidden()}>
      <Show when={state() === 'booting'}>
        <div class="tor-startup-banner tor-startup-banner--bootstrap">
          <div class="tor-startup-banner__inner">
            <span class="tor-startup-banner__spinner" aria-hidden="true"></span>
            <span class="tor-startup-banner__text">
              Connecting via Tor — your messages will be queued until the circuit is ready.
            </span>
          </div>
        </div>
      </Show>

      <Show when={state() === 'tor-active'}>
        <div
          class={classNames(
            'tor-startup-banner',
            'tor-startup-banner--active',
            fading() && 'tor-startup-banner--fading'
          )}
        >
          <div class="tor-startup-banner__inner">
            <span class="tor-startup-banner__text">Connected via Tor</span>
          </div>
        </div>
      </Show>
    </Show>
  );
}
