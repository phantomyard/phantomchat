/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import {SliderSuperTab} from '@components/slider';
import EditPeer from '@components/editPeer';
import {i18n, i18n_, LangPackKey} from '@lib/langPack';
import {attachClickEvent} from '@helpers/dom/clickEvent';
import rootScope from '@lib/rootScope';
import {copyTextToClipboard} from '@helpers/clipboard';
import setBlankToAnchor from '@lib/richTextProcessor/setBlankToAnchor';
import SettingSection, {generateSection} from '@components/settingSection';
import Row from '@components/row';
import {getHeavyAnimationPromise} from '@hooks/useHeavyAnimationCheck';
import placeCaretAtEnd from '@helpers/dom/placeCaretAtEnd';
import shake from '@helpers/dom/shake';
import usePhantomChatIdentity from '@stores/phantomchatIdentity';
import {toast} from '@components/toast';
import {publishKind0Metadata} from '@lib/phantomchat/nostr-relay';
import {uploadToBlossom} from '@lib/phantomchat/blossom-upload';
import {saveOwnProfileLocal} from '@lib/phantomchat/own-profile-sync';
import {resolveOwnProfilePicture} from '@lib/phantomchat/profile-cache';
import {npubEncode} from '@lib/phantomchat/nostr-identity';
import {bytesToHex} from '@lib/phantomchat/file-crypto';
import {createBasicInfoSection, type BasicInfoSection} from './basic-info-section';
import {createNip05Section, type Nip05Section} from './nip05-section';

/** @deprecated Kept for external consumers (chatType, editBot) */
export function purchaseUsernameCaption() {
  const p = document.createElement('div');
  const FRAGMENT_USERNAME_URL = 'https://fragment.com/username/';
  const a = setBlankToAnchor(document.createElement('a'));
  const purchaseText = i18n('Username.Purchase', [a]);
  purchaseText.classList.add('username-purchase-help');
  p.append(
    purchaseText,
    document.createElement('br'),
    document.createElement('br')
  );
  p.classList.add('hide');

  return {
    element: p,
    setUsername: (username: string) => {
      if(username) {
        a.href = FRAGMENT_USERNAME_URL + username;
      }

      p.classList.toggle('hide', !username);
    }
  };
}

export default class AppEditProfileTab extends SliderSuperTab {
  public static noSame = true;

  private basicInfo: BasicInfoSection;
  private nip05Section: Nip05Section | null = null;
  private editPeer: EditPeer;

  public static getInitArgs() {
    // In PhantomChat mode getSelf() / getProfile() may hang (no MTProto auth).
    // Wrap each promise with a 500ms timeout so the UI renders regardless.
    const withTimeout = <T>(p: Promise<T>, ms = 500, fallback: T): Promise<T> =>
      Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

    return {
      bioMaxLength: 255,
      userFull: withTimeout(
        rootScope.managers.appProfileManager.getProfile(rootScope.myId.toUserId()),
        500,
        {about: ''} as any
      )
    };
  }

  public async init(p: ReturnType<typeof AppEditProfileTab['getInitArgs']> = AppEditProfileTab.getInitArgs(), focusOn?: string) {
    this.container.classList.add('edit-profile-container');
    this.setTitle('EditAccount.Title');

    const [bioMaxLength, userFull] = await Promise.all([p.bioMaxLength, p.userFull]);

    // --- Basic Info section (name / bio / website / lud16) ---
    this.basicInfo = createBasicInfoSection({bioMaxLength});

    const section = generateSection(this.scrollable, undefined, 'Bio.Description');
    this.editPeer = new EditPeer({
      peerId: rootScope.myId,
      inputFields: this.basicInfo.inputFields,
      listenerSetter: this.listenerSetter,
      middleware: this.middlewareHelper.get()
    });
    this.content.append(this.editPeer.nextBtn);
    section.append(this.editPeer.avatarEdit.container, this.basicInfo.inputWrapper);

    // --- Nostr Identity section (Public Key + NIP-05) ---
    const npubValue = await this.ensureNpubLoaded();

    if(npubValue) {
      this.scrollable.append(this.buildPubkeySection(npubValue));

      const identity = usePhantomChatIdentity();
      this.nip05Section = createNip05Section({
        npub: npubValue,
        initialAlias: identity.nip05() || '',
        listenerSetter: this.listenerSetter
      });
      this.scrollable.append(this.nip05Section.container);
    }

    // --- Save handler (avatar → cache → publish kind 0) ---
    attachClickEvent(this.editPeer.nextBtn, async() => {
      this.editPeer.nextBtn.disabled = true;
      try {
        await this.save(npubValue);
      } finally {
        this.editPeer.nextBtn.removeAttribute('disabled');
      }
    }, {listenerSetter: this.listenerSetter});

    // --- Populate initial values from the identity store ---
    const identity = usePhantomChatIdentity();
    this.basicInfo.setInitialValues({
      displayName: identity.displayName() || '',
      bio: identity.about() || userFull?.about || '',
      website: identity.website() || '',
      lud16: identity.lud16() || ''
    });

    this.editPeer.handleChange();
  }

