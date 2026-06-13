import {render} from 'solid-js/web';
import {FirstInstallInfo, markFirstInstallSeen} from './index';

export function showFirstInstallInfoPopup(fingerprint: string, version: string) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center';
  document.body.appendChild(host);
  const dispose = render(() => (
    <FirstInstallInfo
      fingerprint={fingerprint}
      version={version}
      onDismiss={() => {
        markFirstInstallSeen();
        dispose();
        host.remove();
      }}
    />
  ), host);
}
