/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import type SidebarSlider from '@components/slider';
import {SliderSuperTab} from '@components/slider';
import AppSelectPeers from '@components/appSelectPeers';
import {setButtonLoader} from '@components/putPreloader';
import {LangPackKey, _i18n} from '@lib/langPack';
import ButtonCorner from '@components/buttonCorner';
import AppNewGroupTab from '@components/sidebarLeft/tabs/newGroup';
import {attachClickEvent} from '@helpers/dom/clickEvent';
// providedTabs registered lazily at bottom to avoid circular import

export default class AppAddMembersTab extends SliderSuperTab {
  public static noSame = true;
  private nextBtn: HTMLButtonElement;
  private selector: AppSelectPeers;
  private peerType: 'channel' | 'chat' | 'privacy';
  private takeOut: (peerIds: PeerId[]) => Promise<any> | false | void;
  private skippable: boolean;

  public init(options: {
    title: LangPackKey,
    placeholder: LangPackKey,
    type: AppAddMembersTab['peerType'],
    takeOut?: AppAddMembersTab['takeOut'],
    skippable: boolean,
    selectedPeerIds?: PeerId[],
    /** Back arrow also applies the selection (takeOut) instead of discarding. */
    takeOutOnClose?: boolean
  }) {
    this.container.classList.add('add-members-container');
    this.nextBtn = ButtonCorner({icon: 'arrow_next'});
    this.content.append(this.nextBtn);
    this.scrollable.container.remove();

    this.nextBtn.addEventListener('click', () => {
      const peerIds = this.selector.getSelected().map((sel) => sel.toPeerId());
      const result = this.takeOut(peerIds);

      if(this.skippable && !(result instanceof Promise)) {
        this.close();
      } else if(result instanceof Promise) {
        this.attachToPromise(result);
      } else if(result === undefined) {
        this.close();
      }
    });

    //
    this.setTitle(options.title);
    this.peerType = options.type;
    this.takeOut = options.takeOut;
    this.skippable = options.skippable;

    const isPrivacy = this.peerType === 'privacy';
    this.selector = new AppSelectPeers({
      middleware: this.middlewareHelper.get(),
      appendTo: this.content,
      onChange: this.skippable ? null : (length) => {
        this.nextBtn.classList.toggle('is-visible', !!length);
      },
      peerType: [isPrivacy ? 'dialogs' : 'contacts'],
      placeholder: options.placeholder,
      exceptSelf: isPrivacy,
      filterPeerTypeBy: isPrivacy ? ['isAnyGroup', 'isUser'] : undefined,
      managers: this.managers,
      design: 'square'
    });

    if(options.selectedPeerIds) {
      this.selector.addInitial(options.selectedPeerIds);
    }

    this.nextBtn.disabled = false;
    this.nextBtn.classList.toggle('is-visible', this.skippable);

    // The back arrow must behave like the apply arrow: commit the selection
    // diff, then leave. Discarding silently made users think their change
    // was lost (no Save was ever shown for it).
    if(options.takeOutOnClose) {
      // Drop the slider's default close handler by replacing the node, then
      // wire our own apply-then-close.
      const newCloseBtn = this.closeBtn.cloneNode(true) as HTMLElement;
      this.closeBtn.replaceWith(newCloseBtn);
      this.closeBtn = newCloseBtn;
      attachClickEvent(this.closeBtn, () => {
        const peerIds = this.selector.getSelected().map((sel) => sel.toPeerId());
        const result = this.takeOut(peerIds);
        if(result instanceof Promise) {
          this.attachToPromise(result);
        } else {
          this.close();
        }
      }, {listenerSetter: this.listenerSetter});
    }
  }

  public attachToPromise(promise: Promise<any>) {
    const removeLoader = setButtonLoader(this.nextBtn, 'arrow_next');

    promise.then(() => {
      this.close();
    }, () => {
      removeLoader();
      // On rejection still close: the takeOut caller toasts the error, and
      // the tab's default back handler has been cloned away when
      // takeOutOnClose is set — staying open would leave the user in a
      // picker with no working way out.
      this.close();
    });
  }

  public static createNewGroupTab(slider: SidebarSlider) {
    slider.createTab(AppAddMembersTab).open({
      type: 'chat',
      skippable: true,
      takeOut: (peerIds) => slider.createTab(AppNewGroupTab).open({peerIds}),
      title: 'GroupAddMembers',
      placeholder: 'SendMessageTo'
    });
  }
}

// Register lazily to avoid circular import with solidJsTabs
import('@components/solidJsTabs').then(({providedTabs}) => {
  providedTabs.AppAddMembersTab = AppAddMembersTab;
});