  public focus(on: string) {
    getHeavyAnimationPromise().then(() => {
      const field = this.basicInfo?.fieldsByName[on];
      if(field) {
        placeCaretAtEnd(field.input);
      } else if(on === 'set-photo') {
        shake(this.editPeer.avatarElem.node);
      }
    });
  }

  /**
   * Load the npub from the store, falling back to the live pubkey onboarding
   * sets (`window.__phantomchatOwnPubkey`). The encrypted-identity store is
   * only readable with the browser key, so pin/biometric and imported
   * identities can't be re-derived here — and re-deriving used to re-dispatch
   * `phantomchat_identity_loaded` WITHOUT the cached picture, wiping it.
   */
  private async ensureNpubLoaded(): Promise<string> {
    const identity = usePhantomChatIdentity();
    const known = identity.npub();
    if(known) return known;

    const ownPubkey = (window as any).__phantomchatOwnPubkey as string | undefined;
    if(!ownPubkey) return '';

    try {
      return npubEncode(ownPubkey);
    } catch(err) {
      console.warn('[EditProfile] failed to encode own pubkey:', err);
      return '';
    }
  }

  /** Render the read-only public-key section with copy-to-clipboard row. */
  private buildPubkeySection(npubValue: string): HTMLElement {
    const pubkeySection = new SettingSection({name: 'Public Key' as any});
    const npubRow = new Row({
      title: npubValue,
      subtitle: 'Your Nostr public key (npub)',
      icon: 'copy',
      clickable: () => {
        // copyTextToClipboard has an execCommand fallback — a raw
        // navigator.clipboard.writeText() rejects hard when the Electron
        // permission layer denies clipboard-sanitized-write (issue #215).
        copyTextToClipboard(npubValue).then(() => toast('Copied to clipboard'));
      },
      listenerSetter: this.listenerSetter
    });
    npubRow.title.classList.add('npub-wordbreak');
    pubkeySection.content.append(npubRow.container);
    return pubkeySection.container;
  }

  /** Upload the avatar (if changed), persist locally, and publish kind 0. */
  private async save(npubValue: string): Promise<void> {
    const {displayName, bio, website, lud16} = this.basicInfo.getValues();

    const uploadedPicture = await this.maybeUploadAvatar();
    if(uploadedPicture) this.editPeer.lastAvatarBlob = null;
    // A save WITHOUT a freshly picked file must keep the stored picture
    // (see resolveOwnProfilePicture).
    const picture = resolveOwnProfilePicture(uploadedPicture, usePhantomChatIdentity().picture());

    const nowSec = Math.floor(Date.now() / 1000);
    const existingNip05 = usePhantomChatIdentity().nip05() || undefined;

    saveOwnProfileLocal({
      name: displayName,
      display_name: displayName,
      about: bio,
      ...(picture ? {picture} : {}),
      website: website || undefined,
      lud16: lud16 || undefined,
      nip05: existingNip05
    }, nowSec);

    if(npubValue) {
      await publishKind0Metadata({
        name: displayName,
        display_name: displayName,
        about: bio,
        nip05: existingNip05,
        ...(picture ? {picture} : {}),
        website: website || undefined,
        lud16: lud16 || undefined
      }).catch((err) => {
        console.error('[EditProfile] kind 0 publish failed:', err);
        toast('Profile saved locally but relay publish failed');
      });
    }

    this.close();
  }

  /** If the user picked a new avatar, upload it to Blossom with the LIVE key. */
  private async maybeUploadAvatar(): Promise<string | undefined> {
    if(!this.editPeer.lastAvatarBlob) return undefined;
    try {
      // The chat API's relay pool holds the key the session actually signs
      // with. Re-deriving it via loadEncryptedIdentity()+loadBrowserKey()
      // fails for pin/biometric and imported identities (no browser key),
      // which silently discarded every avatar those users picked.
      const privateKey = (window as any).__phantomchatChatAPI?.relayPool?.getPrivateKey?.() as
        Uint8Array | null | undefined;
      if(!privateKey || privateKey.length !== 32) throw new Error('no live identity key');
      const {url} = await uploadToBlossom(this.editPeer.lastAvatarBlob, bytesToHex(privateKey));
      return url;
    } catch(err) {
      console.error('[EditProfile] blossom upload failed:', err);
      toast('Avatar upload failed — saved without new avatar');
      return undefined;
    }
  }
}
