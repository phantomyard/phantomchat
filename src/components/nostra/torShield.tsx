import {createSignal, onMount, onCleanup} from 'solid-js';
import classNames from '@helpers/string/classNames';
import rootScope from '@lib/rootScope';
import type {RuntimeState} from '@lib/nostra/privacy-transport';

export default function TorShield(props: {
  onTap?: () => void;
}) {
  const [state, setState] = createSignal<RuntimeState>('booting');

  onMount(() => {
    const handler = (e: {state: RuntimeState; error?: string}) => {
      setState(e.state);
    };
    rootScope.addEventListener('nostra_tor_state', handler);
    onCleanup(() => {
      rootScope.removeEventListener('nostra_tor_state', handler);
    });
  });

  return (
    <div
      class={classNames('tor-shield', `tor-shield--${state()}`)}
      onClick={() => props.onTap?.()}
    >
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm0 2.18l6 2.25v4.66c0 4.15-2.8 8.02-6 9.01-3.2-.99-6-4.86-6-9.01V6.43l6-2.25z" />
      </svg>
    </div>
  );
}
