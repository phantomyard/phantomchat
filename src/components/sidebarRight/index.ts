/*
 * https://github.com/morethanwords/tweb
 * Copyright (C) 2019-2021 Eduard Kuzmenko
 * https://github.com/morethanwords/tweb/blob/master/LICENSE
 */

import appImManager, {APP_TABS} from '@lib/appImManager';
import SidebarSlider, {SliderSuperTab} from '@components/slider';
import {
  isInsidePeerEditorPane,
  isPeerEditorPaneContainer,
  isPeerEditorToggleEntryPoint,
  PeerEditorPaneTab,
  peerEditorPanePeerId,
  shouldDismissPeerEditorOnPointerDown
} from '@lib/phantomchat/peer-editor-dismiss';
import mediaSizes, {ScreenSize} from '@helpers/mediaSizes';
import AppSharedMediaTab from '@components/sidebarRight/tabs/sharedMedia';
import {MOUNT_CLASS_TO} from '@config/debug';
import {AppManagers} from '@lib/managers';
import appNavigationController from '@components/appNavigationController';
import rootScope from '@lib/rootScope';


export const RIGHT_COLUMN_ACTIVE_CLASSNAME = 'is-right-column-shown';

export class AppSidebarRight extends SidebarSlider {
  private isColumnProportionSet = false;
  public sharedMediaTab: AppSharedMediaTab;
  // public rect: DOMRect;

  constructor() {
    super({
      sidebarEl: document.getElementById('column-right') as HTMLElement,
      canHideFirst: true,
      navigationType: 'right'
    });
  }

  construct(managers: AppManagers) {
    this.managers = managers;

    mediaSizes.addEventListener('changeScreen', (from, to) => {
      if(to === ScreenSize.medium && from !== ScreenSize.mobile) {
        this.toggleSidebar(false);
      }
    });

    let removeTransitionTimeoutId: number;
    const toggleBgScalableTransition = (value: boolean) => {
      document.querySelectorAll('.chat-background-item-scalable').forEach((_el) => {
        const el = _el as HTMLElement;
        if(!value) {
          el.style.setProperty('transition', 'none', 'important');
        } else {
          el.style.removeProperty('transition');
        }
      });
    }
    rootScope.addEventListener('resizing_left_sidebar', () => {
      window.clearTimeout(removeTransitionTimeoutId);
      toggleBgScalableTransition(false);
      this.setColumnProportion();
      removeTransitionTimeoutId = window.setTimeout(() => {
        toggleBgScalableTransition(true);
      }, 100);
    });
    mediaSizes.addEventListener('resize', () => {
      this.setColumnProportion();
    });

    // The editor pane (1:1 contact, group, session) closes on any click that
    // is not its own: another chat, another sidebar tab, a menu, the prompt
    // bar. Capture phase, so the pane is gone before the click's own handler
    // runs and the new chat is what the user sees next. Registered once, for
    // the life of the singleton: the rule is a no-op while no editor pane is
    // on screen.
    document.addEventListener('pointerdown', this.onOutsidePointerDown, true);
  }

  /**
   * The editor pane showing right now, if any. Only the LAST history entry can
   * be on screen; an editor tab below it is a hidden leftover.
   */
  private getPeerEditorPaneTab(): (SliderSuperTab & PeerEditorPaneTab) | undefined {
    const history = this.getHistory();
    const last = history[history.length - 1];
    if(!last || typeof last !== 'object') return undefined;

    const tab = last as SliderSuperTab & PeerEditorPaneTab;
    return isPeerEditorPaneContainer(tab.container) ? tab : undefined;
  }

  private onOutsidePointerDown = (e: PointerEvent) => {
    const tab = this.getPeerEditorPaneTab();
    if(!tab) return;

    const panePeerId = peerEditorPanePeerId(tab);
    const target = e.target instanceof Element ? e.target : null;
    const dismiss = shouldDismissPeerEditorOnPointerDown({
      isInsidePane: isInsidePeerEditorPane(target),
      isToggleEntryPoint: isPeerEditorToggleEntryPoint(target, panePeerId)
    });
    if(!dismiss) return;

    // Same path as the pane's own X: closeTab pops the tab and
    // `onCloseTab` hides the column once the history is empty.
    this.closeTab(tab);
  };

  public createSharedMediaTab() {
    const tab = this.createTab(AppSharedMediaTab, false, true);
    tab.slider = this;
    // this.tabsContainer.prepend(tab.container);
    return tab;
  }

