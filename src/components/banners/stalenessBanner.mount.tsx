import {render} from 'solid-js/web';
import {StalenessBanner} from './stalenessBanner';

export async function showStalenessBanner(version: string, onUpdate: () => Promise<void>) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const dispose = render(() => (
    <StalenessBanner
      version={version}
      onUpdate={async() => {
        await onUpdate();
        dispose();
        host.remove();
      }}
      onDismiss24h={() => {
        localStorage.setItem('nostra.update.staleness_snooze', String(Date.now() + 24 * 60 * 60 * 1000));
        dispose();
        host.remove();
      }}
    />
  ), host);
}
