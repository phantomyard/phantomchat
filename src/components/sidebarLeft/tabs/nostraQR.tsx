/*
 * Nostra.chat — My QR Code sub-tab
 *
 * Thin SliderSuperTab wrapper that imperatively mounts the
 * <KeyExchange /> Solid component into its scrollable container
 * and disposes it on tab close.
 */

import {SliderSuperTab} from '@components/slider';
import {render} from 'solid-js/web';
import KeyExchange from '@components/nostra/KeyExchange';
import useNostraIdentity from '@stores/nostraIdentity';
import rootScope from '@lib/rootScope';
import {loadEncryptedIdentity, loadBrowserKey, decryptKeys} from '@lib/nostra/key-storage';
import {importFromMnemonic} from '@lib/nostra/nostr-identity';

export default class AppNostraQRTab extends SliderSuperTab {
  private dispose?: () => void;

  public init() {
    this.container.classList.add('nostra-qr-tab');
    this.setTitle('My QR Code' as any);

    const mountPoint = document.createElement('div');
    this.scrollable.append(mountPoint);

    // The nostraIdentity signal can be null when reached via the hamburger
    // menu without first opening Edit Profile (boot-time dispatch races with
    // the store module load in dev). Seed it from local storage before
    // mounting so KeyExchange renders the QR immediately.
    void this.ensureNpubLoaded();

    this.dispose = render(() => <KeyExchange />, mountPoint);
  }

  private async ensureNpubLoaded() {
    if(useNostraIdentity().npub()) return;
    try {
      const record = await loadEncryptedIdentity();
      if(!record) return;
      const browserKey = await loadBrowserKey();
      if(!browserKey) return;
      const {seed} = await decryptKeys(record.iv, record.encryptedKeys, browserKey);
      const id = importFromMnemonic(seed);
      rootScope.dispatchEvent('nostra_identity_loaded', {
        npub: id.npub,
        displayName: record.displayName || null,
        nip05: undefined,
        protectionType: 'none'
      });
    } catch(err) {
      console.warn('[NostraQRTab] failed to load identity:', err);
    }
  }

  protected onCloseAfterTimeout() {
    if(this.dispose) {
      this.dispose();
      this.dispose = undefined;
    }
    return super.onCloseAfterTimeout();
  }
}