  public replaceSharedMediaTab(tab?: AppSharedMediaTab) {
    const previousTab = this.sharedMediaTab;
    // [PhantomChat.chat] FIND-3786a35f obs (A): when a group history_append fires
    // twice (the two-dispatch rule in phantomchat-groups-sync) while the sidebar
    // tab is still mid-initialization, `previousTab.container` may be
    // undefined and tweb throws an unhandled rejection. Guard the early
    // .container accesses so a partially-constructed tab is treated as a
    // no-op rather than crashing the page.
    if(previousTab && previousTab.container) {
      const idx = this.historyTabIds.indexOf(previousTab);

      if(this._selectTab.getFrom() === previousTab.container) {
        this._selectTab.setFrom(tab?.container);
      }

      if(tab) {
        if(idx !== -1) {
          this.historyTabIds[idx] = tab;
        }

        const wasActive = previousTab.container.classList.contains('active');
        if(wasActive) {
          tab.container.classList.add('active');
        }

        previousTab.container.replaceWith(tab.container);
      } else {
        if(idx !== -1) {
          this.historyTabIds.splice(idx, 1);
        }

        previousTab.container.remove();
      }
    } else if(tab) {
      // [PhantomChat.chat] FIND-3786a35f obs (B): the reset-peer path
      // (chat.ts:1093) calls replaceSharedMediaTab() with NO tab during
      // deletion teardown (dropDialogOnDeletion → flushHistory → setPeer).
      // If there's also no usable previousTab, the old code blindly did
      // `tab.container` and threw, aborting deletion teardown partway —
      // which left group tombstone/mirror cleanup incomplete and let
      // deleted groups resurrect. Treat "no previous tab AND no new tab"
      // as a no-op instead of crashing.
      this.tabsContainer.prepend(tab.container);
    }

    this.sharedMediaTab = tab;
  }

  public onCloseTab(id: number, animate: boolean, isNavigation?: boolean) {
    if(!this.historyTabIds.length) {
      this.toggleSidebar(false, animate);
    }

    super.onCloseTab(id, animate, isNavigation);
  }

  private setColumnProportion() {
    const middleWidth = this.sidebarEl.previousElementSibling.scrollWidth;
    const proportion = this.sidebarEl.scrollWidth / middleWidth;
    document.documentElement.style.setProperty('--right-column-proportion', '' + proportion);
    document.documentElement.style.setProperty('--middle-column-width', middleWidth + 'px');
    document.documentElement.style.setProperty('--middle-column-width-value', '' + middleWidth);
    // this.rect = this.sidebarEl.getBoundingClientRect();

    return proportion;
  }

  public hide() {
    document.body.classList.remove(RIGHT_COLUMN_ACTIVE_CLASSNAME);
    appNavigationController.removeByType('right');
    rootScope.dispatchEventSingle('right_sidebar_toggle', false);
  }

  public toggleSidebar(enable?: boolean, animate?: boolean) {
    const active = document.body.classList.contains(RIGHT_COLUMN_ACTIVE_CLASSNAME);
    let willChange: boolean;
    if(enable !== undefined) {
      if(enable) {
        if(!active) {
          willChange = true;
        }
      } else if(active) {
        willChange = true;
      }
    } else {
      willChange = true;
    }

    if(!willChange) return Promise.resolve();

    if(!active && !this.historyTabIds.length) {
      this.sharedMediaTab.open();
    }

    if(!this.isColumnProportionSet) {
      this.setColumnProportion();
      this.isColumnProportionSet = true;
    }

    const animationPromise = appImManager.selectTab(active ? APP_TABS.CHAT : APP_TABS.PROFILE, animate);
    if(!enable) this.hide();
    else {
      document.body.classList.add(RIGHT_COLUMN_ACTIVE_CLASSNAME);
      if(!appNavigationController.findItemByType('right')) {
        this.pushNavigationItem(this.sharedMediaTab);
      }
      rootScope.dispatchEventSingle('right_sidebar_toggle', true);
    }
    return animationPromise;

    /* return new Promise((resolve, reject) => {
      const hidden: {element: HTMLDivElement, height: number}[] = [];
      const observer = new IntersectionObserver((entries) => {
        for(const entry of entries) {
          const bubble = entry.target as HTMLDivElement;
          if(!entry.isIntersecting) {
            hidden.push({element: bubble, height: bubble.scrollHeight});
          }
        }

        for(const item of hidden) {
          item.element.style.minHeight = item.height + 'px';
          (item.element.firstElementChild as HTMLElement).style.display = 'none';
          item.element.style.width = '1px';
        }

        //console.log('hidden', hidden);
        observer.disconnect();

        set();

        setTimeout(() => {
          for(const item of hidden) {
            item.element.style.minHeight = '';
            item.element.style.width = '';
            (item.element.firstElementChild as HTMLElement).style.display = '';
          }

          resolve();
        }, 200);
      });

      const length = Object.keys(appImManager.bubbles).length;
      if(length) {
        for(const i in appImManager.bubbles) {
          observer.observe(appImManager.bubbles[i]);
        }
      } else {
        set();
        setTimeout(resolve, 200);
      }
    }); */
  }
}

const appSidebarRight = new AppSidebarRight();
MOUNT_CLASS_TO.appSidebarRight = appSidebarRight;
export default appSidebarRight;
